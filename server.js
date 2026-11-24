const express = require('express');
const { MeetBot, performGoogleLogin } = require('./bot');

const app = express();
app.use(express.json({ limit: '50mb' }));
let loginSession = null;

// Buffer de logs em memória para depuração remota
const systemLogs = [];
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function addLog(level, args) {
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const time = new Date().toISOString();
  systemLogs.push(`[${time}] [${level}] ${msg}`);
  if (systemLogs.length > 300) systemLogs.shift();
}

console.log = (...args) => {
  originalLog(...args);
  addLog('INFO', args);
};

console.error = (...args) => {
  originalError(...args);
  addLog('ERROR', args);
};

console.warn = (...args) => {
  originalWarn(...args);
  addLog('WARN', args);
};

let currentBot = null;

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'kognite-meet-bot',
    active_session: Boolean(currentBot && currentBot.isRunning),
    timestamp: new Date().toISOString()
  });
});

app.get('/logs', (req, res) => {
  res.json({
    count: systemLogs.length,
    logs: systemLogs
  });
});

app.get('/screenshot', async (req, res) => {
  if (currentBot && currentBot.page && !currentBot.page.isClosed()) {
    try {
      const buffer = await currentBot.page.screenshot({ type: 'png' });
      res.contentType('image/png');
      return res.send(buffer);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }
  res.status(404).json({ error: 'Nenhuma página do bot aberta no momento.' });
});

app.get('/status', (req, res) => {
  if (!currentBot || !currentBot.isRunning) {
    return res.json({
      active: false,
      message: 'Nenhuma gravação em andamento.',
      lastLogs: systemLogs.slice(-10)
    });
  }

  const durationSeconds = Math.round((new Date() - currentBot.startTime) / 1000);
  res.json({
    active: true,
    title: currentBot.title,
    meeting_url: currentBot.meetingUrl,
    duration_seconds: durationSeconds,
    duration_minutes: Math.round(durationSeconds / 60),
    speakers: Array.from(currentBot.speakersSet),
    transcript_count: currentBot.transcriptEntries.length
  });
});

app.post('/join', async (req, res) => {
  const { meetingUrl, url, title, botName, webhookUrl } = req.body;
  const targetUrl = meetingUrl || url;

  if (!targetUrl || !targetUrl.includes('meet.google.com')) {
    return res.status(400).json({
      error: 'É necessário fornecer um link válido do Google Meet (ex: https://meet.google.com/abc-defg-hij).'
    });
  }

  if (currentBot && currentBot.isRunning) {
    return res.status(409).json({
      error: 'Já existe uma gravação de reunião em andamento.',
      current_meeting: currentBot.title,
      url: currentBot.meetingUrl
    });
  }

  console.log(`[Server] Recebida solicitação de entrada na reunião: ${targetUrl}`);

  const bot = new MeetBot({
    meetingUrl: targetUrl,
    title: title || 'Reunião Kognite',
    botName: botName || 'Kognite Bot',
    webhookUrl: webhookUrl || process.env.N8N_WEBHOOK_URL || 'https://n8n.kognite.io/webhook/meet-recording-finished'
  });

  currentBot = bot;

  // Iniciar em background para responder à API imediatamente
  bot.start().catch(err => {
    console.error('[Server] Erro fatal na execução do bot:', err.message, err.stack);
  });

  res.json({
    success: true,
    message: `Bot "${bot.botName}" acionado para entrar no Google Meet!`,
    meetingUrl: targetUrl,
    title: bot.title
  });
});

app.post('/stop', async (req, res) => {
  if (!currentBot || !currentBot.isRunning) {
    return res.json({ message: 'Nenhuma reunião ativa para encerrar.' });
  }

  const title = currentBot.title;
  await currentBot.stop();
  currentBot = null;

  res.json({
    success: true,
    message: `Gravação da reunião "${title}" finalizada com sucesso!`
  });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Informe email e password.' });
  }
  try {
    if (loginSession && loginSession.browser) {
      await loginSession.browser.close().catch(() => {});
    }
    loginSession = await performGoogleLogin(email, password);
    res.json({
      success: true,
      url: loginSession.page.url(),
      message: 'Login iniciado. Verifique /login/screenshot se precisar confirmar 2FA ou telefone.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/login/screenshot', async (req, res) => {
  if (loginSession && loginSession.page && !loginSession.page.isClosed()) {
    const buffer = await loginSession.page.screenshot({ type: 'png' });
    res.contentType('image/png');
    return res.send(buffer);
  }
  res.status(404).json({ error: 'Nenhuma sessão de login ativa.' });
});

app.post('/login/save', async (req, res) => {
  if (loginSession && loginSession.context) {
    await loginSession.context.storageState({ path: loginSession.statePath });
    const url = loginSession.page.url();
    await loginSession.browser.close().catch(() => {});
    loginSession = null;
    return res.json({ success: true, message: 'Sessão salva com sucesso!', url });
  }
  res.status(404).json({ error: 'Nenhuma sessão de login ativa.' });
});

const PORT = process.env.PORT || 3005;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`===============================================`);
  console.log(`🚀 Kognite Meet Bot rodando na porta ${PORT}`);
  console.log(`• Webhook n8n: ${process.env.N8N_WEBHOOK_URL || 'https://n8n.kognite.io/webhook/meet-recording-finished'}`);
  console.log(`===============================================`);
});

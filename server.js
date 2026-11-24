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
    
    // Iniciar login em background para responder imediatamente
    performGoogleLogin(email, password, (sessionObj) => {
      loginSession = sessionObj;
    }).catch(err => {
      console.error('[Server] Erro no login Google:', err.message);
    });

    res.json({
      success: true,
      message: 'Login iniciado em background. Acompanhe via /logs e /login/screenshot.'
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

app.post('/cookies', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const cookies = req.body.cookies || req.body;
  if (!Array.isArray(cookies)) {
    return res.status(400).json({ error: 'Envie um array JSON de cookies válido.' });
  }
  const filePath = path.join(__dirname, 'cookies.json');
  fs.writeFileSync(filePath, JSON.stringify(cookies, null, 2));
  console.log(`[Server] ${cookies.length} cookies salvos diretamente em cookies.json!`);
  res.json({ success: true, count: cookies.length, message: 'Cookies atualizados com sucesso!' });
});

const { spawn, execSync } = require('child_process');
let setupProcesses = [];

app.all('/setup-login', (req, res) => {
  try {
    // Limpar processos anteriores se existirem
    setupProcesses.forEach(p => { try { p.kill('SIGKILL'); } catch (e) {} });
    setupProcesses = [];
    try { execSync('pkill -f "Xvfb :99" || true; pkill -f x11vnc || true; pkill -f websockify || true; pkill -f "/app/chrome-profile" || true'); } catch (e) {}

    const xvfb = spawn('Xvfb', [':99', '-screen', '0', '1280x720x24'], { stdio: 'ignore' });
    const vnc = spawn('x11vnc', ['-display', ':99', '-forever', '-nopw', '-rfbport', '5900', '-shared'], { stdio: 'ignore' });
    const novnc = spawn('websockify', ['--web=/usr/share/novnc', '6080', 'localhost:5900'], { stdio: 'ignore' });
    
    setTimeout(() => {
      const chrome = spawn('/opt/google/chrome/chrome', [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--user-data-dir=/app/chrome-profile',
        '--window-size=1280,720',
        '--window-position=0,0',
        'https://accounts.google.com/ServiceLogin?continue=https://meet.google.com/'
      ], {
        env: { ...process.env, DISPLAY: ':99' },
        stdio: 'ignore'
      });
      setupProcesses.push(chrome);
    }, 1500);

    setupProcesses.push(xvfb, vnc, novnc);
    console.log('[Server] Navegador visual (noVNC) iniciado na porta 6080 para login único!');
    res.json({
      success: true,
      url: 'http://179.66.138.137:6080/vnc.html?autoconnect=true',
      message: 'Acesse a URL acima no seu navegador para fazer login no Google Chrome real da VPS.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.all('/stop-login', (req, res) => {
  setupProcesses.forEach(p => { try { p.kill('SIGTERM'); } catch (e) {} });
  setupProcesses = [];
  try { execSync('pkill -f "/app/chrome-profile" || true; pkill -f websockify || true; pkill -f x11vnc || true; pkill -f "Xvfb :99" || true'); } catch (e) {}
  console.log('[Server] Sessão visual de login encerrada. Perfil salvo em /app/chrome-profile!');
  res.json({ success: true, message: 'Sessão de login encerrada e perfil persistente pronto para uso!' });
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

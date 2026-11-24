const express = require('express');
const { MeetBot } = require('./bot');

const app = express();
app.use(express.json({ limit: '50mb' }));

let currentBot = null;

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'kognite-meet-bot',
    active_session: Boolean(currentBot && currentBot.isRunning),
    timestamp: new Date().toISOString()
  });
});

app.get('/status', (req, res) => {
  if (!currentBot || !currentBot.isRunning) {
    return res.json({ active: false, message: 'Nenhuma gravação em andamento.' });
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

  const bot = new MeetBot({
    meetingUrl: targetUrl,
    title: title || 'Reunião Kognite',
    botName: botName || 'Thiago | Kognite AI',
    webhookUrl: webhookUrl || process.env.N8N_WEBHOOK_URL || 'https://n8n.kognite.io/webhook/meet-recording-finished'
  });

  currentBot = bot;

  // Iniciar em background para responder à API imediatamente
  bot.start().catch(err => {
    console.error('[Server] Erro na execução do bot:', err);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`===============================================`);
  console.log(`🚀 Kognite Meet Bot rodando na porta ${PORT}`);
  console.log(`• Webhook n8n padrão: ${process.env.N8N_WEBHOOK_URL || 'https://n8n.kognite.io/webhook/meet-recording-finished'}`);
  console.log(`===============================================`);
});

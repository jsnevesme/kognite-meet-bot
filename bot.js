const { chromium } = require('playwright');
const axios = require('axios');
const FormData = require('form-data');

class MeetBot {
  constructor(options = {}) {
    this.meetingUrl = options.meetingUrl;
    this.title = options.title || 'Reunião Kognite';
    this.botName = options.botName || 'Thiago | Kognite AI';
    this.webhookUrl = options.webhookUrl || process.env.N8N_WEBHOOK_URL || 'https://n8n.kognite.io/webhook/meet-recording-finished';
    this.browser = null;
    this.context = null;
    this.page = null;
    this.transcriptEntries = [];
    this.speakersSet = new Set();
    this.startTime = null;
    this.endTime = null;
    this.isRunning = false;
    this.isStopping = false;
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.startTime = new Date();

    console.log(`[MeetBot] Iniciando bot "${this.botName}" para a reunião: ${this.meetingUrl}`);

    try {
      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          '--autoplay-policy=no-user-gesture-required',
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ]
      });

      this.context = await this.browser.newContext({
        permissions: ['microphone', 'camera'],
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 720 }
      });

      this.page = await this.context.newPage();

      // Expor função para capturar legendas em tempo real do DOM para o Node
      await this.page.exposeFunction('sendCaptionToNode', (speaker, text) => {
        if (!text || text.trim().length === 0) return;
        const cleanSpeaker = speaker || 'Participante';
        const now = new Date();
        const timeStr = now.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        
        this.speakersSet.add(cleanSpeaker);
        this.transcriptEntries.push({
          timestamp: timeStr,
          speaker: cleanSpeaker,
          text: text.trim()
        });
        console.log(`[MeetBot Transcrição] [${timeStr}] ${cleanSpeaker}: ${text.trim().substring(0, 60)}...`);
      });

      await this.page.goto(this.meetingUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      console.log(`[MeetBot] Página da chamada carregada.`);

      await this.page.waitForTimeout(3000);

      // Desativar microfone e câmera antes de entrar
      try {
        await this.page.keyboard.down('Control');
        await this.page.keyboard.press('d'); // Mute Mic
        await this.page.keyboard.press('e'); // Mute Cam
        await this.page.keyboard.up('Control');
        console.log(`[MeetBot] Microfone e câmera desativados por atalho.`);
      } catch (err) {
        console.warn(`[MeetBot] Erro ao enviar atalho de mic/cam:`, err.message);
      }

      // Preencher nome do bot se solicitado
      const nameInputSelectors = [
        'input[type="text"]',
        'input[aria-label*="nome" i]',
        'input[aria-label*="name" i]',
        'input[placeholder*="nome" i]'
      ];

      for (const sel of nameInputSelectors) {
        const input = await this.page.$(sel);
        if (input && await input.isVisible()) {
          await input.fill(this.botName);
          console.log(`[MeetBot] Nome preenchido no campo de entrada: ${this.botName}`);
          break;
        }
      }

      await this.page.waitForTimeout(1000);

      // Clicar no botão para entrar ou pedir para participar
      const joinSelectors = [
        'button:has-text("Pedir para participar")',
        'button:has-text("Participar agora")',
        'button:has-text("Ask to join")',
        'button:has-text("Join now")',
        'button[jsname="Qx7uuf"]',
        'button[jsname="CQylAd"]'
      ];

      let clickedJoin = false;
      for (const sel of joinSelectors) {
        try {
          const btn = await this.page.$(sel);
          if (btn && await btn.isVisible()) {
            await btn.click();
            console.log(`[MeetBot] Clicou no botão de entrada: ${sel}`);
            clickedJoin = true;
            break;
          }
        } catch (e) {}
      }

      if (!clickedJoin) {
        console.log(`[MeetBot] Tentando clicar no primeiro botão principal visível...`);
        try {
          await this.page.keyboard.press('Enter');
        } catch (e) {}
      }

      console.log(`[MeetBot] Aguardando admissão na sala...`);

      // Aguardar até estar dentro da sala (detectando a barra de controles inferior)
      await this.page.waitForSelector('button[aria-label*="chamada" i], button[aria-label*="call" i], div[jsname="E2E3Fd"]', {
        timeout: 120000
      });

      console.log(`[MeetBot] ADMITIDO NA SALA! Iniciando gravação de áudio e transcrição.`);

      // 1. Ativar legendas fechadas (Closed Captions)
      try {
        await this.page.keyboard.press('c');
        console.log(`[MeetBot] Tecla 'c' pressionada para ativar legendas.`);
      } catch (e) {}

      // 2. Injetar Capturador de Legendas DOM e Gravação de Áudio via MediaRecorder
      await this.page.evaluate(() => {
        // Observador de Legendas
        const observer = new MutationObserver(() => {
          // Seletores padrão do Google Meet para legendas
          const captionNodes = document.querySelectorAll('div[jscontroller="D1tHje"], div[jsname="YSxPsd"], .iTTPOb');
          captionNodes.forEach(node => {
            const speakerEl = node.querySelector('.zsMVvd, .jxFHg, [jsname="r4nke"]');
            const textEl = node.querySelector('.iTTPOb, [jsname="tgaKEf"]');
            const speaker = speakerEl ? speakerEl.innerText : 'Participante';
            const text = textEl ? textEl.innerText : (node.innerText || '');
            if (text && text.trim().length > 0) {
              window.sendCaptionToNode(speaker, text);
            }
          });
        });

        observer.observe(document.body, { childList: true, subtree: true });

        // Inicializar MediaRecorder capturando os elementos <audio> remotos
        try {
          const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          const destination = audioCtx.createMediaStreamDestination();

          const attachAudios = () => {
            document.querySelectorAll('audio').forEach(audio => {
              if (audio.srcObject && !audio._kogniteAttached) {
                audio._kogniteAttached = true;
                try {
                  const source = audioCtx.createMediaStreamSource(audio.srcObject);
                  source.connect(destination);
                } catch (e) {}
              }
            });
          };

          attachAudios();
          setInterval(attachAudios, 2000);

          window.kogniteAudioChunks = [];
          const recorder = new MediaRecorder(destination.stream, { mimeType: 'audio/webm' });
          recorder.ondataavailable = e => {
            if (e.data && e.data.size > 0) {
              window.kogniteAudioChunks.push(e.data);
            }
          };
          recorder.start(1000); // chunk a cada 1s
          window.kogniteRecorder = recorder;
          console.log('[Kognite In-Page] MediaRecorder iniciado.');
        } catch (err) {
          console.error('[Kognite In-Page] Erro ao iniciar áudio:', err);
        }
      });

      // Loop de monitoramento de saída da chamada
      this.monitorMeetingStatus();

    } catch (err) {
      console.error(`[MeetBot Erro]:`, err);
      await this.stop();
    }
  }

  async monitorMeetingStatus() {
    const checkInterval = setInterval(async () => {
      if (this.isStopping || !this.isRunning) {
        clearInterval(checkInterval);
        return;
      }

      try {
        if (!this.page || this.page.isClosed()) {
          clearInterval(checkInterval);
          await this.stop();
          return;
        }

        // Verificar se a chamada foi encerrada
        const isEnded = await this.page.evaluate(() => {
          const bodyText = document.body ? document.body.innerText : '';
          return (
            bodyText.includes('Você saiu da reunião') ||
            bodyText.includes('Você foi removido') ||
            bodyText.includes('A reunião terminou') ||
            bodyText.includes('You left the meeting') ||
            bodyText.includes('Meeting ended')
          );
        });

        if (isEnded) {
          console.log(`[MeetBot] Chamada encerrada pelos participantes ou pelo host.`);
          clearInterval(checkInterval);
          await this.stop();
        }
      } catch (e) {
        clearInterval(checkInterval);
        await this.stop();
      }
    }, 5000);
  }

  async stop() {
    if (this.isStopping) return;
    this.isStopping = true;
    this.endTime = new Date();

    console.log(`[MeetBot] Finalizando gravação da reunião: ${this.title}...`);

    let audioBase64 = null;

    try {
      if (this.page && !this.page.isClosed()) {
        audioBase64 = await this.page.evaluate(async () => {
          if (!window.kogniteRecorder) return null;
          return new Promise(resolve => {
            try {
              window.kogniteRecorder.onstop = async () => {
                const blob = new Blob(window.kogniteAudioChunks, { type: 'audio/webm' });
                const reader = new FileReader();
                reader.onloadend = () => {
                  resolve(reader.result ? reader.result.split(',')[1] : null);
                };
                reader.readAsDataURL(blob);
              };
              window.kogniteRecorder.stop();
            } catch (e) {
              resolve(null);
            }
          });
        });
      }
    } catch (err) {
      console.warn(`[MeetBot] Falha ao extrair buffer de áudio:`, err.message);
    }

    try {
      if (this.browser) {
        await this.browser.close();
      }
    } catch (e) {}

    this.isRunning = false;

    // Compilar transcrição
    const transcriptText = this.transcriptEntries
      .map(t => `[${t.timestamp}] ${t.speaker}: ${t.text}`)
      .join('\n');

    const durationSeconds = Math.round(((this.endTime - this.startTime) / 1000) || 0);
    const durationMinutes = Math.round(durationSeconds / 60);

    const payload = {
      title: this.title,
      meeting_url: this.meetingUrl,
      duration_seconds: durationSeconds,
      duration_minutes: durationMinutes,
      started_at: this.startTime ? this.startTime.toISOString() : new Date().toISOString(),
      ended_at: this.endTime ? this.endTime.toISOString() : new Date().toISOString(),
      speakers: Array.from(this.speakersSet),
      transcript: transcriptText || 'Transcrição não coletada ou chamada sem falas audíveis.',
      tem_audio: Boolean(audioBase64),
      audio_base64: audioBase64
    };

    console.log(`[MeetBot] Enviando dados para o n8n (${this.webhookUrl})...`);
    console.log(`• Falas registradas: ${this.transcriptEntries.length}`);
    console.log(`• Participantes: ${Array.from(this.speakersSet).join(', ') || 'Não identificados'}`);
    console.log(`• Duração: ${durationMinutes} min (${durationSeconds}s)`);

    try {
      const resp = await axios.post(this.webhookUrl, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 60000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });
      console.log(`[MeetBot] Dados enviados ao n8n com sucesso! Resposta:`, resp.status, resp.data);
    } catch (postErr) {
      console.error(`[MeetBot] Erro ao enviar webhook para o n8n:`, postErr.message);
    }

    console.log(`[MeetBot] Sessão encerrada.`);
  }
}

module.exports = { MeetBot };

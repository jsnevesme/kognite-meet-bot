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
    this.state = 'initialized'; // initialized, launching, navigating, joining, in_call, completed, failed
    this.lastError = null;
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.state = 'launching';
    this.startTime = new Date();

    console.log(`[MeetBot] >>> Iniciando bot "${this.botName}" para: ${this.meetingUrl}`);

    try {
      console.log(`[MeetBot] Passo 1: Lançando Chromium headless...`);
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

      console.log(`[MeetBot] Passo 2: Criando contexto do navegador com permissões de mídia...`);
      this.context = await this.browser.newContext({
        permissions: ['microphone', 'camera'],
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 720 },
        locale: 'pt-BR'
      });

      this.page = await this.context.newPage();

      // Ocultar sinalizadores de automação para evitar bloqueio do Google
      await this.page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {} };
      });

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
        console.log(`[MeetBot Legenda] [${timeStr}] ${cleanSpeaker}: ${text.trim().substring(0, 60)}...`);
      });

      this.state = 'navigating';
      console.log(`[MeetBot] Passo 3: Navegando para o link da chamada: ${this.meetingUrl}`);
      await this.page.goto(this.meetingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      console.log(`[MeetBot] Página carregada com sucesso! URL atual: ${this.page.url()}`);

      await this.page.waitForTimeout(3000);

      // Tratar possíveis popups de cookies ou permissões do Google
      try {
        const dismissSelectors = [
          'button:has-text("Recusar tudo")',
          'button:has-text("Aceitar tudo")',
          'button:has-text("Entendi")',
          'button:has-text("Concordo")',
          'button:has-text("Ignorar")',
          'button:has-text("Continuar sem microfone")',
          'button:has-text("Dismiss")',
          'button:has-text("Got it")'
        ];
        for (const sel of dismissSelectors) {
          const btn = await this.page.$(sel);
          if (btn && await btn.isVisible()) {
            await btn.click();
            console.log(`[MeetBot] Popup dispensado: ${sel}`);
            await this.page.waitForTimeout(1000);
          }
        }
      } catch (e) {
        console.warn(`[MeetBot] Aviso ao dispensar popups:`, e.message);
      }

      // Desativar microfone e câmera antes de entrar (por atalhos e cliques)
      try {
        await this.page.keyboard.down('Control');
        await this.page.keyboard.press('d'); // Mute Mic
        await this.page.keyboard.press('e'); // Mute Cam
        await this.page.keyboard.up('Control');
        console.log(`[MeetBot] Atalhos Ctrl+D e Ctrl+E enviados para silenciar mic e câmera.`);
      } catch (err) {
        console.warn(`[MeetBot] Erro ao enviar atalhos de mic/cam:`, err.message);
      }

      // Preencher nome do bot ("Thiago | Kognite AI")
      const nameInputSelectors = [
        'input[type="text"]',
        'input[aria-label*="nome" i]',
        'input[aria-label*="name" i]',
        'input[placeholder*="nome" i]',
        'input[placeholder*="name" i]'
      ];

      let nameFilled = false;
      for (const sel of nameInputSelectors) {
        try {
          const input = await this.page.$(sel);
          if (input && await input.isVisible()) {
            await input.fill(this.botName);
            console.log(`[MeetBot] Nome preenchido com sucesso: "${this.botName}"`);
            nameFilled = true;
            break;
          }
        } catch (e) {}
      }

      if (!nameFilled) {
        console.log(`[MeetBot] Campo de nome não encontrado explicitamente (pode já estar preenchido ou logado).`);
      }

      await this.page.waitForTimeout(1500);

      // Clicar no botão para entrar ou pedir para participar
      this.state = 'joining';
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
        console.log(`[MeetBot] Tentando submeter via Enter...`);
        try {
          await this.page.keyboard.press('Enter');
        } catch (e) {}
      }

      console.log(`[MeetBot] Aguardando admissão na sala pelo anfitrião...`);

      // Aguardar até estar dentro da sala (detectando a barra de controles inferior ou botão de sair)
      const inCallSelectors = [
        'button[aria-label*="chamada" i]',
        'button[aria-label*="call" i]',
        'button[aria-label*="sair" i]',
        'button[aria-label*="leave" i]',
        'button[jsname="r8qRAd"]',
        'div[jsname="E2E3Fd"]'
      ];

      await this.page.waitForSelector(inCallSelectors.join(','), { timeout: 180000 });

      this.state = 'in_call';
      console.log(`[MeetBot] >>> ADMITIDO NA SALA COM SUCESSO! Iniciando captura.`);

      // 1. Ativar legendas fechadas (Closed Captions)
      try {
        await this.page.keyboard.press('c');
        console.log(`[MeetBot] Tecla 'c' pressionada para ativar legendas.`);
      } catch (e) {}

      // 2. Injetar Capturador de Legendas DOM e Gravação de Áudio via MediaRecorder
      await this.page.evaluate(() => {
        // Observador de Legendas
        const observer = new MutationObserver(() => {
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
          console.log('[Kognite In-Page] MediaRecorder iniciado com sucesso.');
        } catch (err) {
          console.error('[Kognite In-Page] Erro ao iniciar áudio:', err);
        }
      });

      // Loop de monitoramento de saída da chamada
      this.monitorMeetingStatus();

    } catch (err) {
      console.error(`[MeetBot Erro Fatal]:`, err.message);
      this.lastError = err.message;
      this.state = 'failed';
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
    this.state = this.state === 'failed' ? 'failed' : 'completed';

    console.log(`[MeetBot] Encerrando bot da reunião...`);

    let audioBase64 = null;
    let audioSize = 0;

    // 1. Coletar áudio gravado da página antes de fechar o navegador
    try {
      if (this.page && !this.page.isClosed()) {
        audioBase64 = await this.page.evaluate(async () => {
          if (!window.kogniteRecorder || !window.kogniteAudioChunks || window.kogniteAudioChunks.length === 0) {
            return null;
          }
          if (window.kogniteRecorder.state !== 'inactive') {
            window.kogniteRecorder.stop();
          }
          const blob = new Blob(window.kogniteAudioChunks, { type: 'audio/webm' });
          const buffer = await blob.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = '';
          const len = bytes.byteLength;
          for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          return window.btoa(binary);
        });

        if (audioBase64) {
          audioSize = Math.round((audioBase64.length * 3) / 4);
          console.log(`[MeetBot] Áudio extraído com sucesso! Tamanho aprox: ${(audioSize / 1024).toFixed(1)} KB`);
        }
      }
    } catch (err) {
      console.warn(`[MeetBot] Erro ao extrair áudio da página:`, err.message);
    }

    // 2. Fechar navegador
    try {
      if (this.browser) {
        await this.browser.close();
        console.log(`[MeetBot] Navegador Chromium fechado.`);
      }
    } catch (e) {}

    // 3. Montar transcrição consolidada
    const formattedTranscript = this.transcriptEntries
      .map(entry => `[${entry.timestamp}] ${entry.speaker}: ${entry.text}`)
      .join('\n');

    const durationSeconds = this.startTime ? Math.round((this.endTime - this.startTime) / 1000) : 0;
    const durationMinutes = Math.round(durationSeconds / 60);

    console.log(`[MeetBot] Resumo da gravação:`);
    console.log(`• Duração: ${durationMinutes} min (${durationSeconds}s)`);
    console.log(`• Participantes detectados: ${Array.from(this.speakersSet).join(', ') || 'Nenhum'}`);
    console.log(`• Linhas de transcrição: ${this.transcriptEntries.length}`);

    // 4. Enviar payload para o webhook do n8n se tiver dados relevantes
    if (this.transcriptEntries.length > 0 || audioBase64 || durationSeconds > 10) {
      await this.sendToN8n({
        title: this.title,
        meetingUrl: this.meetingUrl,
        startTime: this.startTime ? this.startTime.toISOString() : null,
        endTime: this.endTime.toISOString(),
        durationSeconds: durationSeconds,
        durationMinutes: durationMinutes,
        speakers: Array.from(this.speakersSet),
        transcript: formattedTranscript,
        audioBase64: audioBase64
      });
    } else {
      console.log(`[MeetBot] Reunião muito curta ou sem dados gravados. Ignorando envio para n8n.`);
    }

    this.isRunning = false;
    this.isStopping = false;
    console.log(`[MeetBot] Ciclo do bot finalizado.`);
  }

  async sendToN8n(payload) {
    console.log(`[MeetBot] Enviando dados para o webhook n8n: ${this.webhookUrl}`);
    try {
      if (payload.audioBase64) {
        const form = new FormData();
        form.append('title', payload.title);
        form.append('meetingUrl', payload.meetingUrl);
        form.append('startTime', payload.startTime || '');
        form.append('endTime', payload.endTime || '');
        form.append('durationMinutes', String(payload.durationMinutes));
        form.append('durationSeconds', String(payload.durationSeconds));
        form.append('speakers', JSON.stringify(payload.speakers));
        form.append('transcript', payload.transcript);

        const audioBuffer = Buffer.from(payload.audioBase64, 'base64');
        form.append('file', audioBuffer, {
          filename: `Reuniao_${new Date().toISOString().replace(/[:.]/g, '-')}.webm`,
          contentType: 'audio/webm'
        });

        const res = await axios.post(this.webhookUrl, form, {
          headers: form.getHeaders(),
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 60000
        });
        console.log(`[MeetBot] n8n respondeu com status:`, res.status);
      } else {
        const res = await axios.post(this.webhookUrl, payload, {
          timeout: 30000,
          headers: { 'Content-Type': 'application/json' }
        });
        console.log(`[MeetBot] n8n respondeu com status:`, res.status);
      }
    } catch (err) {
      console.error(`[MeetBot] Erro ao enviar para o n8n:`, err.message);
    }
  }
}

module.exports = { MeetBot };

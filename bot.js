const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

class MeetBot {
  constructor(options = {}) {
    this.meetingUrl = options.meetingUrl;
    this.title = options.title || 'Reunião Kognite';
    this.botName = options.botName || 'Kognite Bot';
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
    this.wasAdmitted = false;
    this.state = 'initialized'; // initialized, launching, navigating, joining, in_call, completed, failed
    this.lastError = null;

    // Extrair código da reunião (ex: xoz-bvyh-zqm)
    const match = (this.meetingUrl || '').match(/meet\.google\.com\/([a-z0-9-]+)/i);
    this.meetingCode = match ? match[1] : '';

    // Carregar imagem de avatar para a câmera virtual animada
    const avatarPath = path.join(__dirname, 'avatar.jpg');
    this.avatarBase64 = fs.existsSync(avatarPath) ? fs.readFileSync(avatarPath).toString('base64') : '';
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.state = 'launching';
    this.startTime = new Date();

    console.log(`[MeetBot] >>> Iniciando "${this.botName}" para: ${this.meetingUrl} (Código: ${this.meetingCode})`);

    try {
      console.log(`[MeetBot] Passo 1: Lançando Google Chrome Oficial + Stealth...`);
      this.browser = await chromium.launch({
        channel: 'chrome',
        headless: true,
        args: [
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          '--autoplay-policy=no-user-gesture-required',
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--window-size=1280,720'
        ]
      });

      console.log(`[MeetBot] Passo 2: Criando contexto do navegador com permissões de mídia...`);
      const statePath = path.join(__dirname, 'state.json');
      const contextOptions = {
        permissions: ['microphone', 'camera'],
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 720 },
        locale: 'pt-BR'
      };

      if (fs.existsSync(statePath)) {
        contextOptions.storageState = statePath;
        console.log(`[MeetBot] Sessão salva encontrada em state.json! Carregando autenticação...`);
      }

      this.context = await this.browser.newContext(contextOptions);

      // Carregar cookies de autenticação Google (cookies.json ou GOOGLE_COOKIES env)
      const cookiesFilePath = path.join(__dirname, 'cookies.json');
      let rawCookiesSource = null;
      if (fs.existsSync(cookiesFilePath)) {
        rawCookiesSource = fs.readFileSync(cookiesFilePath, 'utf8');
        console.log(`[MeetBot] Lendo cookies de autenticação do arquivo cookies.json...`);
      } else if (process.env.GOOGLE_COOKIES) {
        rawCookiesSource = process.env.GOOGLE_COOKIES.trim();
      }

      if (rawCookiesSource) {
        try {
          const parsed = JSON.parse(rawCookiesSource);
          const rawArray = Array.isArray(parsed) ? parsed : (parsed.cookies || []);
          
          const sanitizedCookies = rawArray.map(c => {
            const cookie = {
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path || '/'
            };
            if (typeof c.httpOnly === 'boolean') cookie.httpOnly = c.httpOnly;
            if (typeof c.secure === 'boolean') cookie.secure = c.secure;
            if (c.expirationDate) cookie.expires = c.expirationDate;

            if (c.sameSite) {
              const ss = String(c.sameSite).toLowerCase();
              if (ss === 'no_restriction' || ss === 'none') {
                cookie.sameSite = 'None';
              } else if (ss === 'lax') {
                cookie.sameSite = 'Lax';
              } else if (ss === 'strict') {
                cookie.sameSite = 'Strict';
              }
            }
            return cookie;
          });

          if (sanitizedCookies.length > 0) {
            await this.context.addCookies(sanitizedCookies);
            console.log(`[MeetBot] ${sanitizedCookies.length} cookies de autenticação Google carregados e sanitizados com sucesso!`);
          }
        } catch (err) {
          console.warn(`[MeetBot] Erro ao carregar cookies Google do env:`, err.message);
        }
      }

      this.page = await this.context.newPage();

      // Ocultar sinalizadores de automação para evitar bloqueios
      await this.page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {} };
      });

      // INJETAR CÂMERA VIRTUAL ANIMADA (Kognite Bot ouvindo com fone e digitando no notebook)
      await this.page.addInitScript(({ botName, avatarBase64 }) => {
        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const ctx = canvas.getContext('2d');

        const img = new Image();
        if (avatarBase64) {
          img.src = 'data:image/jpeg;base64,' + avatarBase64;
        }

        let frame = 0;
        function renderVirtualCamera() {
          frame++;

          // 1. Fundo preto puro (integra 100% sem bordas com a imagem do robô)
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          // 2. Brilho radial suave ao redor do bot
          const grad = ctx.createRadialGradient(640, 360, 40, 640, 360, 420);
          grad.addColorStop(0, 'rgba(56, 189, 248, 0.14)');
          grad.addColorStop(0.7, 'rgba(0, 0, 0, 0.4)');
          grad.addColorStop(1, 'rgba(0, 0, 0, 1)');
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          // 3. Desenhar mascote fofo Kognite Bot (com suave efeito de flutuação/respiração)
          if (img.complete && img.naturalWidth > 0) {
            const size = 480;
            const floatY = Math.sin(frame * 0.04) * 5;
            ctx.drawImage(img, (1280 - size) / 2, (720 - size) / 2 - 25 + floatY, size, size);
          }

          // 4. Badge Superior: Status de Gravação Ativa
          ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(40, 32, 270, 44, 22);
          ctx.fill();
          ctx.stroke();

          // Ponto vermelho pulsante (Gravando)
          const pulse = 0.5 + 0.5 * Math.sin(frame * 0.1);
          ctx.fillStyle = `rgba(239, 68, 68, ${pulse})`;
          ctx.beginPath();
          ctx.arc(64, 54, 7, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = '#f8fafc';
          ctx.font = 'bold 15px sans-serif';
          ctx.fillText('GRAVANDO REUNIÃO', 82, 60);

          // 5. Card Inferior: Escutando e gerando ata
          const cardW = 620;
          const cardX = (1280 - cardW) / 2;
          ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.roundRect(cardX, 600, cardW, 80, 20);
          ctx.fill();
          ctx.stroke();

          // Barras animadas do equalizador (indicando que está escutando o áudio em tempo real)
          const eqX = cardX + 30;
          const eqY = 640;
          for (let i = 0; i < 5; i++) {
            const barH = 10 + 18 * Math.abs(Math.sin((frame * 0.12) + (i * 0.7)));
            ctx.fillStyle = '#38bdf8';
            ctx.fillRect(eqX + (i * 9), eqY - (barH / 2), 5, barH);
          }

          // Título do Bot
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 17px sans-serif';
          ctx.fillText(`${botName} • Escutando tudo e gerando ata...`, eqX + 65, 634);

          // Subtítulo com pontinhos digitando
          const dots = '.'.repeat((Math.floor(frame / 18) % 3) + 1);
          ctx.fillStyle = '#94a3b8';
          ctx.font = '13px sans-serif';
          ctx.fillText(`Registrando transcrição e ata executiva em tempo real${dots}`, eqX + 65, 658);

          requestAnimationFrame(renderVirtualCamera);
        }

        renderVirtualCamera();

        // Interceptar getUserMedia para fornecer o canvas animado como o feed de vídeo da webcam
        const stream = canvas.captureStream(25);
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
          navigator.mediaDevices.getUserMedia = async (constraints) => {
            if (constraints && constraints.video) {
              return stream;
            }
            return origGUM(constraints);
          };
        }
      }, { botName: this.botName, avatarBase64: this.avatarBase64 });

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
      console.log(`[MeetBot] Passo 3: Navegando para a chamada: ${this.meetingUrl}`);
      await this.page.goto(this.meetingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.page.waitForTimeout(3000);
      console.log(`[MeetBot] URL carregada: ${this.page.url()}`);

      // Tratar possíveis popups de cookies ou termos do Google
      try {
        const dismissSelectors = [
          'button:has-text("Recusar tudo")',
          'button:has-text("Aceitar tudo")',
          'button:has-text("Entendi")',
          'button:has-text("Concordo")',
          'button:has-text("Ignorar")',
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

      // PASSO 4: Microfone 100% MUTADO (Câmera permanece ligada transmitindo o Kognite Bot animado)
      try {
        await this.page.keyboard.down('Control');
        await this.page.keyboard.press('d'); // Silenciar microfone
        await this.page.keyboard.up('Control');
        console.log(`[MeetBot] Atalho Ctrl+D enviado para silenciar microfone.`);
      } catch (err) {
        console.warn(`[MeetBot] Erro ao enviar atalho de mic:`, err.message);
      }

      try {
        const turnOffMic = await this.page.$('button[aria-label*="desativar microfone" i], button[aria-label*="turn off microphone" i]');
        if (turnOffMic && await turnOffMic.isVisible()) {
          await turnOffMic.click();
          console.log('[MeetBot] Microfone desativado via clique no botão.');
        }
      } catch (e) {}

      // PASSO 4.5: Clicar em "Continuar como convidado" se exibido
      const guestButtonSelectors = [
        'button:has-text("Continuar como convidado")',
        'button:has-text("Continue as guest")',
        'button:has-text("Continue as a guest")',
        'button:has-text("convidado")',
        'button:has-text("guest")'
      ];

      for (const sel of guestButtonSelectors) {
        try {
          const guestBtn = await this.page.$(sel);
          if (guestBtn && await guestBtn.isVisible()) {
            console.log(`[MeetBot] Encontrado botão de convidado: "${sel}". Clicando...`);
            await guestBtn.click();
            await this.page.waitForTimeout(2000);
            break;
          }
        } catch (e) {}
      }

      // PASSO 5: Preencher nome do bot ("Kognite Bot") se campo de nome for solicitado
      const nameInputSelectors = [
        'input[placeholder*="nome" i]',
        'input[aria-label*="nome" i]',
        'input[placeholder*="name" i]',
        'input[aria-label*="name" i]'
      ];

      for (const sel of nameInputSelectors) {
        try {
          const input = await this.page.$(sel);
          if (input && await input.isVisible()) {
            await input.fill(this.botName);
            console.log(`[MeetBot] Nome preenchido no campo "${sel}": "${this.botName}"`);
            await this.page.waitForTimeout(1000);
            break;
          }
        } catch (e) {}
      }

      // PASSO 6: Clicar no botão para entrar na chamada ("Participar agora" ou "Pedir para participar")
      this.state = 'joining';
      const joinSelectors = [
        'button:has-text("Participar agora")',
        'button:has-text("Pedir para participar")',
        'button:has-text("Join now")',
        'button:has-text("Ask to join")',
        'button[jsname="Qx7uuf"]',
        'button[jsname="CQylAd"]'
      ];

      let clickedJoin = false;
      for (const sel of joinSelectors) {
        try {
          const btn = await this.page.$(sel);
          if (btn && await btn.isVisible()) {
            const isDisabled = await btn.getAttribute('disabled');
            if (isDisabled !== null && isDisabled !== 'false') {
              console.log(`[MeetBot] Botão ${sel} ainda desabilitado, aguardando 1s...`);
              await this.page.waitForTimeout(1000);
            }
            await btn.click();
            console.log(`[MeetBot] Clicou com sucesso no botão de entrada: ${sel}`);
            clickedJoin = true;
            break;
          }
        } catch (e) {}
      }

      if (!clickedJoin) {
        console.log(`[MeetBot] Tentando submeter via tecla Enter...`);
        try {
          await this.page.keyboard.press('Enter');
        } catch (e) {}
      }

      console.log(`[MeetBot] Solicitação enviada! Aguardando confirmação de entrada na sala...`);

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

      this.wasAdmitted = true;
      this.state = 'in_call';
      console.log(`[MeetBot] >>> ADMITIDO NA SALA COM SUCESSO! Iniciando captura de áudio e legendas.`);

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

    console.log(`[MeetBot] Encerrando gravação da reunião...`);

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
    console.log(`• Foi admitido na sala: ${this.wasAdmitted}`);
    console.log(`• Duração: ${durationMinutes} min (${durationSeconds}s)`);
    console.log(`• Participantes detectados: ${Array.from(this.speakersSet).join(', ') || 'Nenhum'}`);
    console.log(`• Linhas de transcrição: ${this.transcriptEntries.length}`);

    // 4. Enviar payload para o webhook do n8n SOMENTE se foi admitido e tiver dados gravados
    const hasData = this.transcriptEntries.length > 0 || (audioBase64 && audioSize > 1024);
    if (this.wasAdmitted && hasData) {
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
      console.log(`[MeetBot] Reunião não admitida ou sem áudio/legendas capturadas. Envio para n8n ignorado.`);
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

async function performGoogleLogin(email, password, onSessionReady) {
  console.log(`[GoogleLogin] Iniciando login nativo no servidor para: ${email}`);
  let browser = null;
  try {
    console.log(`[GoogleLogin] Passo 1: Abrindo Google Chrome Oficial + Stealth...`);
    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--window-size=1280,720'
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
      locale: 'pt-BR'
    });

    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });

    const statePath = path.join(__dirname, 'state.json');
    if (onSessionReady) onSessionReady({ browser, context, page, statePath });

    console.log(`[GoogleLogin] Passo 2: Navegando para accounts.google.com...`);
    await page.goto('https://accounts.google.com/ServiceLogin?continue=https://meet.google.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);
    console.log(`[GoogleLogin] Página de login carregada: ${page.url()}`);

    // Preencher email
    const emailInput = await page.waitForSelector('input#identifierId, input[type="email"]', { state: 'visible', timeout: 15000 });
    await emailInput.fill(email);
    await page.keyboard.press('Enter');
    console.log(`[GoogleLogin] E-mail submetido.`);

    // Preencher senha
    const pwdInput = await page.waitForSelector('input[type="password"], input[name="Passwd"]', { state: 'visible', timeout: 15000 });
    await pwdInput.fill(password);
    await page.keyboard.press('Enter');
    console.log(`[GoogleLogin] Senha submetida. Aguardando redirecionamento ou confirmação...`);
    await page.waitForTimeout(6000);

    await context.storageState({ path: statePath });
    console.log(`[GoogleLogin] Estado salvo em ${statePath}. URL atual: ${page.url()}`);
  } catch (err) {
    console.error(`[GoogleLogin Erro]:`, err.message);
  }
}

module.exports = { MeetBot, performGoogleLogin };

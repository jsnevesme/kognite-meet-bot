FROM mcr.microsoft.com/playwright:v1.49.1-jammy

ENV DEBIAN_FRONTEND=noninteractive

WORKDIR /app

# Instalar dependências de sistema para login visual único + ffmpeg para MP3
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Copiar arquivos de dependências
COPY package*.json ./

# Instalar dependências Node + Google Chrome Oficial
RUN npm install --production && npx playwright install chrome

# Copiar o restante da aplicação
COPY . .

# Criar pasta persistente do perfil do Chrome
RUN mkdir -p /app/chrome-profile

# Variáveis padrão
ENV PORT=3005
ENV NODE_ENV=production
ENV N8N_WEBHOOK_URL=https://n8n.kognite.io/webhook/meet-recording-finished

EXPOSE 3005 6080

CMD ["node", "server.js"]

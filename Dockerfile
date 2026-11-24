FROM mcr.microsoft.com/playwright:v1.49.1-jammy

ENV DEBIAN_FRONTEND=noninteractive

WORKDIR /app

# Instalar xvfb de forma 100% não-interativa (elimina qualquer pausa em tzdata)
RUN apt-get update && apt-get install -y --no-install-recommends xvfb && rm -rf /var/lib/apt/lists/*

# Copiar arquivos de dependências
COPY package*.json ./

# Instalar dependências fixadas
RUN npm install --production

# Copiar o restante da aplicação
COPY . .

# Variáveis padrão
ENV PORT=3005
ENV NODE_ENV=production
ENV N8N_WEBHOOK_URL=https://n8n.kognite.io/webhook/meet-recording-finished

EXPOSE 3005

CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x720x24", "node", "server.js"]

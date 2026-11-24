FROM mcr.microsoft.com/playwright:v1.49.1-jammy

ENV DEBIAN_FRONTEND=noninteractive

WORKDIR /app

# Copiar arquivos de dependências
COPY package*.json ./

# Instalar dependências + Google Chrome Oficial
RUN npm install --production && npx playwright install chrome

# Copiar o restante da aplicação
COPY . .

# Variáveis padrão
ENV PORT=3005
ENV NODE_ENV=production
ENV N8N_WEBHOOK_URL=https://n8n.kognite.io/webhook/meet-recording-finished

EXPOSE 3005

CMD ["node", "server.js"]

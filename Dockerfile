FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

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

CMD ["node", "server.js"]

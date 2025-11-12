FROM node:20-slim

WORKDIR /app

# Copy package manifests and install deps first for better layer caching
COPY slack-openai-bot/package*.json ./
RUN npm install --no-audit --no-fund

# Copy app source
COPY slack-openai-bot/. .

CMD ["node", "app.js"]

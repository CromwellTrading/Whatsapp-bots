FROM node:18-bullseye-slim

# Instalar Chromium, GIT y dependencias necesarias para Puppeteer/whatsapp-web.js
RUN apt-get update && apt-get install -y \
    chromium \
    git \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Le decimos a Puppeteer que no descargue su propio Chrome, que use el que acabamos de instalar
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copiamos el package.json e instalamos
COPY package*.json ./
RUN npm install

# Copiamos el resto del código
COPY . .

# Exponemos el puerto de Express
EXPOSE 3000

# Iniciamos el bot
CMD ["npm", "start"]

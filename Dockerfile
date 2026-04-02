FROM node:18-bullseye-slim

# Instalar Chromium, GIT y dependencias necesarias para Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    git \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Configurar variables de entorno para que Puppeteer use el Chromium que instalamos
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copiar archivos e instalar dependencias
COPY package*.json ./
# Instalamos la nueva librería y las necesarias para la web
RUN npm install whatsapp-web.js qrcode express

COPY . .

EXPOSE 3000
CMD ["node", "index.js"]

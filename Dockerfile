FROM node:20-bullseye-slim

# Instalar dependencias del sistema
RUN apt-get update && apt-get install -y \
    chromium \
    git \
    openssh-client \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# FORZAR A GIT A USAR HTTPS EN LUGAR DE SSH (El salvavidas)
RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/

# Copiar el package.json
COPY package.json ./

# Instalación limpia
RUN npm install

# Copiar el resto del código
COPY . .

EXPOSE 3000
CMD ["npm", "start"]

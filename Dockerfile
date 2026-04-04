FROM node:18-slim

# Instalar dependencias del sistema necesarias para Baileys (sin puppeteer)
RUN apt-get update && apt-get install -y \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar package.json y package-lock.json (si existe)
COPY package*.json ./

# Instalar solo dependencias de producción
RUN npm ci --only=production

# Copiar el resto del código
COPY . .

# Exponer el puerto que usará Express
EXPOSE 3000

# Comando para iniciar el bot
CMD ["npm", "start"]

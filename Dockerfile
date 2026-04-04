FROM node:18-alpine

# Instalar git (necesario para algunas dependencias de Baileys)
RUN apk add --no-cache git

WORKDIR /app

# Copiar archivos de definición de paquetes
COPY package*.json ./

# Instalar dependencias (no necesita package-lock.json)
RUN npm install

# Copiar el resto del código fuente
COPY . .

# Puerto que usará Express para mostrar QR/código
EXPOSE 3000

# Comando de inicio
CMD ["npm", "start"]

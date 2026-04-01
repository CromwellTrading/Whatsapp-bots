# Usar una imagen oficial de Node.js 20 ligera
FROM node:20-bullseye-slim

# Instalar git, python3 y herramientas de compilación
RUN apt-get update && apt-get install -y \
    python3 \
    build-essential \
    git \
    && rm -rf /var/lib/apt/lists/*

# Crear y definir el directorio de trabajo dentro del contenedor
WORKDIR /app

# Copiar los archivos de dependencias primero (para optimizar caché de Docker)
COPY package*.json ./

# Instalar las dependencias
RUN npm install

# Copiar el resto del código del bot
COPY . .

# Crear la carpeta de medios
RUN mkdir -p media

# Exponer el puerto para el servidor web (QR)
EXPOSE 3000

# Comando para iniciar el bot
CMD ["npm", "start"]

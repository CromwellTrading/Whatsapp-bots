FROM node:20-bullseye-slim
WORKDIR /app

# Actualizar repositorios e instalar git (necesario para Baileys)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "start"]

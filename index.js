require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');

const { initManager } = require('./core/manager');
const { initCron } = require('./core/cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Rutas de autenticación
app.use('/api/auth', require('./routes/auth'));

// Rutas de usuario (protegidas)
app.use('/api/user', require('./routes/user'));

// Rutas de administrador (protegidas)
app.use('/api/admin', require('./routes/admin'));

// Redireccionar raíz al login
app.get('/', (req, res) => res.redirect('/login.html'));

app.listen(PORT, async () => {
  console.log(`🌐 Servidor corriendo en http://localhost:${PORT}`);
  
  // Iniciar gestor de instancias (levanta conexiones existentes)
  await initManager();
  
  // Iniciar cron centralizado
  initCron();
  
  console.log('✅ Sistema SaaS inicializado');
});

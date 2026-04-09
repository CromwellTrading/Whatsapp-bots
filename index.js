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

// Endpoint de configuración para el frontend (claves públicas)
app.get('/config.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    window.SUPABASE_URL = "${process.env.SUPABASE_URL}";
    window.SUPABASE_ANON_KEY = "${process.env.SUPABASE_ANON_KEY}";
  `);
});

// Health check para Render
app.get('/health', (req, res) => res.status(200).send('OK'));

// Servir archivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Rutas de API
app.use('/api/auth', require('./routes/auth'));
app.use('/api/user', require('./routes/user'));
app.use('/api/admin', require('./routes/admin'));

app.get('/', (req, res) => res.redirect('/login.html'));

app.listen(PORT, async () => {
  console.log(`🌐 Servidor corriendo en http://localhost:${PORT}`);

  await initManager();
  initCron();

  console.log('✅ Sistema SaaS inicializado');
});

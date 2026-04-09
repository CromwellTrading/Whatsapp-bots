// Agrega esto en index.js antes de las rutas estáticas
app.get('/config.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    window.SUPABASE_URL = "${process.env.SUPABASE_URL}";
    window.SUPABASE_ANON_KEY = "${process.env.SUPABASE_ANON_KEY}";
  `);
});

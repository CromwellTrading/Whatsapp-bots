const express = require('express');
const router = express.Router();
const { supabase } = require('../auth/supabase');

// Registro
router.post('/register', async (req, res) => {
  const { email, password, phone_number, full_name } = req.body;
  
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        phone_number,
        full_name
      }
    }
  });
  
  if (error) return res.status(400).json({ error: error.message });
  
  res.json({ user: data.user });
});

// Login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });
  
  if (error) return res.status(401).json({ error: error.message });
  
  // Devolver token de sesión
  res.json({ 
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    user: data.user
  });
});

// Logout
router.post('/logout', async (req, res) => {
  const { error } = await supabase.auth.signOut();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Obtener usuario actual
router.get('/me', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error) return res.status(401).json({ error: error.message });
  
  // Obtener perfil para saber si es admin
  const { data: profile } = await supabase
    .from('profiles')
    .select('is_admin, phone_number')
    .eq('id', user.id)
    .single();
  
  res.json({ 
    user: { ...user, is_admin: profile?.is_admin || false, phone_number: profile?.phone_number }
  });
});

module.exports = router;

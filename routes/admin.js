const express = require('express');
const router = express.Router();
const { supabase, supabaseAdmin } = require('../auth/supabase');
const { getAllInstances, stopUserInstance, startUserInstance, startUserIfApproved } = require('../core/manager');

// Middleware que verifica que el usuario sea admin
async function adminMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error) return res.status(401).json({ error: 'Token inválido' });
  
  // Verificar si es admin
  const { data: profile } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', user.id)
    .single();
  
  if (!profile?.is_admin) return res.status(403).json({ error: 'Acceso denegado' });
  
  req.user = user;
  next();
}

// Obtener lista de todos los usuarios
router.get('/users', adminMiddleware, async (req, res) => {
  const { data: profiles, error } = await supabaseAdmin
    .from('profiles')
    .select('id, phone_number, full_name, is_admin, is_approved, created_at');
  
  if (error) return res.status(500).json({ error: error.message });
  
  // Añadir estado de conexión desde las instancias activas
  const instances = getAllInstances();
  const usersWithStatus = profiles.map(p => {
    const instance = instances.find(i => i.userId === p.id);
    return {
      ...p,
      connected: instance?.connected || false,
      hasQR: instance?.hasQR || false
    };
  });
  
  res.json(usersWithStatus);
});

// Obtener configuración de un usuario específico (admin)
router.get('/users/:userId/settings', adminMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('bot_settings')
    .select('data')
    .eq('user_id', req.params.userId)
    .single();
  
  if (error) return res.status(404).json({ error: 'Configuración no encontrada' });
  res.json(data.data);
});

// Aprobar usuario
router.post('/users/:userId/approve', adminMiddleware, async (req, res) => {
  const { userId } = req.params;
  
  const { error } = await supabaseAdmin
    .from('profiles')
    .update({ is_approved: true })
    .eq('id', userId);
  
  if (error) return res.status(500).json({ error: error.message });
  
  // Iniciar instancia para el usuario recién aprobado
  await startUserIfApproved(userId);
  
  res.json({ success: true });
});

// Reiniciar instancia de un usuario
router.post('/users/:userId/restart', adminMiddleware, async (req, res) => {
  const { userId } = req.params;
  // Obtener phone_number del perfil
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('phone_number')
    .eq('id', userId)
    .single();
  
  if (!profile) return res.status(404).json({ error: 'Usuario no encontrado' });
  
  await stopUserInstance(userId);
  await startUserInstance(userId, profile.phone_number);
  res.json({ success: true });
});

// Eliminar usuario (admin)
router.delete('/users/:userId', adminMiddleware, async (req, res) => {
  const { userId } = req.params;
  
  // Detener instancia
  await stopUserInstance(userId);
  
  // Eliminar de auth.users (cascada borrará perfiles y sesiones)
  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (error) return res.status(500).json({ error: error.message });
  
  res.json({ success: true });
});

module.exports = router;

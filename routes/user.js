const express = require('express');
const router = express.Router();
const multer = require('multer');
const { supabase, supabaseAdmin } = require('../auth/supabase');
const { getUserStatus, startUserInstance } = require('../core/manager');
const { getSettings, saveSettings } = require('../utils/db');

// Middleware de autenticación
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error) return res.status(401).json({ error: 'Token inválido' });
  
  req.user = user;
  next();
}

// Obtener estado del bot del usuario
router.get('/status', authMiddleware, async (req, res) => {
  const status = getUserStatus(req.user.id);
  if (!status) {
    return res.json({ connected: false, qrAvailable: false, message: 'Instancia no iniciada' });
  }
  res.json({
    connected: status.connected,
    qrAvailable: !!status.qr,
    pairingCode: status.pairingCode,
    phoneNumber: status.phoneNumber
  });
});

// Obtener QR (imagen)
router.get('/qr', authMiddleware, async (req, res) => {
  const status = getUserStatus(req.user.id);
  if (!status || !status.qr) {
    return res.status(404).send('QR no disponible');
  }
  const QRCode = require('qrcode');
  const qrImage = await QRCode.toDataURL(status.qr);
  res.send(`<img src="${qrImage}" alt="QR Code" />`);
});

// Obtener código de 8 dígitos
router.get('/pairing-code', authMiddleware, (req, res) => {
  const status = getUserStatus(req.user.id);
  if (!status || !status.pairingCode) {
    return res.status(404).json({ error: 'Código no disponible' });
  }
  res.json({ code: status.pairingCode.match(/.{1,4}/g)?.join('-') || status.pairingCode });
});

// Obtener configuración
router.get('/settings', authMiddleware, async (req, res) => {
  const settings = await getSettings(req.user.id);
  res.json(settings || { autoReply: { active: false }, tasks: [] });
});

// Guardar configuración
router.post('/settings', authMiddleware, async (req, res) => {
  try {
    await saveSettings(req.user.id, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Subir imagen (para usar en tareas/auto-reply)
const upload = multer({ storage: multer.memoryStorage() });
router.post('/upload', authMiddleware, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se envió imagen' });
  
  const fileExt = req.file.originalname.split('.').pop();
  const fileName = `${req.user.id}/${Date.now()}.${fileExt}`;
  
  const { data, error } = await supabaseAdmin.storage
    .from('media')
    .upload(fileName, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false
    });
  
  if (error) return res.status(500).json({ error: error.message });
  
  // Obtener URL pública
  const { data: { publicUrl } } = supabaseAdmin.storage
    .from('media')
    .getPublicUrl(fileName);
  
  res.json({ url: publicUrl });
});

// Reiniciar instancia
router.post('/restart', authMiddleware, async (req, res) => {
  const { phone_number } = req.body; // Se puede obtener del perfil
  await startUserInstance(req.user.id, phone_number);
  res.json({ success: true });
});

module.exports = router;

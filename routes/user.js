const express = require('express');
const router = express.Router();
const multer = require('multer');
const { supabase, supabaseAdmin } = require('../auth/supabase');
const { getUserStatus, startUserInstance } = require('../core/manager');
const { getSettings, saveSettings } = require('../utils/db');

// -------------------- MIDDLEWARES --------------------
async function authAndApprovalMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error) return res.status(401).json({ error: 'Token inválido' });
  
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('is_approved, phone_number, is_admin')
    .eq('id', user.id)
    .single();
  
  if (profileError || !profile) {
    return res.status(401).json({ error: 'Perfil no encontrado' });
  }
  
  req.user = user;
  req.profile = profile;
  
  if (req.requiresApproval && !profile.is_approved) {
    return res.status(403).json({ error: 'Cuenta pendiente de aprobación por el administrador' });
  }
  
  next();
}

function requiresApproval(req, res, next) {
  req.requiresApproval = true;
  next();
}

// -------------------- RUTAS --------------------

// Estado de aprobación (accesible siempre)
router.get('/approval-status', authAndApprovalMiddleware, (req, res) => {
  res.json({
    is_approved: req.profile.is_approved,
    phone_number: req.profile.phone_number,
    is_admin: req.profile.is_admin
  });
});

// A partir de aquí, todas las rutas requieren aprobación
router.get('/status', authAndApprovalMiddleware, requiresApproval, async (req, res) => {
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

router.get('/qr', authAndApprovalMiddleware, requiresApproval, async (req, res) => {
  const status = getUserStatus(req.user.id);
  if (!status || !status.qr) {
    return res.status(404).send('QR no disponible');
  }
  const QRCode = require('qrcode');
  const qrImage = await QRCode.toDataURL(status.qr);
  res.send(`<img src="${qrImage}" alt="QR Code" />`);
});

router.get('/pairing-code', authAndApprovalMiddleware, requiresApproval, (req, res) => {
  const status = getUserStatus(req.user.id);
  if (!status || !status.pairingCode) {
    return res.status(404).json({ error: 'Código no disponible' });
  }
  res.json({ code: status.pairingCode.match(/.{1,4}/g)?.join('-') || status.pairingCode });
});

router.get('/settings', authAndApprovalMiddleware, requiresApproval, async (req, res) => {
  const settings = await getSettings(req.user.id);
  res.json(settings || { autoReply: { active: false }, tasks: [] });
});

router.post('/settings', authAndApprovalMiddleware, requiresApproval, async (req, res) => {
  try {
    await saveSettings(req.user.id, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const upload = multer({ storage: multer.memoryStorage() });
router.post('/upload', authAndApprovalMiddleware, requiresApproval, upload.single('image'), async (req, res) => {
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
  
  const { data: { publicUrl } } = supabaseAdmin.storage
    .from('media')
    .getPublicUrl(fileName);
  
  res.json({ url: publicUrl });
});

router.post('/restart', authAndApprovalMiddleware, requiresApproval, async (req, res) => {
  const { phone_number } = req.profile;
  await startUserInstance(req.user.id, phone_number);
  res.json({ success: true });
});

module.exports = router;

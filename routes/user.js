const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { supabase, supabaseAdmin } = require('../auth/supabase');
const { getUserStatus, startUserInstance, getGroupsForUser } = require('../core/manager');
const { getSettings, saveSettings } = require('../utils/db');

// -------------------- MIDDLEWARES --------------------
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error) return res.status(401).json({ error: 'Token inválido' });

  req.user = user;
  next();
}

async function approvalMiddleware(req, res, next) {
  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .select('is_approved, phone_number, is_admin')
    .eq('id', req.user.id)
    .single();

  if (error || !profile) {
    return res.status(401).json({ error: 'Perfil no encontrado' });
  }

  if (!profile.is_approved) {
    return res.status(403).json({ error: 'Cuenta pendiente de aprobación' });
  }

  req.profile = profile;
  next();
}

// -------------------- GLOBAL AUTH --------------------
router.use(authMiddleware);

// -------------------- RUTAS PÚBLICAS (sin aprobación) --------------------
router.get('/profile', async (req, res) => {
  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .select('is_approved, phone_number, is_admin')
    .eq('id', req.user.id)
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(profile);
});

// -------------------- RUTAS QUE REQUIEREN APROBACIÓN --------------------
router.use(approvalMiddleware);

router.get('/status', async (req, res) => {
  const status = getUserStatus(req.user.id);
  if (!status) {
    return res.json({ connected: false, qrAvailable: false });
  }
  res.json({
    connected: status.connected,
    qrAvailable: !!status.qr,
    pairingCode: status.pairingCode,
    phoneNumber: status.phoneNumber
  });
});

router.get('/qr', async (req, res) => {
  const status = getUserStatus(req.user.id);
  if (!status || !status.qr) return res.status(404).send('QR no disponible');
  const QRCode = require('qrcode');
  const qrImage = await QRCode.toDataURL(status.qr);
  res.send(`<img src="${qrImage}" alt="QR Code" />`);
});

router.get('/pairing-code', (req, res) => {
  const status = getUserStatus(req.user.id);
  if (!status || !status.pairingCode) return res.status(404).json({ error: 'Código no disponible' });
  res.json({ code: status.pairingCode.match(/.{1,4}/g)?.join('-') || status.pairingCode });
});

router.get('/settings', async (req, res) => {
  const settings = await getSettings(req.user.id);
  res.json(settings || { autoReply: { active: false }, tasks: [], statusTasks: [] });
});

router.post('/settings', async (req, res) => {
  try {
    await saveSettings(req.user.id, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const upload = multer({ storage: multer.memoryStorage() });
router.post('/upload', upload.single('image'), async (req, res) => {
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

router.post('/restart', async (req, res) => {
  const { phone_number } = req.profile;
  await startUserInstance(req.user.id, phone_number);
  res.json({ success: true });
});

// -------------------- GRUPOS --------------------
router.get('/groups', async (req, res) => {
  const groups = await getGroupsForUser(req.user.id);
  res.json(groups);
});

// -------------------- TAREAS --------------------
router.get('/tasks', async (req, res) => {
  const settings = await getSettings(req.user.id);
  res.json(settings?.tasks || []);
});

router.post('/tasks', async (req, res) => {
  const settings = (await getSettings(req.user.id)) || { tasks: [], statusTasks: [] };
  const { task } = req.body;
  if (!task.id) task.id = uuidv4();
  const existingIndex = settings.tasks.findIndex(t => t.id === task.id);
  if (existingIndex >= 0) settings.tasks[existingIndex] = task;
  else settings.tasks.push(task);
  await saveSettings(req.user.id, settings);
  res.json({ success: true, task });
});

router.delete('/tasks/:id', async (req, res) => {
  const settings = await getSettings(req.user.id);
  settings.tasks = (settings.tasks || []).filter(t => t.id !== req.params.id);
  await saveSettings(req.user.id, settings);
  res.json({ success: true });
});

router.post('/tasks/:id/test', async (req, res) => {
  const settings = await getSettings(req.user.id);
  const task = settings.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });

  const instance = require('../core/manager').instances.get(req.user.id);
  if (!instance || !instance.isConnected) {
    return res.status(400).json({ error: 'WhatsApp no conectado' });
  }

  try {
    const msg = task.mediaUrl
      ? { image: { url: task.mediaUrl }, caption: task.message }
      : { text: task.message };
    await instance.sock.sendMessage(task.target, msg);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -------------------- ESTADOS (STATUS TASKS) --------------------
router.get('/status-tasks', async (req, res) => {
  const settings = await getSettings(req.user.id);
  res.json(settings?.statusTasks || []);
});

router.post('/status-tasks', async (req, res) => {
  const settings = (await getSettings(req.user.id)) || { tasks: [], statusTasks: [] };
  const { task } = req.body;
  if (!task.id) task.id = uuidv4();
  const existingIndex = settings.statusTasks.findIndex(t => t.id === task.id);
  if (existingIndex >= 0) settings.statusTasks[existingIndex] = task;
  else settings.statusTasks.push(task);
  await saveSettings(req.user.id, settings);
  res.json({ success: true, task });
});

router.delete('/status-tasks/:id', async (req, res) => {
  const settings = await getSettings(req.user.id);
  settings.statusTasks = (settings.statusTasks || []).filter(t => t.id !== req.params.id);
  await saveSettings(req.user.id, settings);
  res.json({ success: true });
});

router.post('/status-tasks/:id/test', async (req, res) => {
  const settings = await getSettings(req.user.id);
  const task = settings.statusTasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Estado no encontrado' });

  const instance = require('../core/manager').instances.get(req.user.id);
  if (!instance || !instance.isConnected) {
    return res.status(400).json({ error: 'WhatsApp no conectado' });
  }

  try {
    const msg = task.mediaUrl
      ? { image: { url: task.mediaUrl }, caption: task.message }
      : { text: task.message };
    await instance.sock.sendMessage('status@broadcast', msg);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

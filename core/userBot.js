const { getSettings } = require('../utils/db');

const TIMEZONE = 'America/Havana';

function getHourInHavana() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  let hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  if (hour === 24) hour = 0;
  return hour;
}

function createUserBot(userId, sock) {

  async function handleMessages(messages) {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const messageContent =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text || '';

    console.log(`[User ${userId}] Mensaje de ${sender}: ${messageContent}`);

    // Auto-reply solo para mensajes privados
    if (sender.endsWith('@g.us')) return;

    const settings = await getSettings(userId);
    if (!settings) return;

    const autoReply = settings.autoReply;

    if (autoReply?.active) {
      const currentHour = getHourInHavana();
      let startHour = autoReply.startHour ?? 22;
      let endHour = autoReply.endHour ?? 8;
      // Tratar 24 como 0
      if (startHour === 24) startHour = 0;
      if (endHour === 24) endHour = 0;

      const withinHours =
        startHour > endHour
          ? currentHour >= startHour || currentHour < endHour
          : currentHour >= startHour && currentHour < endHour;

      if (withinHours) {
        try {
          if (autoReply.mediaUrl) {
            await sock.sendMessage(sender, {
              image: { url: autoReply.mediaUrl },
              caption: autoReply.text || ''
            });
          } else {
            await sock.sendMessage(sender, { text: autoReply.text });
          }
        } catch (e) {
          console.error(`[User ${userId}] Error en auto-reply:`, e.message);
        }
      }
    }

    if (messageContent.toLowerCase() === '!ping') {
      await sock.sendMessage(sender, { text: 'pong' });
    }
  }

  return { handleMessages };
}

module.exports = { createUserBot };

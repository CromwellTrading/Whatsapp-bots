// Este adaptador ha sido reemplazado por el uso de archivos locales (useMultiFileAuthState).
// Se mantiene solo para evitar errores de importación en otros módulos.
const { initAuthCreds } = require('@whiskeysockets/baileys');

async function createSupabaseAuthAdapter(userId) {
  throw new Error('createSupabaseAuthAdapter ya no se usa. Se emplea useMultiFileAuthState en manager.js.');
}

module.exports = { createSupabaseAuthAdapter };

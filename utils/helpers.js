/**
 * Limpia un número de teléfono para formato E.164 internacional
 * @param {string} phone - Número con o sin '+'
 * @returns {string} Número limpio (solo dígitos)
 */
function cleanPhoneNumber(phone) {
  return phone.replace(/\D/g, '');
}

/**
 * Valida si un string es un número de teléfono válido (mínimo 7 dígitos)
 * @param {string} phone 
 * @returns {boolean}
 */
function isValidPhoneNumber(phone) {
  const cleaned = cleanPhoneNumber(phone);
  return cleaned.length >= 7 && cleaned.length <= 15;
}

/**
 * Formatea un número para mostrarlo (añade + si no lo tiene)
 * @param {string} phone 
 * @returns {string}
 */
function formatPhoneForDisplay(phone) {
  const cleaned = cleanPhoneNumber(phone);
  return '+' + cleaned;
}

/**
 * Convierte una expresión cron simple a formato estándar
 * Soporta: "daily at 14:30" -> "30 14 * * *"
 * @param {string} simpleCron 
 * @returns {string}
 */
function parseSimpleCron(simpleCron) {
  // Esta es una función placeholder; puedes expandirla según necesites
  const match = simpleCron.match(/daily at (\d{1,2}):(\d{2})/i);
  if (match) {
    const hour = match[1].padStart(2, '0');
    const minute = match[2];
    return `${minute} ${hour} * * *`;
  }
  return simpleCron; // Asume que ya es válido
}

/**
 * Espera un tiempo determinado (promesa)
 * @param {number} ms - Milisegundos
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  cleanPhoneNumber,
  isValidPhoneNumber,
  formatPhoneForDisplay,
  parseSimpleCron,
  sleep
};

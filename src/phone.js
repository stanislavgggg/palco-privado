// Phone normalization to E.164. Spanish numbers without a prefix get +34.
function normalizePhone(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  s = s.replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^[6789]\d{8}$/.test(s)) s = '+34' + s; // bare Spanish number
  if (/^34[6789]\d{8}$/.test(s)) s = '+' + s;
  if (!s.startsWith('+')) s = '+' + s; // Telegram contacts come without "+"
  if (!/^\+[1-9]\d{7,14}$/.test(s)) return null;
  return s;
}

const isSpanishMobile = (e164) => /^\+34[67]\d{8}$/.test(String(e164 || ''));

// Looks like the user tried to type a number (to decide whether to answer "invalid").
const looksLikePhone = (text) => /^[+\d][\d\s\-().]{6,}$/.test(String(text || '').trim());

module.exports = { normalizePhone, isSpanishMobile, looksLikePhone };

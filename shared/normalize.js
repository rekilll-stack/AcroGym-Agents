'use strict';

/**
 * Normalizes a Qatar phone number to a consistent digits-only format.
 * Output format: "974XXXXXXXX" for local numbers, raw digits for international.
 *
 * @param {string|null} raw
 * @returns {string|null}
 */
function normalizePhone(raw) {
  if (!raw) return null;
  // 27.08.2026: восточно-арабские (٠-٩) и персидские (۰-۹) цифры транслитерируем в ASCII —
  // клиенты Катара так вводят номера; \D их выбрасывал и лид терялся (кейс Heba Badr).
  // KEEP IN SYNC с нодой «Validate token + normalize» n8n website-workflow.
  const s = String(raw)
    .replace(/[\u0660-\u0669]/g, (ch) => String(ch.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (ch) => String(ch.charCodeAt(0) - 0x06F0));
  let digits = s.replace(/\D/g, '');
  if (!digits) return null;

  // Remove leading zeros
  digits = digits.replace(/^0+/, '');
  if (!digits) return null;

  // Already has Qatar country code and full length
  if (digits.startsWith('974') && digits.length >= 11) return digits;

  // 8-digit local Qatar number — prepend country code
  if (digits.length === 8) return '974' + digits;

  // International number or other format — return as-is
  return digits;
}

/**
 * Normalizes email to lowercase trimmed string.
 *
 * @param {string|null} raw
 * @returns {string|null}
 */
function normalizeEmail(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.trim().toLowerCase();
  return cleaned || null;
}

module.exports = { normalizePhone, normalizeEmail };

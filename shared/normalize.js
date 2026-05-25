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
  let digits = String(raw).replace(/\D/g, '');
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

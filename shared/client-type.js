'use strict';

const { createLogger } = require('./logger');
const logger = createLogger('client-type');

const RULES = [
  {
    type: 'new',
    keywords: ['new client', 'новый клиент', 'جديد', 'new registration', 'first time'],
  },
  {
    type: 'existing',
    keywords: ['existing', 'уже', 'حالي', 'current member', 'already registered'],
  },
  {
    type: 'returning',
    keywords: ['returning', 'возвращ', 'سابق', 'come back', 'was with us'],
  },
];

/**
 * Определяет тип клиента по сырому значению из Google Sheets.
 *
 * @param {string} rawValue
 * @returns {'new'|'existing'|'returning'|'unknown'}
 */
function parseClientType(rawValue) {
  if (!rawValue || typeof rawValue !== 'string' || rawValue.trim() === '') {
    return 'unknown';
  }

  const lower = rawValue.toLowerCase().trim();

  for (const { type, keywords } of RULES) {
    if (keywords.some(kw => lower.includes(kw))) {
      return type;
    }
  }

  logger.warn({ rawValue }, 'client_type не распознан, устанавливаем unknown');
  return 'unknown';
}

module.exports = { parseClientType };

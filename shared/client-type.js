'use strict';

const { createLogger } = require('./logger');
const logger = createLogger('client-type');

/**
 * Parses client type from Google Sheets raw value.
 * Matches by emoji prefix — stable anchor regardless of text wording changes.
 *
 * Expected values:
 *   "🆕 New client – I want to register for classes"     → 'new'
 *   "✅ Existing member – signing T&C"                   → 'existing'
 *   "↩️ Returning client – was here before, coming back" → 'returning'
 *
 * @param {string} raw
 * @returns {'new'|'existing'|'returning'|'unknown'}
 */
function parseClientType(raw) {
  if (!raw || typeof raw !== 'string') return 'unknown';
  const trimmed = raw.trim();
  if (trimmed.startsWith('🆕')) return 'new';
  if (trimmed.startsWith('✅')) return 'existing';
  if (trimmed.startsWith('↩️')) return 'returning';
  logger.warn({ raw }, 'Unrecognized client_type value');
  return 'unknown';
}

module.exports = { parseClientType };

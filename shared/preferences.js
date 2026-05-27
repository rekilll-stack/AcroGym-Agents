'use strict';

/**
 * shared/preferences.js — per-chat language preferences.
 *
 * Stored in `user_preferences` table (created by db.js migration v15).
 * Values: 'en' | 'ru' | 'both' | null (not yet set).
 */

const { getDb }        = require('./db');
const { createLogger } = require('./logger');

const logger = createLogger('preferences');

/**
 * Get the preferred language for a Telegram chat_id.
 * Returns null when the owner has not yet chosen a language.
 *
 * @param {number} chatId
 * @returns {'en'|'ru'|'both'|null}
 */
function getPreferredLanguage(chatId) {
  try {
    const row = getDb()
      .prepare('SELECT preferred_language FROM user_preferences WHERE chat_id = ?')
      .get(chatId);
    return row?.preferred_language ?? null;
  } catch (err) {
    logger.warn({ err }, 'getPreferredLanguage failed');
    return null;
  }
}

/**
 * Persist the preferred language for a Telegram chat_id.
 *
 * @param {number} chatId
 * @param {'en'|'ru'|'both'} lang
 */
function setPreferredLanguage(chatId, lang) {
  try {
    getDb().prepare(`
      INSERT INTO user_preferences (chat_id, preferred_language, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(chat_id) DO UPDATE SET
        preferred_language = excluded.preferred_language,
        updated_at         = excluded.updated_at
    `).run(chatId, lang);
  } catch (err) {
    logger.warn({ err }, 'setPreferredLanguage failed');
  }
}

module.exports = { getPreferredLanguage, setPreferredLanguage };

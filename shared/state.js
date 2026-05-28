'use strict';

/**
 * shared/state.js — multi-step conversation state (SQLite).
 *
 * Persists across pm2 restarts. GC removes states older than 1 hour.
 * Timeout check (5 min) is done in the callback/text handlers.
 */

const { getDb }        = require('./db');
const { createLogger } = require('./logger');

const logger = createLogger('state');

/**
 * Upsert state for a chat.
 * @param {number} chatId
 * @param {string} action   — e.g. 'export'
 * @param {string} step     — e.g. 'period' | 'lang' | 'format'
 * @param {object} [params] — arbitrary key-value params
 */
function setState(chatId, action, step, params = {}) {
  try {
    getDb().prepare(`
      INSERT INTO user_state (chat_id, current_action, current_step, params_json, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(chat_id) DO UPDATE SET
        current_action = excluded.current_action,
        current_step   = excluded.current_step,
        params_json    = excluded.params_json,
        updated_at     = excluded.updated_at
    `).run(chatId, action, step, JSON.stringify(params));
  } catch (err) {
    logger.warn({ err }, 'setState failed');
  }
}

/**
 * Get current state for a chat.
 * @param {number} chatId
 * @returns {{ action, step, params, updated_at } | null}
 */
function getState(chatId) {
  try {
    const row = getDb()
      .prepare('SELECT * FROM user_state WHERE chat_id = ?')
      .get(chatId);
    if (!row) return null;
    return {
      action:     row.current_action,
      step:       row.current_step,
      params:     JSON.parse(row.params_json || '{}'),
      updated_at: row.updated_at,
    };
  } catch (err) {
    logger.warn({ err }, 'getState failed');
    return null;
  }
}

/**
 * Merge partialParams into existing params, touch updated_at.
 * @param {number} chatId
 * @param {object} partialParams
 */
function updateParams(chatId, partialParams) {
  try {
    const current = getState(chatId);
    const merged  = { ...(current?.params || {}), ...partialParams };
    getDb().prepare(`
      UPDATE user_state
      SET params_json = ?, updated_at = datetime('now')
      WHERE chat_id = ?
    `).run(JSON.stringify(merged), chatId);
  } catch (err) {
    logger.warn({ err }, 'updateParams failed');
  }
}

/**
 * Update only the step field (keeps params, touches updated_at).
 * @param {number} chatId
 * @param {string} step
 */
function setStep(chatId, step) {
  try {
    getDb().prepare(`
      UPDATE user_state
      SET current_step = ?, updated_at = datetime('now')
      WHERE chat_id = ?
    `).run(step, chatId);
  } catch (err) {
    logger.warn({ err }, 'setStep failed');
  }
}

/**
 * Delete state for a chat (end of flow or cancel).
 * @param {number} chatId
 */
function clearState(chatId) {
  try {
    getDb().prepare('DELETE FROM user_state WHERE chat_id = ?').run(chatId);
  } catch (err) {
    logger.warn({ err }, 'clearState failed');
  }
}

/**
 * Remove states not updated for over 1 hour. Called every 10 min.
 */
function gcExpiredStates() {
  try {
    const res = getDb()
      .prepare(`DELETE FROM user_state WHERE updated_at < datetime('now', '-1 hour')`)
      .run();
    if (res.changes > 0) {
      logger.info({ removed: res.changes }, 'GC: expired export states removed');
    }
  } catch (err) {
    logger.warn({ err }, 'gcExpiredStates failed');
  }
}

/**
 * Returns true if state is older than 5 minutes (session timeout for active steps).
 * @param {{ updated_at: string } | null} state
 * @returns {boolean}
 */
function isExpired(state) {
  if (!state?.updated_at) return true;
  const updatedMs = new Date(state.updated_at + 'Z').getTime(); // SQLite datetime is UTC
  return Date.now() - updatedMs > 5 * 60 * 1000;
}

module.exports = { setState, getState, updateParams, setStep, clearState, gcExpiredStates, isExpired };

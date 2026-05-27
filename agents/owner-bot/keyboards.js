'use strict';

/**
 * keyboards.js — shared inline keyboard builders for owner-bot.
 *
 * Centralises "Back to menu" and lang-picker keyboards so they stay
 * consistent across commands, schedulers, and callbacks.
 */

const { t } = require('../../shared/i18n');

// ─────────────────────────────────────────────────────────────
// Back-to-menu keyboard (single-row, single button)
// ─────────────────────────────────────────────────────────────

/** Inline keyboard with one "⬅ Back to menu" button. */
const BACK_KB = {
  inline_keyboard: [[
    { text: t('common.back_to_menu', 'en'), callback_data: 'menu:back' },
  ]],
};

// ─────────────────────────────────────────────────────────────
// Language picker keyboards
// ─────────────────────────────────────────────────────────────

/**
 * Lang picker for initial selection (no pref set yet).
 * Pressing a lang button triggers lang_init:<lang>:<action>.
 * Includes a "Back to menu" cancel row.
 *
 * @param {string} action  — 'yesterday' | 'week' | 'month' | 'pending'
 */
function langInitKeyboard(action) {
  return {
    inline_keyboard: [
      [
        { text: '🇬🇧 English', callback_data: `lang_init:en:${action}`   },
        { text: '🇷🇺 Русский', callback_data: `lang_init:ru:${action}`   },
        { text: '🌐 Both',     callback_data: `lang_init:both:${action}` },
      ],
      [{ text: t('common.back_to_menu', 'en'), callback_data: 'menu:back' }],
    ],
  };
}

/**
 * Lang picker for changing preference (/lang command or menu:lang button).
 * Pressing a lang button triggers lang_change:<lang>.
 * Includes a "Back to menu" cancel row.
 */
function langChangeKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🇬🇧 English', callback_data: 'lang_change:en'   },
        { text: '🇷🇺 Русский', callback_data: 'lang_change:ru'   },
        { text: '🌐 Both',     callback_data: 'lang_change:both' },
      ],
      [{ text: t('common.back_to_menu', 'en'), callback_data: 'menu:back' }],
    ],
  };
}

module.exports = { BACK_KB, langInitKeyboard, langChangeKeyboard };

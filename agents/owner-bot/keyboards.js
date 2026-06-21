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

/**
 * Inline keyboard with one language-aware "⬅ Back to menu" button.
 * @param {string} lang  — 'en' | 'ru' | 'both' | null ; anything but 'ru' → 'en'.
 */
function backKeyboard(lang = 'en') {
  const L = lang === 'ru' ? 'ru' : 'en'; // 'both'/null/unknown → en (neutral)
  return { inline_keyboard: [[{ text: t('common.back_to_menu', L), callback_data: 'menu:back' }]] };
}

/**
 * Persistent bottom button "☰ Main menu" — a reply keyboard that stays above the
 * input. Tapping it sends the button text, which the owner-bot maps to the menu
 * toggle (open / hide the inline console).
 */
function persistentMenuKeyboard(lang = 'en') {
  const L = lang === 'ru' ? 'ru' : 'en';
  return { keyboard: [[{ text: t('menu.persistent_btn', L) }]], resize_keyboard: true, is_persistent: true };
}

/** The exact button labels (both languages) — used to recognise a tap. */
function persistentMenuLabels() {
  return [t('menu.persistent_btn', 'en'), t('menu.persistent_btn', 'ru')];
}

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

module.exports = { backKeyboard, persistentMenuKeyboard, persistentMenuLabels, langInitKeyboard, langChangeKeyboard };

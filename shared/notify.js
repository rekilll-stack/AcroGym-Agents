'use strict';

/**
 * Абстракция канала уведомлений для владельца.
 *
 * Сейчас использует Telegram. В будущем можно переключить
 * часть уведомлений на WhatsApp Cloud API — менять только этот файл.
 */

const telegram = require('./telegram');

/**
 * Отправляет уведомление владельцу через активный канал (Telegram).
 *
 * @param {string} text
 * @param {object} [options]  - { reply_markup, parse_mode, ... }
 * @returns {Promise<object|null>}
 */
async function sendToOwner(text, options = {}) {
  return telegram.sendMessage(text, options);
}

module.exports = { sendToOwner };

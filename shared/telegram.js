'use strict';

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { createLogger } = require('./logger');

const logger = createLogger('telegram');

let _bot = null;

function getBot() {
  if (_bot) return _bot;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан в .env');
  // polling: false — бот только отправляет, не слушает (слушает агент отдельно)
  _bot = new TelegramBot(token, { polling: false });
  return _bot;
}

/**
 * Отправляет сообщение владельцу (OWNER_CHAT_ID из .env).
 *
 * @param {string} text        - текст сообщения (поддерживает HTML)
 * @param {object} [options]   - доп. параметры для sendMessage (inline_keyboard и т.д.)
 * @returns {Promise<object|null>} - объект сообщения или null при ошибке
 */
async function sendMessage(text, options = {}) {
  const chatId = process.env.OWNER_CHAT_ID;
  if (!chatId) {
    logger.warn('OWNER_CHAT_ID не задан — сообщение не отправлено');
    return null;
  }
  return _sendToChatId(chatId, text, options);
}

/**
 * Отправляет сообщение в произвольный chat_id.
 */
async function sendToChatId(chatId, text, options = {}) {
  return _sendToChatId(chatId, text, options);
}

async function _sendToChatId(chatId, text, options = {}) {
  const defaultOptions = { parse_mode: 'HTML' };
  const mergedOptions = { ...defaultOptions, ...options };

  try {
    const bot = getBot();
    const msg = await bot.sendMessage(chatId, text, mergedOptions);
    logger.debug({ chatId, msgId: msg.message_id }, 'Сообщение отправлено');
    return msg;
  } catch (err) {
    logger.error({ err, chatId }, 'Ошибка отправки Telegram-сообщения');
    return null;
  }
}

/**
 * Редактирует существующее сообщение.
 */
async function editMessage(chatId, messageId, text, options = {}) {
  try {
    const bot = getBot();
    return await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      ...options,
    });
  } catch (err) {
    logger.error({ err, chatId, messageId }, 'Ошибка редактирования сообщения');
    return null;
  }
}

/**
 * Регистрирует обработчик callback_query (inline-кнопки).
 * Вызывается один раз при старте агента.
 */
function onCallbackQuery(handler) {
  try {
    // Для callback нужен polling
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return;

    // Создаём отдельный экземпляр с polling только для callbacks
    const pollingBot = new TelegramBot(token, { polling: true });
    pollingBot.on('callback_query', handler);
    pollingBot.on('polling_error', (err) => {
      logger.error({ err }, 'Telegram polling error');
    });
    return pollingBot;
  } catch (err) {
    logger.error({ err }, 'Ошибка запуска polling для callbacks');
  }
}

module.exports = { sendMessage, sendToChatId, editMessage, onCallbackQuery, getBot };

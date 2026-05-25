'use strict';

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { createLogger } = require('./logger');

const logger = createLogger('telegram');

// ─────────────────────────────────────────────────────────────
// Инициализация ботов (lazy, с кэшем)
// ─────────────────────────────────────────────────────────────

let _adminBot  = null;
let _ownerBot  = null;
let _pollingBot = null; // единый бот для приёма callbacks

function getAdminBot() {
  if (_adminBot) return _adminBot;
  const token = process.env.ADMIN_BOT_TOKEN;
  if (!token) throw new Error('ADMIN_BOT_TOKEN не задан в .env');
  _adminBot = new TelegramBot(token, { polling: false });
  return _adminBot;
}

function getOwnerBot() {
  if (_ownerBot) return _ownerBot;
  const token = process.env.OWNER_BOT_TOKEN;
  if (!token) throw new Error('OWNER_BOT_TOKEN не задан в .env');
  _ownerBot = new TelegramBot(token, { polling: false });
  return _ownerBot;
}

// Парсим "216299177,123456" → ['216299177', '123456']
function parseChatIds(envVar) {
  return (process.env[envVar] || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────
// Базовая отправка
// ─────────────────────────────────────────────────────────────

async function _send(bot, chatIds, text, options = {}) {
  const defaultOptions = { parse_mode: 'HTML' };
  const merged = { ...defaultOptions, ...options };
  const results = [];

  for (const chatId of chatIds) {
    try {
      const msg = await bot.sendMessage(chatId, text, merged);
      logger.debug({ chatId, msgId: msg.message_id }, 'Сообщение отправлено');
      results.push(msg);
    } catch (err) {
      logger.error({ err, chatId }, 'Ошибка отправки сообщения');
      // Не падаем — продолжаем остальных получателей
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────
// Публичный API
// ─────────────────────────────────────────────────────────────

/**
 * Отправляет оперативные уведомления (карточки лидов, напоминания)
 * всем получателям из ADMIN_CHAT_IDS через ADMIN_BOT_TOKEN.
 */
async function sendToAdmin(text, options = {}) {
  const chatIds = parseChatIds('ADMIN_CHAT_IDS');
  if (!chatIds.length) {
    logger.warn('ADMIN_CHAT_IDS не задан — сообщение не отправлено');
    return [];
  }
  return _send(getAdminBot(), chatIds, text, options);
}

/**
 * Отправляет стратегические/аналитические сообщения (дайджест, метрики)
 * всем получателям из OWNER_CHAT_IDS через OWNER_BOT_TOKEN.
 */
async function sendToOwner(text, options = {}) {
  const chatIds = parseChatIds('OWNER_CHAT_IDS');
  if (!chatIds.length) {
    logger.warn('OWNER_CHAT_IDS не задан — сообщение не отправлено');
    return [];
  }
  return _send(getOwnerBot(), chatIds, text, options);
}

/**
 * Редактирует существующее сообщение.
 * bot — 'admin' | 'owner'
 */
async function editMessage(bot, chatId, messageId, text, options = {}) {
  try {
    const instance = bot === 'owner' ? getOwnerBot() : getAdminBot();
    return await instance.editMessageText(text, {
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

// ─────────────────────────────────────────────────────────────
// Callback-handler (inline-кнопки)
// ─────────────────────────────────────────────────────────────

// Реестр: prefix → handler
const _callbackHandlers = new Map();

/**
 * Регистрирует обработчик для callback_data по префиксу.
 * Пример: registerCallback('responded', async (query) => { ... })
 *
 * @param {string} prefix
 * @param {Function} handler
 */
function registerCallback(prefix, handler) {
  _callbackHandlers.set(prefix, handler);
  logger.debug({ prefix }, 'Callback handler зарегистрирован');
}

/**
 * Запускает polling на ADMIN_BOT для приёма callback_query.
 * Вызывать один раз при старте агента.
 */
function startCallbackPolling() {
  try {
    const token = process.env.ADMIN_BOT_TOKEN;
    if (!token) return;

    _pollingBot = new TelegramBot(token, { polling: true });

    _pollingBot.on('callback_query', async (query) => {
      const data = query.data || '';
      const prefix = data.split(':')[0];
      const handler = _callbackHandlers.get(prefix);

      if (!handler) return;

      try {
        await handler(query, _pollingBot);
      } catch (err) {
        logger.error({ err, data }, 'Ошибка в callback handler');
      }
    });

    _pollingBot.on('polling_error', (err) => {
      logger.error({ err }, 'Telegram polling error');
    });

    logger.info('Callback polling запущен (ADMIN_BOT)');
    return _pollingBot;
  } catch (err) {
    logger.error({ err }, 'Не удалось запустить callback polling');
  }
}

module.exports = {
  sendToAdmin,
  sendToOwner,
  editMessage,
  registerCallback,
  startCallbackPolling,
};

'use strict';

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { createLogger } = require('./logger');

const logger = createLogger('telegram');

// ─────────────────────────────────────────────────────────────
// MarkdownV2 escape helper
// Экранирует все специальные символы Telegram MarkdownV2:
// _ * [ ] ( ) ~ ` > # + - = | { } . !  и  \
// Используйте для ДИНАМИЧЕСКИХ значений (имена, телефоны, числа).
// Статические строки из словаря не требуют экранирования —
// они уже написаны с учётом MarkdownV2.
// ─────────────────────────────────────────────────────────────
function escapeMd(text) {
  return String(text ?? '').replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

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
      // Если упал с ошибкой парсинга — логируем полный текст для диагностики
      const isParseError = err?.message && (
        err.message.includes('can\'t parse entities') ||
        err.message.includes('Bad Request') ||
        err.message.includes('parse')
      );
      if (isParseError) {
        logger.error({ err, chatId, parse_mode: merged.parse_mode, text }, 'Parse error: Telegram rejected message — check MarkdownV2 escaping');
      } else {
        logger.error({ err, chatId }, 'Ошибка отправки сообщения');
      }
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
 * parse_mode по умолчанию: MarkdownV2 (все строки Owner bot написаны для MDv2).
 */
async function sendToOwner(text, options = {}) {
  const chatIds = parseChatIds('OWNER_CHAT_IDS');
  if (!chatIds.length) {
    logger.warn('OWNER_CHAT_IDS не задан — сообщение не отправлено');
    return [];
  }
  return _send(getOwnerBot(), chatIds, text, { parse_mode: 'MarkdownV2', ...options });
}

/**
 * Редактирует существующее сообщение.
 * bot — 'admin' | 'owner'
 */
async function editMessage(bot, chatId, messageId, text, options = {}) {
  try {
    const instance = bot === 'owner' ? getOwnerBot() : getAdminBot();
    // Owner bot messages use MarkdownV2; admin bot uses HTML
    const defaultMode = bot === 'owner' ? 'MarkdownV2' : 'HTML';
    return await instance.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: defaultMode,
      ...options,
    });
  } catch (err) {
    logger.error({ err, chatId, messageId }, 'Ошибка редактирования сообщения');
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Фото / медиа
// ─────────────────────────────────────────────────────────────

/**
 * Отправляет PNG-картинку всем получателям из OWNER_CHAT_IDS через OWNER_BOT.
 * @param {Buffer} buffer  — PNG-буфер
 * @param {string} [caption]
 * @param {object} [options]  — поддерживает reply_markup
 */
async function sendPhotoToOwner(buffer, caption, options = {}) {
  const chatIds = parseChatIds('OWNER_CHAT_IDS');
  if (!chatIds.length) {
    logger.warn('OWNER_CHAT_IDS не задан — фото не отправлено');
    return [];
  }

  const bot     = getOwnerBot();
  const results = [];

  for (const chatId of chatIds) {
    try {
      const opts = { parse_mode: 'MarkdownV2', ...options };
      if (caption) opts.caption = caption;
      const msg = await bot.sendPhoto(chatId, buffer, opts);
      results.push(msg);
    } catch (err) {
      logger.error({ err, chatId }, 'Ошибка отправки фото');
    }
  }

  return results;
}

/**
 * Отправляет несколько PNG-картинок последовательно всем OWNER_CHAT_IDS.
 * (Telegram Media Group с Buffer требует form-data; используем последовательные sendPhoto.)
 *
 * @param {Buffer[]} buffers  — массив PNG-буферов
 * @param {string}   [caption]  — подпись к первому фото
 */
async function sendMediaGroupToOwner(buffers, caption) {
  const chatIds = parseChatIds('OWNER_CHAT_IDS');
  if (!chatIds.length) return;

  const bot = getOwnerBot();

  for (const chatId of chatIds) {
    for (let i = 0; i < buffers.length; i++) {
      try {
        const opts = { parse_mode: 'MarkdownV2' };
        if (i === 0 && caption) opts.caption = caption;
        await bot.sendPhoto(chatId, buffers[i], opts);
        // небольшая пауза между фото, чтобы Telegram не считал их как альбом
        if (i < buffers.length - 1) await new Promise(r => setTimeout(r, 400));
      } catch (err) {
        logger.error({ err, chatId, photoIndex: i }, 'Ошибка отправки фото в медиа-группе');
      }
    }
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

// ─────────────────────────────────────────────────────────────
// Owner Bot — команды и callback'и от дайджеста
// ─────────────────────────────────────────────────────────────

let _ownerPollingBot = null;
const _ownerCallbackHandlers = new Map(); // prefix → handler
const _ownerCommandHandlers  = new Map(); // '/command' → handler
let   _ownerTextHandler      = null;      // single handler for plain-text input

// Owner polling-error telemetry — surfaced in owner-bot heartbeat detail so the
// watchdog can tell "loop alive + Telegram reachable" (getMe ok) apart from
// "updates not actually arriving" (polling errors piling up).
const _ownerPollErr = { count: 0, lastAt: null };

/** @returns {{count:number, lastAt:number|null}} */
function getOwnerPollingErrorStats() {
  return { count: _ownerPollErr.count, lastAt: _ownerPollErr.lastAt };
}

/**
 * Регистрирует обработчик callback_query для OWNER_BOT.
 * @param {string}   prefix   — например 'mark_responded', 'copy_text'
 * @param {Function} handler  — async (query, bot) => {}
 */
function registerOwnerCallback(prefix, handler) {
  _ownerCallbackHandlers.set(prefix, handler);
  logger.debug({ prefix }, 'Owner callback handler зарегистрирован');
}

/**
 * Регистрирует обработчик текстовой команды для OWNER_BOT.
 * @param {string}   command  — например '/yesterday', '/week'
 * @param {Function} handler  — async (msg, bot) => {}
 */
function registerOwnerCommand(command, handler) {
  _ownerCommandHandlers.set(command.toLowerCase(), handler);
  logger.debug({ command }, 'Owner command handler зарегистрирован');
}

/**
 * Регистрирует обработчик ТЕКСТОВЫХ сообщений (не команд) от OWNER_CHAT_IDS.
 * Используется для ввода дат в /export flow.
 * @param {Function} handler — async (msg, bot) => {}
 */
function registerOwnerTextHandler(handler) {
  _ownerTextHandler = handler;
  logger.debug('Owner text handler зарегистрирован');
}

/**
 * Запускает polling на OWNER_BOT для приёма:
 *  - текстовых команд (/yesterday, /week, etc.)
 *  - callback_query от inline-кнопок дайджеста
 *
 * Отвечает ТОЛЬКО на сообщения из OWNER_CHAT_IDS.
 */
function startOwnerPolling() {
  try {
    const token = process.env.OWNER_BOT_TOKEN;
    if (!token) { logger.warn('OWNER_BOT_TOKEN не задан — owner polling не запущен'); return; }

    const ownerChatIds = parseChatIds('OWNER_CHAT_IDS');

    _ownerPollingBot = new TelegramBot(token, { polling: true });

    // Текстовые сообщения (команды + plain text для /export flow)
    _ownerPollingBot.on('message', async (msg) => {
      const text   = (msg.text || '').trim();
      const chatId = String(msg.chat.id);

      if (!ownerChatIds.includes(chatId)) {
        logger.warn({ chatId, text }, 'Owner bot: сообщение от неизвестного чата — игнор');
        return;
      }

      if (text.startsWith('/')) {
        // Slash-команда
        const command = text.split(' ')[0].split('@')[0].toLowerCase();
        const handler = _ownerCommandHandlers.get(command);
        if (!handler) return;
        try {
          await handler(msg, _ownerPollingBot);
        } catch (err) {
          logger.error({ err, command }, 'Ошибка в owner command handler');
        }
      } else if (_ownerTextHandler) {
        // Plain text — передаём в зарегистрированный text handler (для ввода дат)
        try {
          await _ownerTextHandler(msg, _ownerPollingBot);
        } catch (err) {
          logger.error({ err }, 'Ошибка в owner text handler');
        }
      }
    });

    // Callback'и от inline-кнопок (digest-карточки)
    _ownerPollingBot.on('callback_query', async (query) => {
      const data   = query.data || '';
      const prefix = data.split(':')[0];
      console.log('[CALLBACK] received:', JSON.stringify(data), '| prefix:', prefix, '| from:', query.from.id);

      const chatId = String(query.from.id);
      if (!ownerChatIds.includes(chatId)) {
        console.log('[CALLBACK] REJECTED — not owner. chatId:', chatId, '| ownerChatIds:', JSON.stringify(ownerChatIds));
        logger.warn({ chatId }, 'Owner bot: callback от неизвестного чата — игнор');
        return;
      }

      const handler = _ownerCallbackHandlers.get(prefix);
      console.log('[CALLBACK] handler for prefix', JSON.stringify(prefix), ':', handler ? 'FOUND' : 'NOT FOUND',
        '| registered prefixes:', JSON.stringify([..._ownerCallbackHandlers.keys()]));

      if (!handler) {
        await _ownerPollingBot.answerCallbackQuery(query.id).catch(() => {});
        return;
      }

      try {
        await handler(query, _ownerPollingBot);
        console.log('[CALLBACK] handler completed for', JSON.stringify(data));
      } catch (err) {
        console.error('[CALLBACK] handler ERROR for', JSON.stringify(data), ':', err.message);
        logger.error({ err, data }, 'Ошибка в owner callback handler');
        await _ownerPollingBot.answerCallbackQuery(query.id, { text: '❌ Error' }).catch(() => {});
      }
    });

    _ownerPollingBot.on('polling_error', (err) => {
      _ownerPollErr.count += 1;
      _ownerPollErr.lastAt = Date.now();
      logger.error({ err }, 'Owner bot polling error');
    });

    logger.info('Owner bot polling запущен (OWNER_BOT)');
    return _ownerPollingBot;
  } catch (err) {
    logger.error({ err }, 'Не удалось запустить owner polling');
  }
}

// ─────────────────────────────────────────────────────────────
// sendDocumentToOwner — отправка PDF/файлов владельцу
// ─────────────────────────────────────────────────────────────

const https = require('https');

/**
 * Отправляет документ (Buffer) всем получателям из OWNER_CHAT_IDS.
 *
 * @param {Buffer} buffer        — содержимое файла
 * @param {string} filename      — имя файла (с расширением)
 * @param {string} [caption]     — подпись (MarkdownV2)
 * @param {object} [options]     — { reply_markup, parse_mode }
 */
async function sendDocumentToOwner(buffer, filename, caption, options = {}) {
  const chatIds = parseChatIds('OWNER_CHAT_IDS');
  if (!chatIds.length) {
    logger.warn('OWNER_CHAT_IDS не задан — документ не отправлен');
    return;
  }

  const token = process.env.OWNER_BOT_TOKEN;
  if (!token) { logger.warn('OWNER_BOT_TOKEN не задан — документ не отправлен'); return; }

  // 50 MB limit check
  const MAX_BYTES = 50 * 1024 * 1024;
  if (buffer.length > MAX_BYTES) {
    logger.error({ size: buffer.length, filename }, 'sendDocumentToOwner: file too large (>50 MB)');
    await sendToOwner(`❌ File too large to send\\. Saved on server\\.`).catch(() => {});
    return;
  }

  const results = [];

  for (const chatId of chatIds) {
    try {
      const boundary = '----AcroGymBoundary' + Date.now();
      const parts    = [];

      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`
      ));
      if (caption) {
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`
        ));
        // Default stays MarkdownV2 for existing callers; pass parse_mode:null
        // (or '') to send the caption as plain text with no parser at all.
        const pm = 'parse_mode' in options ? options.parse_mode : 'MarkdownV2';
        if (pm) {
          parts.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\n${pm}\r\n`
          ));
        }
      }
      if (options.reply_markup) {
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="reply_markup"\r\n\r\n${JSON.stringify(options.reply_markup)}\r\n`
        ));
      }
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
      ));
      parts.push(buffer);
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

      const body = Buffer.concat(parts);

      const result = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.telegram.org',
          path:     `/bot${token}/sendDocument`,
          method:   'POST',
          headers:  {
            'Content-Type':   `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
        }, res => {
          let data = '';
          res.on('data', d => data += d);
          res.on('end', () => {
            try {
              const j = JSON.parse(data);
              if (j.ok) resolve(j.result);
              else reject(new Error(`Telegram API error: ${JSON.stringify(j)}`));
            } catch (e) { reject(e); }
          });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      results.push(result);
      logger.debug({ chatId, filename }, 'Document sent');
    } catch (err) {
      logger.error({ err, chatId, filename }, 'sendDocumentToOwner failed');
    }
  }

  return results;
}

module.exports = {
  escapeMd,
  sendToAdmin,
  sendToOwner,
  sendPhotoToOwner,
  sendMediaGroupToOwner,
  sendDocumentToOwner,
  editMessage,
  registerCallback,
  startCallbackPolling,
  registerOwnerCallback,
  registerOwnerCommand,
  registerOwnerTextHandler,
  startOwnerPolling,
  getOwnerPollingErrorStats,
};

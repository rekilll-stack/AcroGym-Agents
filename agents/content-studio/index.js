'use strict';
/**
 * Content Studio — Telegram-обвязка мульти-агентной студии.
 *
 * 6 ботов (по роли) в общей группе. Владелец кидает тему командой
 * `/студия <тема>` (или /studio, /пост, /post) → команда обсуждает вживую
 * (каждая реплика от своего бота), в конце Модератор даёт финальное
 * предложение с кнопками ✅ Делаем / ↩️ Переделать. По ✅ концепт уходит
 * в очередь на сборку content-bot (data/studio-approved.jsonl).
 *
 * LLM — через подписочный шим (Sonnet, $0 API), см. studio.js.
 *
 * Токены: config/studio-bots.json = { moderator, smm, photo, copy, critic, audience }.
 * Если файла/токенов нет — процесс живёт и раз в 60с перечитывает конфиг;
 * как только токены появятся, студия сама активируется (без рестарта).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const { createLogger } = require('../../shared/logger');
const { PERSONAS } = require('./personas');
const { runSession } = require('./studio');

const logger = createLogger('content-studio');

const CFG_PATH = path.join(__dirname, '../../config/studio-bots.json');
const APPROVED_LOG = path.join(__dirname, '../../data/studio-approved.jsonl');
const ROLE_KEYS = ['moderator', 'smm', 'photo', 'copy', 'critic', 'audience'];

const OWNER_IDS = String(process.env.OWNER_CHAT_IDS || '216299177')
  .split(',').map((s) => Number(s.trim())).filter(Boolean);

function isOwner(id) { return OWNER_IDS.includes(Number(id)); }

function loadTokens() {
  try {
    const t = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    const missing = ROLE_KEYS.filter((k) => !t[k] || typeof t[k] !== 'string' || t[k].length < 20);
    return { tokens: t, missing };
  } catch (e) {
    return { tokens: null, missing: ROLE_KEYS };
  }
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function activate(tokens) {
  // Модератор слушает (polling), остальные — только шлют.
  const bots = {};
  for (const k of ROLE_KEYS) {
    bots[k] = new TelegramBot(tokens[k], { polling: k === 'moderator' });
  }
  const mod = bots.moderator;
  const running = new Set();          // chatId сессий в работе (без наложений)
  const lastProposal = new Map();     // chatId → текст финального предложения

  async function say(roleKey, chatId, text) {
    const p = PERSONAS[roleKey];
    try {
      await bots[roleKey].sendMessage(chatId, `${p.emoji} <b>${esc(p.name)}</b>\n${esc(text)}`,
        { parse_mode: 'HTML' });
    } catch (e) {
      logger.error({ e: e.message, roleKey }, 'send failed');
    }
  }

  mod.onText(/^\/(студия|studio|пост|post)\b\s*([\s\S]*)$/i, async (msg, m) => {
    if (!isOwner(msg.from && msg.from.id)) return;
    const chatId = msg.chat.id;
    const topic = (m[2] || '').trim();
    if (!topic) {
      await mod.sendMessage(chatId, 'Напиши тему: <code>/студия &lt;о чём пост&gt;</code>', { parse_mode: 'HTML' });
      return;
    }
    if (running.has(chatId)) {
      await mod.sendMessage(chatId, 'Секунду — предыдущая сессия ещё идёт 🙂');
      return;
    }
    running.add(chatId);
    logger.info({ chatId, topic }, 'studio session triggered');
    try {
      await mod.sendMessage(chatId, `🎬 <b>Студия за работой.</b>\nТема: «${esc(topic)}»\nКоманда обсуждает…`,
        { parse_mode: 'HTML' });

      const { proposal } = await runSession({
        topic,
        deps: {
          onTurn: async (persona, text) => {
            await say(persona.key, chatId, text);
            await new Promise((r) => setTimeout(r, 1500)); // пауза для читаемости
          },
        },
      });

      lastProposal.set(chatId, proposal);
      await mod.sendMessage(chatId, '👆 Решение команды. Твоё слово, судья:', {
        reply_markup: { inline_keyboard: [[
          { text: '✅ Делаем', callback_data: 'studio:ok' },
          { text: '↩️ Переделать', callback_data: 'studio:redo' },
        ]] },
      });
    } catch (e) {
      logger.error({ e: e.message, chatId }, 'session failed');
      await mod.sendMessage(chatId, `⚠️ Студия споткнулась: ${esc(e.message)}`);
    } finally {
      running.delete(chatId);
    }
  });

  mod.on('callback_query', async (q) => {
    try {
      if (!isOwner(q.from && q.from.id)) {
        return mod.answerCallbackQuery(q.id, { text: 'Судит только владелец 🙂' });
      }
      const chatId = q.message.chat.id;
      if (q.data === 'studio:ok') {
        await mod.answerCallbackQuery(q.id, { text: 'Принято!' });
        const proposal = lastProposal.get(chatId) || '';
        try {
          fs.appendFileSync(APPROVED_LOG,
            JSON.stringify({ at: new Date().toISOString(), chatId, proposal }) + '\n');
        } catch (e) { logger.error({ e: e.message }, 'approved-log write failed'); }
        await mod.sendMessage(chatId,
          '✅ <b>Утверждено.</b> Концепт записан в очередь на сборку — content-bot соберёт черновик поста.',
          { parse_mode: 'HTML' });
        logger.info({ chatId }, 'proposal approved → queued');
      } else if (q.data === 'studio:redo') {
        await mod.answerCallbackQuery(q.id, { text: 'Ок' });
        await mod.sendMessage(chatId,
          '↩️ Понял. Напиши, что поменять, и запусти снова: <code>/студия &lt;тема с правками&gt;</code>',
          { parse_mode: 'HTML' });
      }
    } catch (e) {
      logger.error({ e: e.message }, 'callback failed');
    }
  });

  mod.on('polling_error', (e) => logger.warn({ e: e.message }, 'moderator polling_error'));

  logger.info({ owners: OWNER_IDS }, 'Content-studio running ✅ (жду /студия <тема> от владельца)');
}

function start() {
  const { tokens, missing } = loadTokens();
  if (!missing.length) {
    activate(tokens);
    return;
  }
  logger.warn({ missing, cfg: CFG_PATH },
    'studio-bots.json нет или неполон — студия СПИТ. Перечитываю конфиг каждые 60с; как появятся все 6 токенов, активируюсь сам.');
  const timer = setInterval(() => {
    const r = loadTokens();
    if (!r.missing.length) {
      clearInterval(timer);
      logger.info('токены найдены — активирую студию');
      activate(r.tokens);
    }
  }, 60000);
}

process.on('SIGTERM', () => { logger.info('SIGTERM'); process.exit(0); });
process.on('SIGINT', () => { logger.info('SIGINT'); process.exit(0); });
process.on('uncaughtException', (err) => { logger.fatal({ err }, 'uncaught'); process.exit(1); });
process.on('unhandledRejection', (reason) => { logger.error({ reason }, 'unhandled rejection'); });

if (require.main === module) start();

module.exports = { start, loadTokens };

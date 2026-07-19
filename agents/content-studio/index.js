'use strict';
/**
 * Content Studio — Telegram-обвязка мульти-агентной студии.
 *
 * Боты по ролям в общей группе. Владелец кидает тему командой
 * `/студия <тема>` (или /studio, /пост, /post) → команда обсуждает вживую
 * (каждая реплика от своего бота), в конце Модератор даёт финальное
 * предложение с кнопками ✅ Делаем / ↩️ Переделать. По ✅ концепт уходит
 * в очередь на сборку content-bot (data/studio-approved.jsonl).
 *
 * LLM — через подписочный шим (Sonnet, $0 API), см. studio.js.
 *
 * Токены: config/studio-bots.json = { moderator, smm, photo, copy, critic, audience }.
 * Активируется, если есть МОДЕРАТОР + хотя бы один спикер; недостающие роли
 * просто не участвуют. Если модератора/спикеров нет — процесс живёт и раз в
 * 60с перечитывает конфиг, активируясь сам, как появятся токены.
 * (Добавил роль в уже активную студию? Нужен pm2 restart content-studio.)
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
const STATE_PATH = path.join(__dirname, '../../data/studio-state.json');
const SPEAKING = ['smm', 'photo', 'copy', 'critic', 'audience']; // порядок высказываний

// Язык ПОДПИСИ поста (обсуждение всегда по-русски). Персистентно, по умолчанию русский.
function getLang() { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')).lang === 'en' ? 'en' : 'ru'; } catch { return 'ru'; } }
function setLang(l) { try { fs.writeFileSync(STATE_PATH, JSON.stringify({ lang: l })); } catch (e) { /* ignore */ } }
const langLabel = (l) => (l === 'en' ? '🇬🇧 English' : '🇷🇺 Русский');

const OWNER_IDS = String(process.env.OWNER_CHAT_IDS || '216299177')
  .split(',').map((s) => Number(s.trim())).filter(Boolean);
const isOwner = (id) => OWNER_IDS.includes(Number(id));
const validTok = (t) => typeof t === 'string' && t.length >= 20;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); }
  catch { return null; }
}

function activate(tokens) {
  const speakers = SPEAKING.filter((k) => validTok(tokens[k]));
  const roleKeys = ['moderator', ...speakers];
  const bots = {};
  for (const k of roleKeys) bots[k] = new TelegramBot(tokens[k], { polling: k === 'moderator' });
  const mod = bots.moderator;
  const running = new Set();       // chatId сессий в работе
  const lastProposal = new Map();  // chatId → финальное предложение

  async function say(roleKey, chatId, text) {
    const p = PERSONAS[roleKey];
    try {
      await bots[roleKey].sendMessage(chatId, `${p.emoji} <b>${esc(p.name)}</b>\n${esc(text)}`,
        { parse_mode: 'HTML' });
    } catch (e) { logger.error({ e: e.message, roleKey }, 'send failed'); }
  }

  mod.on('message', async (msg) => {
    if (!msg || (msg.from && msg.from.is_bot)) return;   // игнор реплик самих ботов команды
    if (!isOwner(msg.from && msg.from.id)) return;        // только владелец
    const chatId = msg.chat.id;
    const raw = (msg.text || '').trim();
    if (!raw) return;                                    // сервисные/пустые сообщения
    // Переключатель языка поста: короткое слово-токен («английский», «русский», en/ru, флаг).
    const low = raw.toLowerCase();
    const wantEn = /^(язык[:\s]+)?(англ\S*|english|eng|en)$/.test(low) || low === '🇬🇧';
    const wantRu = /^(язык[:\s]+)?(рус\S*|russian|ru)$/.test(low) || low === '🇷🇺';
    if (wantEn || wantRu) {
      const l = wantEn ? 'en' : 'ru';
      setLang(l);
      await mod.sendMessage(msg.chat.id,
        `Язык обсуждения теперь: ${langLabel(l)}. (Итоговый пост всегда на английском 🇬🇧.) Пиши тему 🙂`);
      return;
    }
    // Тема = обычный текст. Если начал с /студия|/studio|/пост|/post — берём хвост; прочие /команды игнорим.
    let topic = raw;
    const cmd = raw.match(/^\/(студия|studio|пост|post)(?:@\S+)?\b\s*([\s\S]*)$/i);
    if (cmd) topic = (cmd[2] || '').trim();
    else if (raw.startsWith('/')) return;
    if (!topic) {
      await mod.sendMessage(chatId, 'Напиши тему поста обычным сообщением — и команда возьмётся 🙂');
      return;
    }
    if (running.has(chatId)) { await mod.sendMessage(chatId, 'Секунду — команда ещё дорабатывает прошлую тему 🙂'); return; }
    running.add(chatId);
    logger.info({ chatId, topic, speakers }, 'studio session triggered');
    try {
      const lang = getLang();
      await mod.sendMessage(chatId,
        `🎬 <b>Студия за работой.</b>\nТема: «${esc(topic)}»\nОбсуждение: ${langLabel(lang)} · пост: 🇬🇧 English\nКоманда обсуждает…`,
        { parse_mode: 'HTML' });
      const { proposal } = await runSession({
        topic,
        deps: {
          roles: speakers,
          lang,
          onTurn: async (persona, text) => {
            await say(persona.key, chatId, text);
            await new Promise((r) => setTimeout(r, 1500));
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
    } finally { running.delete(chatId); }
  });

  mod.on('callback_query', async (q) => {
    try {
      if (!isOwner(q.from && q.from.id)) return mod.answerCallbackQuery(q.id, { text: 'Судит только владелец 🙂' });
      const chatId = q.message.chat.id;
      if (q.data === 'studio:ok') {
        await mod.answerCallbackQuery(q.id, { text: 'Принято!' });
        const proposal = lastProposal.get(chatId) || '';
        try {
          fs.appendFileSync(APPROVED_LOG, JSON.stringify({ at: new Date().toISOString(), chatId, proposal }) + '\n');
        } catch (e) { logger.error({ e: e.message }, 'approved-log write failed'); }
        await mod.sendMessage(chatId,
          '✅ <b>Утверждено.</b> Концепт записан в очередь на сборку — content-bot соберёт черновик.',
          { parse_mode: 'HTML' });
        logger.info({ chatId }, 'proposal approved → queued');
      } else if (q.data === 'studio:redo') {
        await mod.answerCallbackQuery(q.id, { text: 'Ок' });
        await mod.sendMessage(chatId,
          '↩️ Понял. Напиши, что поменять, и запусти снова: <code>/студия &lt;тема с правками&gt;</code>',
          { parse_mode: 'HTML' });
      }
    } catch (e) { logger.error({ e: e.message }, 'callback failed'); }
  });

  mod.on('polling_error', (e) => logger.warn({ e: e.message }, 'moderator polling_error'));
  logger.info({ owners: OWNER_IDS, speakers, missing: SPEAKING.filter((k) => !validTok(tokens[k])) },
    'Content-studio running ✅ (жду /студия <тема> в группе)');
}

function start() {
  const tokens = loadTokens();
  const ready = tokens && validTok(tokens.moderator) && SPEAKING.some((k) => validTok(tokens[k]));
  if (ready) { activate(tokens); return; }
  logger.warn({ cfg: CFG_PATH },
    'нет модератора и/или спикеров — студия СПИТ, перечитываю конфиг каждые 60с и активируюсь сам.');
  const timer = setInterval(() => {
    const t = loadTokens();
    if (t && validTok(t.moderator) && SPEAKING.some((k) => validTok(t[k]))) {
      clearInterval(timer);
      logger.info('токены найдены — активирую студию');
      activate(t);
    }
  }, 60000);
}

process.on('SIGTERM', () => { logger.info('SIGTERM'); process.exit(0); });
process.on('SIGINT', () => { logger.info('SIGINT'); process.exit(0); });
process.on('uncaughtException', (err) => { logger.fatal({ err }, 'uncaught'); process.exit(1); });
process.on('unhandledRejection', (reason) => { logger.error({ reason }, 'unhandled rejection'); });

if (require.main === module) start();
module.exports = { start, loadTokens };

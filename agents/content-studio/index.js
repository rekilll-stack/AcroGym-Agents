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
const cron = require('node-cron');
const { createLogger } = require('../../shared/logger');
const { PERSONAS } = require('./personas');
const { runSession } = require('./studio');

const logger = createLogger('content-studio');

const CFG_PATH = path.join(__dirname, '../../config/studio-bots.json');
const APPROVED_LOG = path.join(__dirname, '../../data/studio-approved.jsonl');
const BUILD_DIR = path.join(__dirname, '../../data/studio-build'); // очередь на сборку для content-bot
const NOTIFY_DIR = path.join(__dirname, '../../data/studio-notify'); // приватный итог владельцу через content-bot
const STATE_PATH = path.join(__dirname, '../../data/studio-state.json');
const SPEAKING = ['smm', 'photo', 'copy', 'critic', 'audience']; // порядок высказываний

// Язык ПОДПИСИ поста (обсуждение всегда по-русски). Персистентно, по умолчанию русский.
function getState() { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) || {}; } catch { return {}; } }
function setState(patch) { try { fs.writeFileSync(STATE_PATH, JSON.stringify({ ...getState(), ...patch })); } catch (e) { /* ignore */ } }
function getLang() { return getState().lang === 'en' ? 'en' : 'ru'; }
function setLang(l) { setState({ lang: l }); }
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
  // Меню команд (показывается по «/» в чате).
  mod.setMyCommands([
    { command: 'post', description: 'Обсудить пост — дальше напиши тему' },
    { command: 'brief', description: 'Планёрка на неделю (команда обсуждает)' },
    { command: 'english', description: 'Обсуждать на английском' },
    { command: 'russian', description: 'Обсуждать на русском' },
    { command: 'help', description: 'Как пользоваться студией' },
  ]).catch((e) => logger.warn({ e: e.message }, 'setMyCommands failed'));
  const running = new Set();       // chatId сессий в работе
  const lastProposal = new Map();  // chatId → финальное предложение
  const lastTopic = new Map();     // chatId → тема (для сборки content-bot)

  async function say(roleKey, chatId, text) {
    const p = PERSONAS[roleKey];
    try {
      await bots[roleKey].sendMessage(chatId, `${p.emoji} <b>${esc(p.name)}</b>\n${esc(text)}`,
        { parse_mode: 'HTML' });
    } catch (e) { logger.error({ e: e.message, roleKey }, 'send failed'); }
  }

  // Еженедельный брифинг стратегии от 📊 СММ в группу (данные content-bot + LLM).
  const TZ = process.env.TIMEZONE || 'Asia/Qatar';
  async function weeklyBriefing(targetChatId) {
    const chatId = targetChatId || getState().groupChatId;
    if (!chatId) { logger.warn('weekly briefing: группа ещё не известна (напиши что-нибудь в группе)'); return; }
    const dataDir = path.join(__dirname, '../../data');
    let competitors = '', plan = '';
    try { competitors = fs.readFileSync(path.join(dataDir, 'competitor-brief.md'), 'utf8').slice(0, 4000); } catch { /* нет данных */ }
    try { plan = fs.readFileSync(path.join(dataDir, 'content-plan.json'), 'utf8').slice(0, 2000); } catch { /* нет данных */ }
    const topic =
      'Планёрка на неделю для Instagram @acrogymqatar: на чём фокус, что постить, что учесть у конкурентов.\n\n' +
      `Данные — КОНКУРЕНТЫ (brief):\n${competitors || '(нет свежих — дай общие рекомендации)'}\n\n` +
      `ТЕКУЩИЙ ПЛАН:\n${plan || '(плана нет — предложите темы)'}`;
    await bots.moderator.sendMessage(chatId, '📊 <b>Планёрка на неделю</b> — команда обсуждает…', { parse_mode: 'HTML' }).catch(() => {});
    try {
      await runSession({ topic, deps: {
        roles: speakers,
        lang: getLang(),
        mode: 'weekly',
        onTurn: async (persona, text) => { await say(persona.key, chatId, text); await new Promise((r) => setTimeout(r, 1200)); },
      } });
    } catch (e) { logger.error({ e: e.message }, 'weekly briefing session'); await bots.moderator.sendMessage(chatId, `⚠️ Планёрка споткнулась: ${e.message}`).catch(() => {}); }
    logger.info({ chatId }, 'weekly briefing done');
  }
  cron.schedule('0 9 * * 0', () => { weeklyBriefing().catch((e) => logger.error({ e: e.message }, 'weekly briefing cron')); }, { timezone: TZ });

  mod.on('message', async (msg) => {
    if (!msg || (msg.from && msg.from.is_bot)) return;   // игнор реплик самих ботов команды
    if (!isOwner(msg.from && msg.from.id)) return;        // только владелец
    const chatId = msg.chat.id;
    const raw = (msg.text || '').trim();
    if (!raw) return;                                    // сервисные/пустые сообщения
    const low = raw.toLowerCase();
    const cmdWord = low.replace(/@[a-z0-9_]+$/i, '').trim(); // убрать @botname у команд в группе
    // Запоминаем группу студии — сюда пойдёт еженедельный брифинг.
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') setState({ groupChatId: chatId });
    // Помощь / список.
    if (/^\/(help|start|команды|помощь)$/i.test(cmdWord)) {
      await mod.sendMessage(chatId,
        '🎬 <b>Контент-студия</b>\n' +
        '• Просто напиши <b>тему</b> сообщением — команда обсудит и предложит пост.\n' +
        '• /brief — планёрка на неделю (стратегия + план + конкуренты)\n' +
        '• /english — обсуждать по-английски · /russian — по-русски (пост всегда English)\n' +
        '• По ✅ content-bot соберёт черновик, команда его отревьюит; 🛑 Стоп прервёт.',
        { parse_mode: 'HTML' }).catch(() => {});
      return;
    }
    // Брифинг / планёрка недели.
    if (/^\/?(брифинг|briefing|бриф|brief)$/i.test(cmdWord)) {
      await mod.sendMessage(chatId, '📊 Готовлю планёрку…').catch(() => {});
      await weeklyBriefing(chatId).catch(() => {});
      return;
    }
    // Переключатель языка обсуждения: слово-токен или команда (/english, /russian).
    const wantEn = /^\/?(язык[:\s]+)?(англ\S*|english|eng|en)$/i.test(cmdWord) || low === '🇬🇧';
    const wantRu = /^\/?(язык[:\s]+)?(рус\S*|russian|ru)$/i.test(cmdWord) || low === '🇷🇺';
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
      lastTopic.set(chatId, topic);
      // Приватный итог владельцу через content-bot (чтобы не следить за группой).
      try { fs.mkdirSync(NOTIFY_DIR, { recursive: true }); fs.writeFileSync(path.join(NOTIFY_DIR, `${Date.now()}.json`), JSON.stringify({ topic, proposal })); }
      catch (e) { logger.error({ e: e.message }, 'notify write failed'); }
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
        const theme = lastTopic.get(chatId) || '';
        try {
          fs.appendFileSync(APPROVED_LOG, JSON.stringify({ at: new Date().toISOString(), chatId, theme, proposal }) + '\n');
        } catch (e) { logger.error({ e: e.message }, 'approved-log write failed'); }
        // Запрос на сборку для content-bot (он следит за этой папкой и собирает черновик в ЭТУ группу).
        try {
          fs.mkdirSync(BUILD_DIR, { recursive: true });
          fs.writeFileSync(path.join(BUILD_DIR, `${Date.now()}.json`),
            JSON.stringify({ theme, chatId, at: new Date().toISOString() }));
        } catch (e) { logger.error({ e: e.message }, 'build-request write failed'); }
        await mod.sendMessage(chatId,
          '✅ <b>Утверждено.</b> content-bot собирает черновик (фото + Canva) и пришлёт сюда — это ~1-2 минуты 🎨',
          { parse_mode: 'HTML' });
        logger.info({ chatId, theme }, 'proposal approved → build queued');
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

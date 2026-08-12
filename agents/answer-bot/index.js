'use strict';

// AcroGym Answer Bot — «суфлёр Кристины» v2.
// v2 (ночь 12.08): память диалога, обучение новым фактам с подтверждением
// владельца, журнал пробелов (/gaps), горячая перезагрузка базы знаний,
// советы Кристине в русской пометке.
// LLM — ТОЛЬКО подписочный шим (llm.js, $0), метёный API не трогаем.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const { generateText } = require('../content-bot/llm');
const { buildAnswerPrompt, buildFactPrompt, buildReviewPrompt, KB_PATH } = require('./prompts');
const { answer: engineAnswer } = require('./engine');
const { TEMPLATES } = require('./templates');
const { createLogger } = require('../../shared/logger');
const { writeHeartbeat } = require('../../shared/heartbeat');

const logger = createLogger('answer-bot');

const TOKEN = process.env.ANSWER_BOT_TOKEN;
const OWNER_ID = parseInt(process.env.ANSWER_BOT_OWNER_ID || '216299177', 10);
const ALLOWED = String(process.env.ANSWER_BOT_CHAT_IDS || '216299177,572259729,8840043628')
  .split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);

const DATA_DIR = path.join(__dirname, '../../data');
const HISTORY_PATH = path.join(DATA_DIR, 'answer-bot-history.json');
const LOG_PATH = path.join(DATA_DIR, 'answer-bot-log.jsonl');
const HISTORY_TURNS = 8; // последних пар «вопрос-ответ» на чат

if (!TOKEN) {
  logger.error('ANSWER_BOT_TOKEN не задан в .env');
  process.exit(1);
}

// ── Память диалога (переживает рестарты) ─────────────────────
let history = {};
try { history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); } catch (_) {}
let _saveTimer = null;
function saveHistorySoon() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try { fs.writeFileSync(HISTORY_PATH, JSON.stringify(history)); } catch (e) { logger.warn({ e: e.message }, 'history save failed'); }
  }, 1500);
}
function pushHistory(chatId, role, text) {
  const key = String(chatId);
  history[key] = history[key] || [];
  history[key].push({ role, text: String(text).slice(0, 1500) });
  if (history[key].length > HISTORY_TURNS * 2) history[key] = history[key].slice(-HISTORY_TURNS * 2);
  // sanity: суммарный объём истории чата ≤ 8000 символов
  while (history[key].reduce((n, h) => n + h.text.length, 0) > 8000 && history[key].length > 2) history[key].shift();
  saveHistorySoon();
}

// ── Журнал вопросов и пробелов ───────────────────────────────
function logQA(chatId, q, a, gap) {
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), chatId, q: q.slice(0, 500), a: a.slice(0, 500), gap }) + '\n');
  } catch (_) {}
}
const GAP_MARKERS = [/i'?ll check/i, /get back to you/i, /уточни у кирилла/i, /нет в базе/i, /в базе н[ие]т/i];
function looksLikeGap(answer) { return GAP_MARKERS.some(r => r.test(answer)); }
function readGaps(limit = 15) {
  try {
    const lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n');
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(x => x && x.gap).slice(-limit);
  } catch { return []; }
}

// ── Обучение: «запомни: …» → превью → подтверждение владельца ─
const pendingFacts = new Map(); // messageId → { fact, proposedBy }
function appendFact(factLines) {
  try { fs.copyFileSync(KB_PATH, KB_PATH + '.bak'); } catch (_) {}
  let kb = fs.readFileSync(KB_PATH, 'utf8');
  const header = '## Learned facts (approved by owner)';
  if (!kb.includes(header)) kb += `\n${header}\n`;
  kb += `\n${factLines.trim()}\n`;
  fs.writeFileSync(KB_PATH, kb); // prompts.js перечитает по mtime
}

const START_TEXT =
  'Привет! Я суфлёр AcroGym 🤸\n\n' +
  '• Пришли вопрос клиента — текстом или СКРИНШОТОМ переписки WhatsApp (я его прочитаю), или ' +
  'спроси по-русски «что ответить, если…» — пришлю готовый вежливый ответ на ' +
  'английском (зажми → Copy → в WhatsApp).\n' +
  '• Я помню наш диалог: можно уточнять «а если детей двое?» — пойму контекст.\n' +
  '• После «———» пишу пометки лично тебе: чего не хватает в базе и мой совет, ' +
  'как лучше поступить с этим клиентом.\n\n' +
  'Обучение: напиши «запомни: парковка в молле бесплатная» — я оформлю факт и ' +
  'после подтверждения Кирилла запомню его навсегда.\n' +
  'Команды: /prices — прайс · /templates — готовые тексты · /kb — что я выучил · /stats — статистика · /gaps — вопросы без ответа · /forget — забыть диалог.';

const bot = new TelegramBot(TOKEN, { polling: { interval: 1500, params: { timeout: 30 } } });
const busy = new Set();
const lastQ = new Map();   // chatId → последний вопрос (для 🔄/✂️)
const queued = new Map();  // chatId → отложенное сообщение (пришло, пока бот думал)

// Скриншот переписки WhatsApp → вижн: бот читает картинку и отвечает клиенту.
async function handleScreenshot(msg) {
  const chatId = msg.chat.id;
  if (busy.has(chatId)) {
    return void bot.sendMessage(chatId, '⏳ Секунду, ещё думаю над прошлым вопросом…').catch(() => {});
  }
  busy.add(chatId);
  try {
    await bot.sendChatAction(chatId, 'typing').catch(() => {});
    const photo = msg.photo[msg.photo.length - 1]; // максимальное разрешение
    const filePath = await bot.downloadFile(photo.file_id, require('os').tmpdir());
    const data = fs.readFileSync(filePath).toString('base64');
    try { fs.unlinkSync(filePath); } catch (_) {}
    const caption = (msg.caption || '').trim();
    const q = (caption ? caption + '\n\n' : '') +
      'Attached is a SCREENSHOT of a WhatsApp conversation with a client. Read it ' +
      'carefully, find the client\'s latest unanswered question(s), and produce the reply.';
    const hist = history[String(chatId)] || [];
    const answer = await engineAnswer(q, hist, [{ media_type: 'image/jpeg', data }]);
    lastQ.set(chatId, '[скриншот переписки]' + (caption ? ' — ' + caption : ''));
    const shotRows = looksLikeGap(answer) ? [[{ text: '📨 Спросить Кирилла', callback_data: 'ask_owner' }]] : [];
    await bot.sendMessage(chatId, answer.slice(0, 4000), { disable_web_page_preview: true,
      ...(shotRows.length ? { reply_markup: { inline_keyboard: shotRows } } : {}) });
    pushHistory(chatId, 'user', '[скриншот переписки]' + (caption ? ' ' + caption : ''));
    pushHistory(chatId, 'assistant', answer);
    logQA(chatId, '[screenshot] ' + caption, answer, looksLikeGap(answer));
    writeHeartbeat('answer-bot', 'screenshot answered');
    logger.info({ chatId }, 'Ответ по скриншоту отправлен');
  } finally {
    busy.delete(chatId);
  }
}

bot.on('message', async (msg) => {
  const chatId = msg.chat && msg.chat.id;
  const text = (msg.text || '').trim();
  if (!chatId) return;
  if (!text) {
    if (ALLOWED.includes(chatId) && msg.photo && msg.photo.length) {
      return void handleScreenshot(msg).catch(err => {
        logger.error({ err }, 'screenshot flow failed');
        bot.sendMessage(chatId, '⚠️ Не смог прочитать скриншот, попробуй ещё раз или перешли текстом.').catch(() => {});
      });
    }
    if (ALLOWED.includes(chatId) && (msg.voice || msg.document || msg.video)) {
      bot.sendMessage(chatId, '🎙 Голосовые и файлы пока не понимаю — пришли текст или скриншот переписки.').catch(() => {});
    }
    return;
  }

  if (!ALLOWED.includes(chatId)) {
    await bot.sendMessage(chatId, 'Sorry, this is a private assistant bot for the AcroGym team.').catch(() => {});
    return;
  }

  // ── Команды ──
  if (text === '/start' || text === '/help') return void bot.sendMessage(chatId, START_TEXT).catch(() => {});
  if (text === '/forget') {
    delete history[String(chatId)]; saveHistorySoon();
    return void bot.sendMessage(chatId, '🧹 Диалог забыт, начинаем с чистого листа.').catch(() => {});
  }
  if (text === '/prices') {
    // Секция Prices из живой базы знаний — единый источник правды.
    const kb = fs.readFileSync(KB_PATH, 'utf8');
    const m = kb.match(/## Prices[\s\S]*?(?=\n## )/);
    const out = m ? m[0].replace(/^#+ /gm, '').replace(/\*\*/g, '') : 'Секция цен не найдена в базе.';
    return void bot.sendMessage(chatId, out.slice(0, 4000)).catch(() => {});
  }
  if (text === '/templates') {
    const kb = Object.entries(TEMPLATES).map(([key, t]) => [{ text: t.label, callback_data: 'tpl:' + key }]);
    return void bot.sendMessage(chatId, '📎 Готовые тексты — жми, пришлю для копирования:', { reply_markup: { inline_keyboard: kb } }).catch(() => {});
  }
  if (text === '/stats') {
    let lines = [];
    try { lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch (_) {}
    const week = lines.filter(x => Date.now() - new Date(x.ts).getTime() < 7 * 864e5);
    const gaps = week.filter(x => x.gap).length;
    const out = `📊 За 7 дней: вопросов ${week.length}, из них без ответа в базе — ${gaps}.\nВсего за всё время: ${lines.length}.` +
      (gaps ? '\n\nПосмотреть пробелы: /gaps' : '');
    return void bot.sendMessage(chatId, out).catch(() => {});
  }
  if (text === '/kb') {
    const kb = fs.readFileSync(KB_PATH, 'utf8');
    const m = kb.match(/## Learned facts[\s\S]*$/);
    const out = m && m[0].split('\n').slice(1).join('\n').trim()
      ? '📚 Чему я научился (сверх базовой базы):\n' + m[0].split('\n').slice(1).join('\n').trim()
      : '📚 Выученных фактов пока нет — учите через «запомни: …»';
    return void bot.sendMessage(chatId, out.slice(0, 4000)).catch(() => {});
  }
  if (text === '/gaps') {
    const gaps = readGaps();
    const out = gaps.length
      ? '❓ Вопросы, где мне не хватило базы знаний:\n\n' + gaps.map((g, i) => `${i + 1}. ${g.q}`).join('\n')
      : '👍 Пробелов не накопилось — на всё отвечал по базе.';
    return void bot.sendMessage(chatId, out.slice(0, 4000)).catch(() => {});
  }

  // ── Обучение: «запомни: …» / /learn … ──
  const learnMatch = text.match(/^(?:\/learn|запомни)[:\s]+([\s\S]+)/i);
  if (learnMatch) {
    try {
      await bot.sendChatAction(chatId, 'typing').catch(() => {});
      const fact = (await generateText(buildFactPrompt(learnMatch[1]))).trim();
      const preview = await bot.sendMessage(chatId,
        `📚 Добавить в базу знаний?\n\n${fact}\n\n(подтвердить может Кирилл)`,
        { reply_markup: { inline_keyboard: [[
          { text: '✅ Добавить', callback_data: 'kb_add' },
          { text: '❌ Отмена', callback_data: 'kb_cancel' },
        ]] } });
      pendingFacts.set(preview.message_id, { fact, proposedBy: chatId });
      if (pendingFacts.size > 20) pendingFacts.delete(pendingFacts.keys().next().value);
    } catch (err) {
      logger.error({ err }, 'learn flow failed');
      await bot.sendMessage(chatId, '⚠️ Не получилось оформить факт, попробуй ещё раз.').catch(() => {});
    }
    return;
  }

  // ── Обычный вопрос → ответ ──
  if (text.replace(/[\s\p{Emoji}]/gu, '').length < 3) {
    return void bot.sendMessage(chatId, 'Напиши вопрос словами или перешли сообщение клиента — отвечу 🤸').catch(() => {});
  }
  if (busy.has(chatId)) {
    queued.set(chatId, text); // ответим сразу после текущего
    await bot.sendMessage(chatId, '⏳ Думаю над прошлым вопросом — этот отвечу следом.').catch(() => {});
    return;
  }
  await answerText(chatId, text);
});

async function answerText(chatId, text) {
  busy.add(chatId);
  try {
    await bot.sendChatAction(chatId, 'typing').catch(() => {});
    const hist = history[String(chatId)] || [];
    const answer = await engineAnswer(text, hist);
    const kbRow = [
      { text: '🔄 Другой вариант', callback_data: 'regen' },
      { text: '✂️ Короче', callback_data: 'shorter' },
    ];
    const rows = [kbRow];
    if (looksLikeGap(answer)) rows.push([{ text: '📨 Спросить Кирилла', callback_data: 'ask_owner' }]);
    await bot.sendMessage(chatId, answer.slice(0, 4000), { disable_web_page_preview: true,
      reply_markup: { inline_keyboard: rows } });
    lastQ.set(chatId, text);
    pushHistory(chatId, 'user', text);
    pushHistory(chatId, 'assistant', answer);
    logQA(chatId, text, answer, looksLikeGap(answer));
    writeHeartbeat('answer-bot', 'answered ok');
    logger.info({ chatId, q: text.slice(0, 80) }, 'Ответ отправлен');
  } catch (err) {
    logger.error({ err, chatId }, 'Ошибка генерации ответа');
    await bot.sendMessage(chatId,
      '⚠️ Не получилось сгенерировать ответ. Попробуй ещё раз через минуту; если повторится — скажи Кириллу.').catch(() => {});
  } finally {
    busy.delete(chatId);
    const next = queued.get(chatId);
    if (next) { queued.delete(chatId); answerText(chatId, next).catch(() => {}); }
  }
}

// ── Подтверждение фактов (гейт: только Кирилл) ──
bot.on('callback_query', async (query) => {
  const data = query.data || '';
  const msg = query.message;
  if (data === 'ask_owner') {
    const chatId = msg && msg.chat && msg.chat.id;
    if (!chatId || !ALLOWED.includes(chatId)) return void bot.answerCallbackQuery(query.id).catch(() => {});
    const q = lastQ.get(chatId) || '(вопрос не сохранился)';
    bot.sendMessage(OWNER_ID, `📨 Вопрос от Кристины/админа, на который у меня нет ответа в базе:\n\n«${q}»\n\nОтветь мне «запомни: …» — и я закрою этот пробел навсегда.`).catch(() => {});
    return void bot.answerCallbackQuery(query.id, { text: '📨 Отправил Кириллу' }).catch(() => {});
  }
  if (data === 'regen' || data === 'shorter') {
    const chatId = msg && msg.chat && msg.chat.id;
    if (!chatId || !ALLOWED.includes(chatId)) return void bot.answerCallbackQuery(query.id).catch(() => {});
    const q = lastQ.get(chatId);
    if (!q || busy.has(chatId)) return void bot.answerCallbackQuery(query.id, { text: q ? '⏳ Уже думаю…' : 'Вопрос не найден — задай заново' }).catch(() => {});
    busy.add(chatId);
    bot.answerCallbackQuery(query.id, { text: data === 'regen' ? '🔄 Пишу другой вариант…' : '✂️ Сокращаю…' }).catch(() => {});
    (async () => {
      try {
        await bot.sendChatAction(chatId, 'typing').catch(() => {});
        const hist = history[String(chatId)] || [];
        const extra = data === 'regen'
          ? '\n\n(Kristina asks for an ALTERNATIVE version of the reply — different angle/wording, same facts.)'
          : '\n\n(Kristina asks for a SHORTER version — 2-3 sentences maximum, keep the key facts.)';
        const answer = (await generateText(buildAnswerPrompt(q + extra, hist)) || '').trim();
        if (answer) {
          await bot.sendMessage(chatId, answer, { disable_web_page_preview: true,
            reply_markup: { inline_keyboard: [[
              { text: '🔄 Другой вариант', callback_data: 'regen' },
              { text: '✂️ Короче', callback_data: 'shorter' },
            ]] } });
          pushHistory(chatId, 'assistant', answer);
        }
      } catch (err) { logger.error({ err }, 'regen/shorter failed'); }
      finally { busy.delete(chatId); }
    })();
    return;
  }
  if (data.startsWith('tpl:')) {
    const t = TEMPLATES[data.slice(4)];
    if (t && msg) await bot.sendMessage(msg.chat.id, t.text, { disable_web_page_preview: true }).catch(() => {});
    return void bot.answerCallbackQuery(query.id, { text: '📋 Зажми сообщение → Copy' }).catch(() => {});
  }
  if (!msg || !pendingFacts.has(msg.message_id)) {
    return void bot.answerCallbackQuery(query.id).catch(() => {});
  }
  const { fact } = pendingFacts.get(msg.message_id);
  if (data === 'kb_add') {
    if (query.from.id !== OWNER_ID) {
      return void bot.answerCallbackQuery(query.id, { text: '⛔ Подтвердить может только Кирилл', show_alert: true }).catch(() => {});
    }
    try {
      appendFact(fact);
      pendingFacts.delete(msg.message_id);
      await bot.editMessageText(`✅ Добавлено в базу знаний:\n\n${fact}`, { chat_id: msg.chat.id, message_id: msg.message_id });
      await bot.answerCallbackQuery(query.id, { text: '📚 Запомнил навсегда' }).catch(() => {});
      logger.info({ fact: fact.slice(0, 100) }, 'KB fact approved');
    } catch (err) {
      logger.error({ err }, 'appendFact failed');
      await bot.answerCallbackQuery(query.id, { text: '⚠️ Ошибка записи' }).catch(() => {});
    }
  } else if (data === 'kb_cancel') {
    pendingFacts.delete(msg.message_id);
    await bot.editMessageText('❌ Отменено, в базу не добавлял.', { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => {});
    await bot.answerCallbackQuery(query.id).catch(() => {});
  }
});

bot.on('polling_error', (err) => logger.warn({ err: err.message }, 'polling_error'));
process.on('uncaughtException', (err) => logger.fatal({ err }, 'Uncaught exception'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled rejection'));

// Понедельник 09:00 — дайджест пробелов владельцу (если накопились).
cron.schedule('0 9 * * 1', () => {
  const gaps = readGaps(20);
  if (!gaps.length) return;
  const out = '📚 Answer Bot: за неделю накопились вопросы без ответа в базе.\n' +
    'Ответь на них через «запомни: …» — и бот будет закрывать их сам:\n\n' +
    gaps.map((g, i) => `${i + 1}. ${g.q}`).join('\n');
  bot.sendMessage(OWNER_ID, out.slice(0, 4000)).catch(() => {});
}, { timezone: process.env.TIMEZONE || 'Asia/Qatar' });

writeHeartbeat('answer-bot', 'started v2');
setInterval(() => { try { writeHeartbeat('answer-bot', 'alive'); } catch (_) {} }, 60 * 60 * 1000);
logger.info({ allowed: ALLOWED, owner: OWNER_ID }, 'Answer-bot v2 running ✅ (память, обучение, советы)');

'use strict';

// AcroGym Answer Bot — «суфлёр Кристины».
// Присылаешь вопрос клиента (или свой вопрос по-русски) → получаешь готовый
// вежливый ответ для WhatsApp. Знания — agents/answer-bot/knowledge.md.
// LLM — ТОЛЬКО подписочный шим (llm.js, $0), метёный API не трогаем.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const TelegramBot = require('node-telegram-bot-api');
const { generateText } = require('../content-bot/llm');
const { buildAnswerPrompt } = require('./prompts');
const { createLogger } = require('../../shared/logger');
const { writeHeartbeat } = require('../../shared/heartbeat');

const logger = createLogger('answer-bot');

const TOKEN = process.env.ANSWER_BOT_TOKEN;
const ALLOWED = String(process.env.ANSWER_BOT_CHAT_IDS || '216299177,572259729,8840043628')
  .split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);

if (!TOKEN) {
  logger.error('ANSWER_BOT_TOKEN не задан в .env — создать бота в BotFather и вписать токен');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: { interval: 1500, params: { timeout: 30 } } });

const START_TEXT =
  'Привет! Я суфлёр AcroGym 🤸\n\n' +
  'Пришли мне вопрос клиента (можно просто переслать его сообщение — на любом ' +
  'языке) или спроси по-русски «что ответить, если…» — я пришлю готовый вежливый ' +
  'ответ на английском. Останется скопировать (зажми сообщение → Copy) и отправить ' +
  'клиенту в WhatsApp.\n\n' +
  'Я знаю цены сезона 2026/27, даты термов, правила заморозки и 24 часов, зачёт ' +
  'первого занятия, скидки и правила регистрации. Если чего-то не знаю — честно ' +
  'скажу и посоветую уточнить у Кирилла.';

// Один вопрос за раз на чат — защита от дублей, пока LLM думает (~15-30с).
const busy = new Set();

bot.on('message', async (msg) => {
  const chatId = msg.chat && msg.chat.id;
  const text = (msg.text || '').trim();
  if (!chatId || !text) return;

  if (!ALLOWED.includes(chatId)) {
    await bot.sendMessage(chatId, 'Sorry, this is a private assistant bot for the AcroGym team.').catch(() => {});
    logger.warn({ chatId }, 'Отказ: чат не в whitelist');
    return;
  }

  if (text === '/start' || text === '/help') {
    await bot.sendMessage(chatId, START_TEXT).catch(() => {});
    return;
  }

  if (busy.has(chatId)) {
    await bot.sendMessage(chatId, '⏳ Секунду, ещё думаю над прошлым вопросом…').catch(() => {});
    return;
  }
  busy.add(chatId);

  try {
    await bot.sendChatAction(chatId, 'typing').catch(() => {});
    const answer = await generateText(buildAnswerPrompt(text));
    const out = (answer || '').trim();
    if (!out) throw new Error('пустой ответ LLM');
    // Обычный текст без parse_mode — на iPhone копируется целиком (зажать → Copy).
    await bot.sendMessage(chatId, out, { disable_web_page_preview: true });
    writeHeartbeat('answer-bot', 'answered ok');
    logger.info({ chatId, q: text.slice(0, 80) }, 'Ответ отправлен');
  } catch (err) {
    logger.error({ err, chatId }, 'Ошибка генерации ответа');
    await bot.sendMessage(chatId,
      '⚠️ Не получилось сгенерировать ответ (сбой на моей стороне). Попробуй ещё раз ' +
      'через минуту; если повторится — скажи Кириллу.').catch(() => {});
  } finally {
    busy.delete(chatId);
  }
});

bot.on('polling_error', (err) => logger.warn({ err: err.message }, 'polling_error'));

process.on('uncaughtException', (err) => logger.fatal({ err }, 'Uncaught exception'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled rejection'));

writeHeartbeat('answer-bot', 'started');
setInterval(() => { try { writeHeartbeat('answer-bot', 'alive'); } catch (_) {} }, 60 * 60 * 1000);
logger.info({ allowed: ALLOWED }, 'Answer-bot running ✅ (подписочный LLM, whitelist активен)');

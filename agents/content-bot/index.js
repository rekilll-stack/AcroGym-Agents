'use strict';

/**
 * Agent 4 — Content bot (C.2: text formats).
 *
 * A SEPARATE Telegram bot (own token CONTENT_BOT_TOKEN, own PM2 process) that
 * DRAFTS Instagram content on demand: full post / ideas / week plan (text).
 * Photo captions (vision) are C.4 — shown as "coming soon" here.
 *
 * 🔴 BOUNDARY (whole track): the bot only DRAFTS. It never posts to Instagram —
 * Kirill copies the draft and publishes by hand. There is NO Instagram/publish
 * code here by design.
 *
 * Access: ONLY the CONTENT_CHAT_IDS allow-list (defaults to Kirill). English only.
 * Reuses shared/: claude (generation), logger, heartbeat. Own bot instance +
 * polling + a small in-memory session map (format → awaiting topic → draft).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs   = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const { createLogger }   = require('../../shared/logger');
const { writeHeartbeat } = require('../../shared/heartbeat');
const { isFormat, formatLabel } = require('./prompts');
const { generateContent } = require('./generate');

const logger = createLogger('content-bot');

// ─────────────────────────────────────────────────────────────
// Config + access
// ─────────────────────────────────────────────────────────────
const TOKEN = process.env.CONTENT_BOT_TOKEN;
const ALLOWED = (process.env.CONTENT_CHAT_IDS || '216299177')
  .split(',').map(s => s.trim()).filter(Boolean);

function isAllowed(chatId) {
  return ALLOWED.includes(String(chatId));
}

// In-memory per-chat session: { format, awaiting, lastTopic, lastDraft }.
// Lost on restart — harmless: the user just re-picks a format.
const sessions = new Map();

// ─────────────────────────────────────────────────────────────
// Single-instance lock
// ─────────────────────────────────────────────────────────────
const LOCK_FILE = path.join(__dirname, '../../data/content-bot.lock');

function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const existingPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    if (!isNaN(existingPid)) {
      try {
        process.kill(existingPid, 0);
        console.error(`[content-bot] Already running as PID ${existingPid}. Exiting.`);
        process.exit(1);
      } catch {
        console.warn(`[content-bot] Stale lock (PID ${existingPid} dead). Overwriting.`);
      }
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

// ─────────────────────────────────────────────────────────────
// Keyboards (plain inline; drafts are sent as PLAIN text — no MarkdownV2 — so
// hashtags '#', '.', '!' etc. never need escaping and copy stays clean)
// ─────────────────────────────────────────────────────────────
function menuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📝 Full post', callback_data: 'fmt:post' }],
      [{ text: '💡 Ideas', callback_data: 'fmt:ideas' }, { text: '📅 Week plan', callback_data: 'fmt:plan' }],
      [{ text: '🖼 Photo caption', callback_data: 'fmt:photo_soon' }],
    ],
  };
}

function draftKeyboard() {
  return {
    inline_keyboard: [[
      { text: '📋 Copy', callback_data: 'copy' },
      { text: '🔄 Regenerate', callback_data: 'regen' },
      { text: '⬅ Menu', callback_data: 'menu' },
    ]],
  };
}

const MENU_PROMPT = '👋 What would you like to create?';
const topicPrompt = (format) =>
  `📝 *${formatLabel(format)}* — what should this be about?\nSend me a topic or a few words of context.`;

// ─────────────────────────────────────────────────────────────
// Core: generate a draft and send it (with Copy / Regenerate / Menu)
// ─────────────────────────────────────────────────────────────
async function deliverDraft(bot, chatId, format, topic) {
  bot.sendChatAction(chatId, 'typing').catch(() => {});
  const draft = await generateContent(format, topic);
  const s = sessions.get(chatId) || {};
  s.format = format; s.lastTopic = topic; s.lastDraft = draft; s.awaiting = null;
  sessions.set(chatId, s);
  // Plain text (no parse_mode): the draft is paste-ready and safe for any chars.
  await bot.sendMessage(chatId, `📄 Draft — ${formatLabel(format)}\n\n${draft}`, {
    reply_markup: draftKeyboard(),
  }).catch((err) => logger.error({ err: err.message }, 'draft send failed'));
}

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────
function start() {
  if (!TOKEN) throw new Error('CONTENT_BOT_TOKEN не задан в .env');

  acquireLock();
  logger.info({ pid: process.pid, allowed: ALLOWED }, 'Content-bot starting');

  const bot = new TelegramBot(TOKEN, { polling: true });

  // ── Messages (commands + free-text topics) ──
  bot.on('message', async (msg) => {
    const chatId = msg.chat && msg.chat.id;
    if (!isAllowed(chatId)) {
      logger.warn({ chatId, from: msg.from && msg.from.username }, 'denied: chat_id not allow-listed');
      await bot.sendMessage(chatId, '⛔ Access denied.').catch(() => {});
      return;
    }
    const text = (msg.text || '').trim();

    // Commands
    if (text === '/start' || text === '/content') {
      sessions.set(chatId, {});
      await bot.sendMessage(chatId, MENU_PROMPT, { reply_markup: menuKeyboard() }).catch(() => {});
      return;
    }
    if (text.startsWith('/')) {
      await bot.sendMessage(chatId, 'Use /content to open the menu.', { reply_markup: menuKeyboard() }).catch(() => {});
      return;
    }

    // Free text → if we're awaiting a topic, that's the topic; else nudge to menu.
    const s = sessions.get(chatId);
    if (s && s.awaiting === 'topic' && isFormat(s.format) && text) {
      await deliverDraft(bot, chatId, s.format, text);
    } else {
      await bot.sendMessage(chatId, 'Pick a format first 👇', { reply_markup: menuKeyboard() }).catch(() => {});
    }
  });

  // ── Inline buttons ──
  bot.on('callback_query', async (query) => {
    const chatId = query.message && query.message.chat && query.message.chat.id;
    const data   = query.data || '';
    if (!isAllowed(chatId)) {
      await bot.answerCallbackQuery(query.id, { text: '⛔ Access denied' }).catch(() => {});
      return;
    }

    try {
      if (data === 'fmt:photo_soon') {
        await bot.answerCallbackQuery(query.id, { text: '🖼 Photo captions are coming soon.', show_alert: true });
        return;
      }
      if (data.startsWith('fmt:')) {
        const format = data.slice(4);
        if (!isFormat(format)) { await bot.answerCallbackQuery(query.id).catch(() => {}); return; }
        sessions.set(chatId, { format, awaiting: 'topic' });
        await bot.answerCallbackQuery(query.id).catch(() => {});
        await bot.sendMessage(chatId, topicPrompt(format), { parse_mode: 'Markdown' }).catch(() => {});
        return;
      }
      if (data === 'menu') {
        sessions.set(chatId, {});
        await bot.answerCallbackQuery(query.id).catch(() => {});
        await bot.sendMessage(chatId, MENU_PROMPT, { reply_markup: menuKeyboard() }).catch(() => {});
        return;
      }
      if (data === 'regen') {
        const s = sessions.get(chatId);
        if (s && isFormat(s.format) && s.lastTopic) {
          await bot.answerCallbackQuery(query.id, { text: '🔄 Regenerating…' }).catch(() => {});
          await deliverDraft(bot, chatId, s.format, s.lastTopic);
        } else {
          await bot.answerCallbackQuery(query.id, { text: 'Nothing to regenerate yet.' }).catch(() => {});
        }
        return;
      }
      if (data === 'copy') {
        const s = sessions.get(chatId);
        if (s && s.lastDraft) {
          await bot.answerCallbackQuery(query.id, { text: '📋 Clean text sent below ↓' }).catch(() => {});
          // Standalone plain message — long-press to copy, no surrounding chrome.
          await bot.sendMessage(chatId, s.lastDraft).catch(() => {});
        } else {
          await bot.answerCallbackQuery(query.id, { text: 'Nothing to copy yet.' }).catch(() => {});
        }
        return;
      }
      await bot.answerCallbackQuery(query.id).catch(() => {});
    } catch (err) {
      logger.error({ err: err.message, data }, 'callback handling failed');
      await bot.answerCallbackQuery(query.id, { text: '❌ Error' }).catch(() => {});
    }
  });

  bot.on('polling_error', (err) => {
    logger.error({ err: err.message }, 'Content-bot polling error');
  });

  // ── Heartbeat probe every 60s (watchdog monitors 'content-bot' on this) ──
  const probe = async () => {
    try {
      await bot.getMe();
      writeHeartbeat('content-bot', 'getMe ok');
    } catch (err) {
      logger.warn({ err: err.message }, 'content-bot heartbeat probe failed (getMe)');
    }
  };
  probe();
  setInterval(probe, 60 * 1000);

  logger.info('Content-bot running ✅ (C.2 text formats — post / ideas / plan)');
  return bot;
}

// ─────────────────────────────────────────────────────────────
// Shutdown / crash handling
// ─────────────────────────────────────────────────────────────
process.on('SIGTERM', () => { logger.info('SIGTERM'); releaseLock(); process.exit(0); });
process.on('SIGINT',  () => { logger.info('SIGINT');  releaseLock(); process.exit(0); });
process.on('exit',    () => { releaseLock(); });
process.on('uncaughtException',  (err)    => { logger.error({ err }, 'uncaughtException'); releaseLock(); process.exit(1); });
process.on('unhandledRejection', (reason) => { logger.error({ reason }, 'unhandledRejection'); });

start();

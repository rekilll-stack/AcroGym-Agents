'use strict';

/**
 * Agent 4 — Content bot (C.2: text formats + 3-level language model).
 *
 * A SEPARATE Telegram bot (own token, own PM2 process) that DRAFTS Instagram
 * content on demand: full post / ideas / week plan (text). Photo captions = C.4.
 *
 * 🔴 BOUNDARY: drafts only — Kirill copies and publishes to Instagram by hand.
 * NO Instagram/publish code exists, by design.
 *
 * Language (3 levels):
 *   1) INTERFACE (buttons/prompts/statuses) — switchable RU/EN via i18n +
 *      shared preference (same getPreferredLanguage as owner-bot).
 *   2) INPUT (the topic) — any language; the user writes in Russian if they like.
 *   3) OUTPUT (the Instagram content) — ALWAYS English (enforced in the prompt).
 *
 * Access: ONLY CONTENT_CHAT_IDS (defaults to Kirill). Reuses shared/: claude,
 * i18n, preferences, logger, heartbeat. Own bot instance + polling + in-memory
 * session map (format → awaiting topic → draft).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs   = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const { createLogger }   = require('../../shared/logger');
const { writeHeartbeat } = require('../../shared/heartbeat');
const { t }              = require('../../shared/i18n');
const { getPreferredLanguage, setPreferredLanguage } = require('../../shared/preferences');
const { isFormat } = require('./prompts');
const { generateContent, generateCaption } = require('./generate');
const { planFreeText, planFormatSelect, escapeHtml } = require('./router');

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

// Interface language for a chat — the shared preference, collapsed to a single
// UI language ('both'/unset/unknown → en; only explicit 'ru' → ru).
function uiLang(chatId) {
  return getPreferredLanguage(chatId) === 'ru' ? 'ru' : 'en';
}
const label = (format, lang) => t(`content.label_${format}`, lang);

// In-memory per-chat session: { format, awaiting, pendingTopic, lastTopic, lastDraft }.
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
// Keyboards (labels localized; drafts sent as PLAIN text — no MarkdownV2 — so
// hashtags '#', '.', '!' never need escaping and copy stays clean)
// ─────────────────────────────────────────────────────────────
function menuKeyboard(lang) {
  return {
    inline_keyboard: [
      [{ text: t('content.btn_post', lang), callback_data: 'fmt:post' }],
      [{ text: t('content.btn_ideas', lang), callback_data: 'fmt:ideas' }, { text: t('content.btn_plan', lang), callback_data: 'fmt:plan' }],
      [{ text: t('content.btn_photo', lang), callback_data: 'fmt:photo' }],
      [{ text: t('content.btn_lang', lang), callback_data: 'showlang' }],
    ],
  };
}

function draftKeyboard(lang) {
  // No Copy button: the draft is sent as a <pre> code block, which Telegram
  // renders with its own native one-tap copy icon (any length). Keyboard just
  // offers Regenerate / Menu.
  return {
    inline_keyboard: [[
      { text: t('content.btn_regen', lang), callback_data: 'regen' },
      { text: t('content.btn_menu', lang), callback_data: 'menu' },
    ]],
  };
}

function langKeyboard() {
  return {
    inline_keyboard: [[
      { text: '🇬🇧 English', callback_data: 'setlang:en' },
      { text: '🇷🇺 Русский', callback_data: 'setlang:ru' },
    ]],
  };
}

const showMenu = (bot, chatId, lang) =>
  bot.sendMessage(chatId, t('content.menu_prompt', lang), { reply_markup: menuKeyboard(lang) }).catch(() => {});

// ─────────────────────────────────────────────────────────────
// Core: generate a draft and send it (Copy / Regenerate / Menu)
// ─────────────────────────────────────────────────────────────
async function deliverDraft(bot, chatId, format, topic) {
  const lang = uiLang(chatId);
  logger.info({ format, topicPreview: String(topic || '').slice(0, 80) }, 'generating draft');
  bot.sendChatAction(chatId, 'typing').catch(() => {});
  const draft = await generateContent(format, topic); // OUTPUT is always English (prompt-enforced)
  const s = sessions.get(chatId) || {};
  s.format = format; s.lastTopic = topic; s.lastDraft = draft; s.awaiting = null; s.pendingTopic = null;
  sessions.set(chatId, s);
  const header = t('content.draft_header', lang, { format: label(format, lang) });
  const hint   = t('content.copy_hint', lang);
  // Body in a <pre> code block → Telegram shows a native one-tap copy icon that
  // copies the WHOLE post (any length) as clean text. parse_mode HTML; escape <pre>.
  const body = `${header}\n${hint}\n\n<pre>${escapeHtml(draft)}</pre>`;
  await bot.sendMessage(chatId, body, { parse_mode: 'HTML', reply_markup: draftKeyboard(lang) })
    .catch((err) => logger.error({ err: err.message }, 'draft send failed'));
}

// Download a Telegram photo (largest size) → base64. Telegram photos are JPEG.
async function downloadPhotoBase64(bot, fileId) {
  const link = await bot.getFileLink(fileId);
  const res  = await fetch(link);
  if (!res.ok) throw new Error(`photo download ${res.status}`);
  const buf  = Buffer.from(await res.arrayBuffer());
  return buf.toString('base64');
}

// C.4: generate a caption for a photo and deliver it (same <pre> one-tap-copy
// card as text drafts). The image is kept in-session so 🔄 Regenerate works.
async function deliverCaption(bot, chatId, base64, mediaType, context) {
  const lang = uiLang(chatId);
  logger.info({ hasContext: !!context }, 'generating photo caption (vision)');
  bot.sendChatAction(chatId, 'typing').catch(() => {});
  const caption = await generateCaption({ imageBase64: base64, mediaType, context }); // EN, child-safe (prompt)
  const s = sessions.get(chatId) || {};
  s.format = 'photo_caption'; s.lastDraft = caption; s.lastTopic = null; s.awaiting = null; s.pendingTopic = null;
  s.lastImage = { base64, mediaType, context };
  sessions.set(chatId, s);
  const header = t('content.draft_header', lang, { format: label('photo_caption', lang) });
  const hint   = t('content.copy_hint', lang);
  const body = `${header}\n${hint}\n\n<pre>${escapeHtml(caption)}</pre>`;
  await bot.sendMessage(chatId, body, { parse_mode: 'HTML', reply_markup: draftKeyboard(lang) })
    .catch((err) => logger.error({ err: err.message }, 'caption send failed'));
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
      await bot.sendMessage(chatId, t('content.access_denied', uiLang(chatId))).catch(() => {});
      return;
    }
    const lang = uiLang(chatId);

    // Photo → caption it (any photo is unambiguous caption intent). msg.caption =
    // optional note the user attached. Largest size is the last in msg.photo.
    if (Array.isArray(msg.photo) && msg.photo.length) {
      try {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const base64 = await downloadPhotoBase64(bot, fileId);
        await deliverCaption(bot, chatId, base64, 'image/jpeg', (msg.caption || '').trim());
      } catch (err) {
        logger.error({ err: err.message }, 'photo handling failed');
        await bot.sendMessage(chatId, t('content.expecting_photo', lang)).catch(() => {});
      }
      return;
    }

    const text = (msg.text || '').trim();

    if (text === '/start' || text === '/content') {
      sessions.set(chatId, {});
      await showMenu(bot, chatId, lang);
      return;
    }
    if (text === '/language' || text === '/lang') {
      await bot.sendMessage(chatId, t('content.lang_prompt', lang), { reply_markup: langKeyboard() }).catch(() => {});
      return;
    }
    if (text.startsWith('/')) {
      await showMenu(bot, chatId, lang);
      return;
    }

    // If we're waiting for a photo and the user typed text instead → nudge.
    const cur = sessions.get(chatId);
    if (cur && cur.awaiting === 'photo') {
      await bot.sendMessage(chatId, t('content.expecting_photo', lang)).catch(() => {});
      return;
    }

    // Free text → router (flow A: awaited topic → generate; flow B: typed first
    // → remember as pending, never drop). Input may be Russian; output stays EN.
    const plan = planFreeText(sessions.get(chatId), text);
    if (plan.action === 'generate') {
      await deliverDraft(bot, chatId, plan.format, plan.topic);
    } else if (plan.action === 'store') {
      const s = sessions.get(chatId) || {};
      s.pendingTopic = plan.topic;
      sessions.set(chatId, s);
      await bot.sendMessage(chatId, t('content.pending_stored', lang), { reply_markup: menuKeyboard(lang) }).catch(() => {});
    }
  });

  // ── Inline buttons ──
  bot.on('callback_query', async (query) => {
    const chatId = query.message && query.message.chat && query.message.chat.id;
    const data   = query.data || '';
    if (!isAllowed(chatId)) {
      await bot.answerCallbackQuery(query.id, { text: t('content.access_denied', uiLang(chatId)) }).catch(() => {});
      return;
    }
    const lang = uiLang(chatId);

    try {
      if (data === 'fmt:photo') {
        sessions.set(chatId, { format: 'photo_caption', awaiting: 'photo' });
        await bot.answerCallbackQuery(query.id).catch(() => {});
        await bot.sendMessage(chatId, t('content.ask_photo', lang)).catch(() => {});
        return;
      }
      if (data.startsWith('fmt:')) {
        const format = data.slice(4);
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const plan = planFormatSelect(sessions.get(chatId), format);
        if (plan.action === 'generate') {
          sessions.set(chatId, { format });
          await deliverDraft(bot, chatId, format, plan.topic);
        } else if (plan.action === 'ask') {
          sessions.set(chatId, { format, awaiting: 'topic' });
          await bot.sendMessage(chatId, t('content.ask_topic', lang, { format: label(format, lang) }), { parse_mode: 'Markdown' }).catch(() => {});
        }
        return;
      }
      if (data === 'showlang') {
        await bot.answerCallbackQuery(query.id).catch(() => {});
        await bot.sendMessage(chatId, t('content.lang_prompt', lang), { reply_markup: langKeyboard() }).catch(() => {});
        return;
      }
      if (data.startsWith('setlang:')) {
        const newLang = data.slice(8) === 'ru' ? 'ru' : 'en';
        setPreferredLanguage(chatId, newLang);
        await bot.answerCallbackQuery(query.id).catch(() => {});
        await bot.sendMessage(chatId, t('content.lang_set', newLang)).catch(() => {});
        await showMenu(bot, chatId, newLang);
        return;
      }
      if (data === 'menu') {
        sessions.set(chatId, {});
        await bot.answerCallbackQuery(query.id).catch(() => {});
        await showMenu(bot, chatId, lang);
        return;
      }
      if (data === 'regen') {
        const s = sessions.get(chatId);
        if (s && s.format === 'photo_caption' && s.lastImage) {
          await bot.answerCallbackQuery(query.id, { text: t('content.regenerating', lang) }).catch(() => {});
          await deliverCaption(bot, chatId, s.lastImage.base64, s.lastImage.mediaType, s.lastImage.context);
        } else if (s && isFormat(s.format) && s.lastTopic) {
          await bot.answerCallbackQuery(query.id, { text: t('content.regenerating', lang) }).catch(() => {});
          await deliverDraft(bot, chatId, s.format, s.lastTopic);
        } else {
          await bot.answerCallbackQuery(query.id, { text: t('content.nothing_regen', lang) }).catch(() => {});
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

  logger.info('Content-bot running ✅ (C.2 text formats — RU/EN UI, EN output)');
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

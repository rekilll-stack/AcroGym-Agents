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
const { generateContent, generateCaption, generateHeadlines } = require('./generate');
const { planFreeText, planFormatSelect, escapeHtml } = require('./router');
const { composeBrandedImage, loadManifest } = require('./image');
// Phase 1–3: autonomous posting (visuals via Canva, publish via Metricool).
const publish   = require('./publish');
const calendar  = require('./calendar');
const metricool = require('./metricool');
const yandex    = require('./yandex');
const assemble  = require('./assemble');

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
      [{ text: t('content.btn_branded', lang), callback_data: 'branded' }],
      [{ text: t('content.btn_lang', lang), callback_data: 'showlang' }],
    ],
  };
}

// Track D — backgrounds the user may pick. Real (non-dev) entries normally; if
// none exist yet, fall back to dev entries (e.g. _test.png) so the 🎨 flow is
// usable until Kirill drops real Canva backgrounds. Returns { list, devOnly }.
function selectableBackgrounds() {
  const all = loadManifest();
  const real = all.filter((b) => b && b.file && !b.dev);
  if (real.length) return { list: real, devOnly: false };
  return { list: all.filter((b) => b && b.file), devOnly: true };
}

// Keyboard of background choices (one per row) + Menu.
function bgKeyboard(lang, list) {
  const rows = list.map((b) => [{
    text: (b.label && (b.label[lang] || b.label.en)) || b.file,
    callback_data: `bg:${b.file}`,
  }]);
  rows.push([{ text: t('content.btn_menu', lang), callback_data: 'menu' }]);
  return { inline_keyboard: rows };
}

// After a branded image is sent: Redo (re-enter headline, same background) / Menu.
function brandedDraftKeyboard(lang) {
  return {
    inline_keyboard: [[
      { text: t('content.btn_regen', lang), callback_data: 'branded_redo' },
      { text: t('content.btn_menu', lang), callback_data: 'menu' },
    ]],
  };
}

// Style picker shown after a background is chosen: "Clean" (default engine) or
// "IG-style" (funky Instagram look — cream Lilita One + orange pill). The owner
// picks by mood; both produce a draft, nothing is published.
function styleKeyboard(lang) {
  return {
    inline_keyboard: [[
      { text: t('content.btn_style_clean', lang), callback_data: 'style:clean' },
      { text: t('content.btn_style_ig', lang), callback_data: 'style:ig' },
    ]],
  };
}

// When asking for the headline: offer ✨ generate (D.3) alongside manual typing.
function headlineAskKeyboard(lang) {
  return { inline_keyboard: [[{ text: t('content.btn_gen_headline', lang), callback_data: 'gen_headline' }]] };
}

// Generated headline options as pick-buttons + "3 more". The options live in the
// session (callback_data only carries the index — Telegram's 64-byte limit).
function headlineOptionsKeyboard(lang, opts) {
  const rows = opts.map((o, i) => [{ text: o.slice(0, 60), callback_data: `pick_h:${i}` }]);
  rows.push([{ text: t('content.btn_gen_more', lang), callback_data: 'gen_more' }]);
  return { inline_keyboard: rows };
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

// Track D — compose a branded image from a chosen background + a SHORT headline
// (Kirill's own text — NO AI text generation here) and send it as a DRAFT photo.
// 🔴 BOUNDARY: nothing is published — the photo goes to the chat; Kirill posts
// to Instagram by hand. No Instagram/publish code exists here.
async function deliverBrandedImage(bot, chatId, bgFile, textZone, headline) {
  const lang = uiLang(chatId);
  const sess = sessions.get(chatId) || {};
  const style = sess.style === 'ig' ? 'ig' : 'clean';
  logger.info({ bgFile, textZone, style, headlinePreview: String(headline || '').slice(0, 60) }, 'composing branded image');
  bot.sendChatAction(chatId, 'upload_photo').catch(() => {});
  // 'clean' = default engine (Montserrat Black, centered); 'ig' = funky layout.
  const buffer = await composeBrandedImage({
    backgroundPath: path.join('config/brand/backgrounds', bgFile),
    text: headline,
    textZone: textZone || 'bottom',
    style,
  });
  const s = sessions.get(chatId) || {};
  s.format = 'branded'; s.bg = bgFile; s.textZone = textZone || 'bottom'; s.style = style;
  s.lastHeadline = headline; s.awaiting = null;
  sessions.set(chatId, s);
  await bot.sendPhoto(chatId, buffer, {
    caption: t('content.branded_caption', lang),
    reply_markup: brandedDraftKeyboard(lang),
  }).catch((err) => logger.error({ err: err.message }, 'branded image send failed'));
}

// D.3 — generate 3 English headline options for a theme and show them as pick
// buttons. 🔴 The owner PICKS one (or types own / taps "3 more") — nothing is
// auto-applied; the picked text then goes onto the image.
async function deliverHeadlineOptions(bot, chatId, topic) {
  const lang = uiLang(chatId);
  bot.sendChatAction(chatId, 'typing').catch(() => {});
  await bot.sendMessage(chatId, t('content.branded_generating', lang)).catch(() => {});
  const opts = await generateHeadlines(topic); // English, brand voice; safe fallback
  const s = sessions.get(chatId) || {};
  s.genTopic = topic; s.genOptions = opts; s.awaiting = 'headline'; // typed text → manual headline
  sessions.set(chatId, s);
  await bot.sendMessage(chatId, t('content.branded_pick', lang), {
    reply_markup: headlineOptionsKeyboard(lang, opts),
  }).catch((err) => logger.error({ err: err.message }, 'headline options send failed'));
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
    // ── Autopilot: on-demand post (Phase 3). /post <topic> → assemble via Canva,
    //    self-verify, then approval card. routine=false → never auto-publishes.
    if (text === '/post' || text.startsWith('/post ')) {
      const topic = text.slice(5).trim();
      if (!topic) { await bot.sendMessage(chatId, '📝 Тема? Напр.: /post throwback to last week’s competition').catch(() => {}); return; }
      await bot.sendMessage(chatId, '🎨 Собираю пост через Canva и проверяю по 2 раза…').catch(() => {});
      try {
        await calendar.buildAndRoute(bot, chatId, { theme: topic, slides: 4, routine: false });
      } catch (err) {
        logger.error({ err: err.message }, '/post failed');
        await bot.sendMessage(chatId, '❌ ' + err.message).catch(() => {});
      }
      return;
    }
    if (text === '/autopilot') {
      const lines = [
        '🤖 <b>Autopilot</b>',
        `Canva: ${assemble.isConfigured() ? '✅' : '❌ (нужен canva-auth + data/canva-templates.json)'}`,
        `Yandex.Disk: ${yandex.isConfigured() ? '✅' : '❌ (нужен YANDEX_DISK_TOKEN)'}`,
        `Metricool: ${metricool.isConfigured() ? '✅ публикация активна' : '❌ только превью (нужен METRICOOL_USER_TOKEN/USER_ID)'}`,
        '',
        '• <code>/post &lt;тема&gt;</code> — собрать пост на согласование',
        '• Расписание: ' + calendar.PLAN.map((p) => `${p.name} (${p.cron})`).join(', '),
      ];
      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' }).catch(() => {});
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

    // Track D (D.3): waiting for the headline-generation theme → generate 3 options.
    if (cur && cur.awaiting === 'gen_topic' && cur.bg) {
      const topic = (text === '-' || text === '—') ? '' : text;
      try {
        await deliverHeadlineOptions(bot, chatId, topic);
      } catch (err) {
        logger.error({ err: err.message }, 'headline generation failed');
        await bot.sendMessage(chatId, '❌ ' + err.message).catch(() => {});
      }
      return;
    }

    // Track D: waiting for the branded-image headline → this text IS the headline.
    if (cur && cur.awaiting === 'headline' && cur.bg) {
      if (!text) { await bot.sendMessage(chatId, t('content.branded_ask_headline', lang)).catch(() => {}); return; }
      // soft length guard: short hooks render best; warn but still proceed
      if (text.length > 50) await bot.sendMessage(chatId, t('content.branded_long_note', lang)).catch(() => {});
      try {
        await deliverBrandedImage(bot, chatId, cur.bg, cur.textZone, text);
      } catch (err) {
        logger.error({ err: err.message }, 'branded compose failed');
        await bot.sendMessage(chatId, '❌ ' + err.message).catch(() => {});
      }
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
      // Autopilot approval buttons (publish / best-time / discard).
      if (data.startsWith('pub:')) {
        const status = await publish.handleCallback(bot, chatId, data);
        await bot.answerCallbackQuery(query.id, status ? { text: status } : {}).catch(() => {});
        return;
      }
      if (data === 'fmt:photo') {
        sessions.set(chatId, { format: 'photo_caption', awaiting: 'photo' });
        await bot.answerCallbackQuery(query.id).catch(() => {});
        await bot.sendMessage(chatId, t('content.ask_photo', lang)).catch(() => {});
        return;
      }
      // Track D — 🎨 branded image: start the flow (choose a background).
      if (data === 'branded') {
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const { list, devOnly } = selectableBackgrounds();
        if (!list.length) {
          await bot.sendMessage(chatId, t('content.branded_no_bg', lang), { reply_markup: menuKeyboard(lang) }).catch(() => {});
          return;
        }
        sessions.set(chatId, { format: 'branded', awaiting: 'bg' });
        if (devOnly) await bot.sendMessage(chatId, t('content.branded_dev_note', lang)).catch(() => {});
        await bot.sendMessage(chatId, t('content.branded_choose_bg', lang), { reply_markup: bgKeyboard(lang, list) }).catch(() => {});
        return;
      }
      // Background chosen → ask which style (clean / IG) before the headline.
      if (data.startsWith('bg:')) {
        const file = data.slice(3);
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const entry = loadManifest().find((b) => b && b.file === file);
        if (!entry) { await bot.sendMessage(chatId, t('content.branded_no_bg', lang)).catch(() => {}); return; }
        sessions.set(chatId, { format: 'branded', bg: file, textZone: entry.textZone || 'bottom', awaiting: 'style' });
        await bot.sendMessage(chatId, t('content.branded_choose_style', lang), { reply_markup: styleKeyboard(lang) }).catch(() => {});
        return;
      }
      // Style chosen → ask for the short headline.
      if (data.startsWith('style:')) {
        const s = sessions.get(chatId);
        await bot.answerCallbackQuery(query.id).catch(() => {});
        if (!s || !s.bg) { await bot.sendMessage(chatId, t('content.branded_no_bg', lang)).catch(() => {}); return; }
        s.style = data.slice(6) === 'ig' ? 'ig' : 'clean';
        s.awaiting = 'headline';
        sessions.set(chatId, s);
        await bot.sendMessage(chatId, t('content.branded_ask_headline', lang), { reply_markup: headlineAskKeyboard(lang) }).catch(() => {});
        return;
      }
      // ✨ Generate headline (D.3) → ask for a theme (optional).
      if (data === 'gen_headline') {
        const s = sessions.get(chatId);
        await bot.answerCallbackQuery(query.id).catch(() => {});
        if (!s || !s.bg) { await bot.sendMessage(chatId, t('content.branded_no_bg', lang)).catch(() => {}); return; }
        s.awaiting = 'gen_topic'; sessions.set(chatId, s);
        await bot.sendMessage(chatId, t('content.branded_ask_theme', lang)).catch(() => {});
        return;
      }
      // 🔄 3 more — regenerate options for the same theme.
      if (data === 'gen_more') {
        const s = sessions.get(chatId);
        await bot.answerCallbackQuery(query.id).catch(() => {});
        if (!s || !s.bg) { await bot.sendMessage(chatId, t('content.branded_no_bg', lang)).catch(() => {}); return; }
        try { await deliverHeadlineOptions(bot, chatId, s.genTopic || ''); }
        catch (err) { logger.error({ err: err.message }, 'headline regen failed'); await bot.sendMessage(chatId, '❌ ' + err.message).catch(() => {}); }
        return;
      }
      // Picked one of the 3 generated headlines → compose with it.
      if (data.startsWith('pick_h:')) {
        const s = sessions.get(chatId);
        const i = parseInt(data.slice(7), 10);
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const headline = s && s.genOptions && s.genOptions[i];
        if (!s || !s.bg || !headline) { await bot.sendMessage(chatId, t('content.nothing_regen', lang)).catch(() => {}); return; }
        try { await deliverBrandedImage(bot, chatId, s.bg, s.textZone, headline); }
        catch (err) { logger.error({ err: err.message }, 'branded compose failed'); await bot.sendMessage(chatId, '❌ ' + err.message).catch(() => {}); }
        return;
      }
      // 🔄 Заново for a branded image → re-enter the headline on the same background.
      if (data === 'branded_redo') {
        const s = sessions.get(chatId);
        if (s && s.bg) {
          s.awaiting = 'headline'; sessions.set(chatId, s);
          await bot.answerCallbackQuery(query.id).catch(() => {});
          await bot.sendMessage(chatId, t('content.branded_ask_headline', lang), { reply_markup: headlineAskKeyboard(lang) }).catch(() => {});
        } else {
          await bot.answerCallbackQuery(query.id, { text: t('content.nothing_regen', lang) }).catch(() => {});
        }
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

  // ── Autopilot content calendar (Phase 3). Owner = first allow-listed chat.
  //    Routine themes may auto-publish AFTER self-verification; everything else
  //    waits for an approval tap. Safe no-op if Canva/Metricool unconfigured
  //    (jobs will just report they couldn't assemble).
  try {
    if (ALLOWED.length) {
      calendar.start(bot, ALLOWED[0]);
      logger.info({ owner: ALLOWED[0] }, 'autopilot calendar started');
    }
  } catch (err) {
    logger.error({ err: err.message }, 'autopilot calendar start failed');
  }

  logger.info('Content-bot running ✅ (C.2 text + autopilot: Canva→verify→Metricool gate)');
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

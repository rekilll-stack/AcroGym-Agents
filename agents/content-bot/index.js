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

// The required modules below each register an 'exit' cleanup listener on
// `process` (11 total) — a static count at startup, not a leak. Raise the limit
// above the default 10 BEFORE those requires run, so the false-positive
// MaxListenersExceededWarning never fires.
process.setMaxListeners(20);

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
const { escapeHtml } = require('./router');
const { composeBrandedImage, loadManifest } = require('./image');
// Phase 1–3: autonomous posting (visuals via Canva, publish via Metricool).
const publish   = require('./publish');
const calendar  = require('./calendar');
const contentPlan = require('./plan');
const metricool = require('./metricool');
const yandex    = require('./yandex');
const assemble  = require('./assemble');
const video     = require('./video');

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

const studioStop = new Set(); // chatId студий, которым владелец нажал 🛑 Стоп — петля остановится
const scoutSessions = new Map(); // sid → {chatId, theme, candidates:[{path,name}], selected:Set} — скаут-подбор фото

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
// Главное меню — СПЕЦИАЛЬНО простое (для жены-контентщицы): два больших действия
// «пост» и «сторис» под её фото/видео, плюс «Ещё» с продвинутыми инструментами
// (автопилот/план/анализ) — чтобы не пугать кнопками. Владельцу всё доступно через ⚙️.
function menuKeyboard(lang) {
  const ru = lang === 'ru';
  return {
    inline_keyboard: [
      [{ text: ru ? '📝 Сделать пост' : '📝 Make a post', callback_data: 'make:post' }],
      [{ text: ru ? '📱 Сделать сторис' : '📱 Make a story', callback_data: 'make:story' }],
      [{ text: ru ? '⚙️ Ещё' : '⚙️ More', callback_data: 'more:menu' },
       { text: t('content.btn_lang', lang), callback_data: 'showlang' }],
    ],
  };
}

// Продвинутое меню (владелец): всё, что было в старом главном — автопилот, план,
// анализ, сторис/reel по теме. Открывается по «⚙️ Ещё».
function advancedKeyboard(lang) {
  const ru = lang === 'ru';
  return {
    inline_keyboard: [
      [{ text: ru ? '✨ Авто-пост (Canva)' : '✨ Auto-post (Canva)', callback_data: 'auto:new' }],
      [{ text: ru ? '📅 Контент-план' : '📅 Content plan', callback_data: 'plan:new' },
       { text: ru ? '📋 Показать план' : '📋 Show plan', callback_data: 'plan:show' }],
      [{ text: ru ? '🔎 Анализ конкурентов' : '🔎 Competitor analysis', callback_data: 'plan:analyze' }],
      // Убраны по решению владельца (20.07): 🤖 Статус автопилота (диагностика), 📱 Сторис/🎬 Reel
      // по теме (сборка из стоковых медиа — дублировали авто-пост/студию). Обработчики оставлены
      // живыми (текст-команды /autopilot /story /reel как алиасы), просто нет кнопок.
      [{ text: t('content.btn_menu', lang), callback_data: 'menu' }],
    ],
  };
}

// Autopilot status text (shared by the 🤖 button and /autopilot command).
function autopilotStatusText() {
  const agent = require('./agent');
  return [
    '🤖 <b>Autopilot</b>',
    `Canva: ${assemble.isConfigured() ? '✅' : '❌ (canva-auth + carousel.templateDesignId)'}`,
    `Yandex.Disk: ${yandex.isConfigured() ? '✅' : '❌ (YANDEX_DISK_TOKEN)'}`,
    `Публикация: ${publish.canPublish() ? (metricool.isConfigured() ? '✅ Metricool REST' : '✅ через Metricool-коннектор (без токена)') : '❌ только превью'}`,
    '',
    `Designer-модель: <code>${agent.MODEL}</code> · лимит/пост: $${agent.MAX_COST_USD}`,
    `Расписание: ${calendar.PLAN.map((p) => `${p.name} (${p.cron})`).join(', ')}`,
  ].join('\n');
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

// A single ⬅️ Menu button — appended to every prompt so no step is a dead-end
// (owner rule: there must always be a way back). Optionally merge extra rows.
const menuKb = (lang, extraRows = []) =>
  ({ inline_keyboard: [...extraRows, [{ text: t('content.btn_menu', lang), callback_data: 'menu' }]] });

// Content-plan keyboards: review a draft plan (approve/regenerate/edit) and the
// approved-plan view (build next / new plan). Always a way back to the menu.
const planReviewKb = (lang) => ({ inline_keyboard: [
  [{ text: lang === 'ru' ? '✅ Утвердить план' : '✅ Approve plan', callback_data: 'plan:approve' }],
  [{ text: lang === 'ru' ? '🔄 Другой план' : '🔄 Regenerate', callback_data: 'plan:regen' }],
  [{ text: t('content.btn_menu', lang), callback_data: 'menu' }],
] });
const planShowKb = (lang) => ({ inline_keyboard: [
  [{ text: lang === 'ru' ? '▶️ Собрать следующий сейчас' : '▶️ Build next now', callback_data: 'plan:buildnext' }],
  [{ text: lang === 'ru' ? '🔄 Новый план' : '🔄 New plan', callback_data: 'plan:new' }],
  [{ text: t('content.btn_menu', lang), callback_data: 'menu' }],
] });

// Propose a content plan to the owner: generate a draft (strategist), set the
// review state, and send the strategy + numbered draft with review buttons.
// Shared by the 📅 button AND the weekly auto-plan cron.
async function proposePlanToOwner(bot, chatId) {
  const lang = uiLang(chatId);
  const ru = lang === 'ru';
  const items = await contentPlan.generateDraft(chatId, { lang });
  const s = sessions.get(chatId) || {}; s.awaiting = 'plan_review'; sessions.set(chatId, s);
  const pend = contentPlan.getPending(chatId);
  const strategyLine = pend && pend.strategy
    ? `🧭 <b>${ru ? 'Стратегия' : 'Strategy'}</b> (${ru ? 'анализ конкурентов в Катаре' : 'Qatar competitor analysis'}):\n<i>${escapeHtml(pend.strategy)}</i>\n\n`
    : '';
  const body = ru
    ? `${strategyLine}📅 <b>Черновик плана</b> (${items.length} постов):\n\n${escapeHtml(contentPlan.renderPending(items))}\n\n✏️ Изменить строку — напиши «2: новая тема». Потом ✅ Утвердить.`
    : `${strategyLine}📅 <b>Draft plan</b> (${items.length} posts):\n\n${escapeHtml(contentPlan.renderPending(items))}\n\n✏️ To edit a line, write "2: new topic". Then ✅ Approve.`;
  await bot.sendMessage(chatId, body,
    { parse_mode: 'HTML', reply_markup: planReviewKb(lang) }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────
// Core: generate a draft and send it (Copy / Regenerate / Menu)
// ─────────────────────────────────────────────────────────────
async function deliverDraft(bot, chatId, format, topic) {
  const lang = uiLang(chatId);
  logger.info({ format, topicPreview: String(topic || '').slice(0, 80) }, 'generating draft');
  bot.sendChatAction(chatId, 'typing').catch(() => {});
  // A 'post' is always English (published content); 'plan'/'ideas' follow the
  // owner's interface language (planning notes the owner reads).
  const draft = await generateContent(format, topic, { lang });
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
// «Помощник контентщика» (для жены): она жмёт 📝 Пост или 📱 Сторис, шлёт фото/видео
// → бот оформляет и присылает КАРТОЧКУ с кнопкой «✅ Опубликовать сейчас» (та же
// publish-инфраструктура, что у автопилота). Публикация всегда по её тапу.
// ─────────────────────────────────────────────────────────────

// Одна точка загрузки медиа в публичный URL для публикации (Metricool/agent хотят
// URL, не буфер). При сбое возвращает null — карточка всё равно покажет превью из
// буфера и подпись для ручной вставки.
async function toPublicUrl(buffer, name, contentType) {
  try { const up = await yandex.uploadPublic(buffer, name, { contentType }); return up.directUrl; }
  catch (e) { logger.warn({ e: e.message, name }, 'wife media public-upload failed → preview-only'); return null; }
}

// Фото → готовый ПОСТ: подпись (vision, бренд-голос, хэштеги) + карточка публикации.
async function deliverPostFromPhoto(bot, chatId, buffer, note) {
  bot.sendChatAction(chatId, 'upload_photo').catch(() => {});
  await bot.sendMessage(chatId, '📝 Пишу подпись и подбираю хэштеги…').catch(() => {});
  const caption = await generateCaption({ imageBase64: buffer.toString('base64'), mediaType: 'image/jpeg', context: note || '' });
  const url = await toPublicUrl(buffer, `wife-${Date.now()}.jpg`, 'image/jpeg');
  const draft = publish.newDraft({ kind: 'post', igType: 'POST', caption, slides: [{ url, buffer, alt: 'AcroGym' }], source: 'жена: фото → пост' });
  await publish.sendApprovalCard(bot, chatId, draft);
}

// Фото → БРЕНДОВАЯ сторис 9:16 (её фото + лого/рамка через Canva) + карточка публикации.
async function deliverStoryFromPhoto(bot, chatId, buffer, note) {
  bot.sendChatAction(chatId, 'upload_photo').catch(() => {});
  await bot.sendMessage(chatId, '🎨 Собираю брендовую сторис в фирстиле (это ~минута)…').catch(() => {});
  let headline = 'ACROGYM';
  try { const hs = await generateHeadlines(note || 'a joyful AcroGym kids moment'); if (hs && hs[0]) headline = String(hs[0]).toUpperCase().slice(0, 22); } catch { /* дефолт */ }
  let frame;
  try {
    frame = await assemble.buildStoryFrame({ photo: { buffer, name: `wife-${Date.now()}.jpg` }, headline, cta: 'BOOK YOUR FIRST CLASS' });
  } catch (e) {
    logger.warn({ e: e.message }, 'branded story build failed → откат на подпись');
    await bot.sendMessage(chatId, '⚠️ Брендовую сторис собрать не вышло — держи подпись к фото, можно выложить так:').catch(() => {});
    await deliverPostFromPhoto(bot, chatId, buffer, note);
    return;
  }
  let caption = '';
  try { caption = await generateCaption({ imageBase64: buffer.toString('base64'), mediaType: 'image/jpeg', context: note || '' }); } catch { /* сторис-подпись необязательна */ }
  const draft = publish.newDraft({ kind: 'story', igType: 'STORY', caption, costUsd: frame.costUsd,
    slides: [{ url: frame.url, buffer: frame.buffer, alt: 'AcroGym story' }], source: 'жена: фото → брендовая сторис' });
  await publish.sendApprovalCard(bot, chatId, draft);
}

// Кадр из видео (ffmpeg) для vision-подписи. Возвращает JPEG-буфер или null.
async function extractVideoFrame(videoBuffer) {
  const os = require('os'); const { execFile } = require('child_process');
  const base = path.join(os.tmpdir(), `vf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const inp = `${base}.mp4`, out = `${base}.jpg`;
  fs.writeFileSync(inp, videoBuffer);
  const run = (args) => new Promise((res, rej) => execFile('ffmpeg', args, { timeout: 30000 }, (e) => e ? rej(e) : res()));
  try {
    try { await run(['-y', '-ss', '0.5', '-i', inp, '-frames:v', '1', '-q:v', '3', out]); }
    catch { await run(['-y', '-i', inp, '-frames:v', '1', '-q:v', '3', out]); } // очень короткое видео → кадр 0
    return fs.readFileSync(out);
  } catch (e) { logger.warn({ e: e.message }, 'video frame extract failed'); return null; }
  finally { try { fs.unlinkSync(inp); } catch {} try { fs.unlinkSync(out); } catch {} }
}

// Видео → пост (Reel) или сторис: кадр→подпись + карточка публикации с превью видео.
async function deliverFromVideo(bot, chatId, buffer, note, mode) {
  bot.sendChatAction(chatId, 'upload_video').catch(() => {});
  await bot.sendMessage(chatId, '🎬 Оформляю видео в фирстиле (лого) и пишу подпись — ~минута…').catch(() => {});
  // Подпись — по кадру из видео (vision); текстовый фолбэк, если кадр не достать.
  const frame = await extractVideoFrame(buffer);
  const caption = frame
    ? await generateCaption({ imageBase64: frame.toString('base64'), mediaType: 'image/jpeg', context: note || '' })
    : await generateContent('post', note || 'A joyful moment at AcroGym kids gym', { lang: 'en' });
  // Брендирование: логотип поверх её ролика (9:16, её действие не режется — pad).
  // При сбое ffmpeg — мягкий откат на сырое видео, чтобы она всё равно получила пост.
  const os = require('os');
  const tmpIn = path.join(os.tmpdir(), `wv-${Date.now()}.mp4`);
  let outBuffer = buffer;
  try {
    fs.writeFileSync(tmpIn, buffer);
    const branded = await video.brandReel(tmpIn);
    outBuffer = branded.buffer;
  } catch (e) {
    logger.warn({ e: e.message }, 'brandReel failed → сырое видео');
    await bot.sendMessage(chatId, '⚠️ Фирстиль на видео наложить не вышло — держи ролик как есть + подпись.').catch(() => {});
  } finally { try { fs.unlinkSync(tmpIn); } catch {} }
  const url = await toPublicUrl(outBuffer, `wife-${Date.now()}.mp4`, 'video/mp4');
  const story = mode === 'story';
  const draft = publish.newDraft({ kind: story ? 'story' : 'reel', igType: story ? 'STORY' : 'REEL', caption,
    slides: [{ url, buffer: outBuffer, isVideo: true, alt: 'AcroGym' }],
    source: story ? 'жена: видео → брендовая сторис' : 'жена: видео → брендовый пост (Reel)' });
  await publish.sendApprovalCard(bot, chatId, draft);
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
      // В группах/супергруппах МОЛЧИМ (не спамим access denied) — content-bot там пассивен,
      // постит только по триггеру студии. Access denied оставляем только для личек (чужой DM).
      const isGroup = msg.chat && (msg.chat.type === 'group' || msg.chat.type === 'supergroup');
      if (isGroup) return;
      logger.warn({ chatId, from: msg.from && msg.from.username }, 'denied: chat_id not allow-listed');
      await bot.sendMessage(chatId, t('content.access_denied', uiLang(chatId))).catch(() => {});
      return;
    }
    const lang = uiLang(chatId);

    // ── Медиа от пользователя. Режим задаётся кнопкой 📝 Пост / 📱 Сторис (в сессии);
    //    если кнопку не жали (просто прислала фото/видео) — по умолчанию ПОСТ.
    const mediaMode = (sessions.get(chatId) || {}).mode === 'story' ? 'story' : 'post';
    const mediaNote = (msg.caption || '').trim();
    // Фото → пост (подпись+хэштеги) ИЛИ брендовая сторис — по выбранному режиму.
    if (Array.isArray(msg.photo) && msg.photo.length) {
      try {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const buffer = Buffer.from(await downloadPhotoBase64(bot, fileId), 'base64');
        sessions.set(chatId, {}); // режим отработан
        if (mediaMode === 'story') await deliverStoryFromPhoto(bot, chatId, buffer, mediaNote);
        else await deliverPostFromPhoto(bot, chatId, buffer, mediaNote);
      } catch (err) {
        logger.error({ err: err.message }, 'photo handling failed');
        await bot.sendMessage(chatId, t('content.expecting_photo', lang)).catch(() => {});
      }
      return;
    }
    // Видео (или пересланное видео-документом) → пост (Reel) или сторис — тот же режим.
    const vid = msg.video || (msg.document && /^video\//.test(msg.document.mime_type || '') ? msg.document : null);
    if (vid) {
      try {
        const link = await bot.getFileLink(vid.file_id); // >20МБ Telegram-бот не отдаёт → бросит
        const res = await fetch(link);
        if (!res.ok) throw new Error(`video download ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        sessions.set(chatId, {});
        await deliverFromVideo(bot, chatId, buffer, mediaNote, mediaMode);
      } catch (err) {
        logger.error({ err: err.message }, 'video handling failed');
        await bot.sendMessage(chatId, lang === 'ru'
          ? '⚠️ Не смог забрать видео (возможно, больше 20 МБ — столько Telegram-боты не качают). Пришли клип покороче/полегче или загрузи фото.'
          : '⚠️ Could not fetch the video (Telegram bots can\'t download files over 20MB). Send a shorter clip or a photo.').catch(() => {});
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
      await bot.sendMessage(chatId, t('content.lang_prompt', lang), { reply_markup: menuKb(lang, langKeyboard().inline_keyboard) }).catch(() => {});
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
    // On-demand single STORY (9:16). routine=false → approval card, never auto-posts.
    if (text === '/story' || text.startsWith('/story ')) {
      const topic = text.slice(6).trim();
      if (!topic) { await bot.sendMessage(chatId, '📱 Тема сторис? Напр.: /story behind the scenes setting up the gym').catch(() => {}); return; }
      await bot.sendMessage(chatId, '🎨 Собираю сторис 9:16 через Canva…').catch(() => {});
      try { await calendar.buildStoryAndRoute(bot, chatId, { theme: topic, routine: false }); }
      catch (err) { logger.error({ err: err.message }, '/story failed'); await bot.sendMessage(chatId, '❌ ' + err.message).catch(() => {}); }
      return;
    }
    // On-demand REEL (9:16 motion). Delivered as a Telegram video (not auto-posted).
    if (text === '/reel' || text.startsWith('/reel ')) {
      const topic = text.slice(5).trim();
      if (!topic) { await bot.sendMessage(chatId, '🎬 Тема Reel? Напр.: /reel a joyful moment in training').catch(() => {}); return; }
      await bot.sendMessage(chatId, '🎬 Собираю Reel 9:16 с движением (Canva + ffmpeg)…').catch(() => {});
      try { await calendar.buildReelAndRoute(bot, chatId, { theme: topic }); }
      catch (err) { logger.error({ err: err.message }, '/reel failed'); await bot.sendMessage(chatId, '❌ ' + err.message).catch(() => {}); }
      return;
    }
    if (text === '/autopilot') {
      await bot.sendMessage(chatId, autopilotStatusText(), { parse_mode: 'HTML' }).catch(() => {});
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
    // Ждём медиа для поста/сторис, а пришёл текст → мягко напомнить (текст учтётся как подпись к медиа).
    if (cur && cur.awaiting === 'wife_media') {
      await bot.sendMessage(chatId, lang === 'ru'
        ? '📎 Жду фото или видео. Пришли медиа — а этот текст можно добавить подписью прямо к нему.'
        : '📎 Send a photo or video — you can attach this text as a note to it.').catch(() => {});
      return;
    }

    // ✨ Autopilot: waiting for the post theme (from the menu button) → build it.
    if (cur && cur.awaiting === 'auto_topic') {
      const topic = (text === '-' || text === '—' || !text) ? 'Weekly recap — highlights from this week at AcroGym' : text;
      sessions.set(chatId, {});
      await bot.sendMessage(chatId, '🎨 Собираю пост через Canva и проверяю по 2 раза…').catch(() => {});
      try {
        await calendar.buildAndRoute(bot, chatId, { theme: topic, slides: 4, routine: false });
      } catch (err) {
        logger.error({ err: err.message }, 'autopilot /post (button) failed');
        await bot.sendMessage(chatId, '❌ ' + err.message).catch(() => {});
      }
      return;
    }

    // 📱 Story theme (from the menu button) → build a 9:16 story (approval card).
    if (cur && cur.awaiting === 'story_topic') {
      const topic = (text === '-' || text === '—' || !text) ? 'Behind the scenes at AcroGym' : text;
      sessions.set(chatId, {});
      await bot.sendMessage(chatId, '🎨 Собираю сторис 9:16 через Canva…').catch(() => {});
      try {
        await calendar.buildStoryAndRoute(bot, chatId, { theme: topic, routine: false });
      } catch (err) {
        logger.error({ err: err.message }, 'story (button) failed');
        await bot.sendMessage(chatId, '❌ ' + err.message).catch(() => {});
      }
      return;
    }

    // 🎬 Reel theme (from the menu button) → build a 9:16 motion reel (delivered as video).
    if (cur && cur.awaiting === 'reel_topic') {
      const topic = (text === '-' || text === '—' || !text) ? 'A joyful moment in training at AcroGym' : text;
      sessions.set(chatId, {});
      await bot.sendMessage(chatId, '🎬 Собираю Reel 9:16 с движением (Canva + ffmpeg)…').catch(() => {});
      try {
        await calendar.buildReelAndRoute(bot, chatId, { theme: topic });
      } catch (err) {
        logger.error({ err: err.message }, 'reel (button) failed');
        await bot.sendMessage(chatId, '❌ ' + err.message).catch(() => {});
      }
      return;
    }

    // 📅 Reviewing a draft content plan: "2: new theme" edits a line; anything
    // else nudges. Approval/regeneration happen via the inline buttons.
    if (cur && cur.awaiting === 'plan_review') {
      const pend = contentPlan.getPending(chatId);
      if (!pend) { await bot.sendMessage(chatId, 'Черновик плана не найден — собери заново 📅.', { reply_markup: menuKeyboard(lang) }).catch(() => {}); sessions.set(chatId, {}); return; }
      const m = text.match(/^(\d+)\s*[:.\-)]\s*(.+)$/);
      if (m) {
        const items = contentPlan.editPendingLine(chatId, parseInt(m[1], 10), m[2]);
        if (!items) { await bot.sendMessage(chatId, `Нет строки ${m[1]} — в плане ${pend.items.length} строк(и).`, { reply_markup: planReviewKb(lang) }).catch(() => {}); return; }
        await bot.sendMessage(chatId,
          `✏️ Обновил:\n\n${escapeHtml(contentPlan.renderPending(items))}\n\nЕщё правка («2: …») или ✅ Утвердить.`,
          { parse_mode: 'HTML', reply_markup: planReviewKb(lang) }).catch(() => {});
      } else {
        await bot.sendMessage(chatId,
          'Чтобы изменить строку — напиши «2: новая тема». Или жми ✅ Утвердить / 🔄 Другой план.',
          { reply_markup: planReviewKb(lang) }).catch(() => {});
      }
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

    // No free-text text-drafts any more (📝 пост / 💡 идеи / 📅 план retired) —
    // everything is driven by buttons. Guide a stray message back to the menu.
    await showMenu(bot, chatId, lang);
  });

  // ── Inline buttons ──
  bot.on('callback_query', async (query) => {
    const chatId = query.message && query.message.chat && query.message.chat.id;
    const data   = query.data || '';
    // Кнопки поста (pub:*) разрешаем ВЛАДЕЛЬЦУ в любом чате (напр. группа студии) —
    // чтобы черновик, который content-bot туда запостил, можно было опубликовать/пересобрать.
    const ownerAct = ALLOWED.includes(String(query.from && query.from.id)) && (data.startsWith('pub:') || data === 'studio:stop' || data.startsWith('scout:'));
    if (!isAllowed(chatId) && !ownerAct) {
      await bot.answerCallbackQuery(query.id, { text: t('content.access_denied', uiLang(chatId)) }).catch(() => {});
      return;
    }
    if (data === 'studio:stop') {
      studioStop.add(String(chatId));
      await bot.answerCallbackQuery(query.id, { text: '🛑 Останавливаю…' }).catch(() => {});
      await bot.sendMessage(chatId, '🛑 Останавливаю студию — текущая сборка завершится, дальше не пойдёт.').catch(() => {});
      return;
    }
    // 🔍 Скаут: владелец отмечает кандидатов (scout:pick), собирает из выбранных (scout:build) или сбрасывает.
    if (data.startsWith('scout:')) {
      const [, op, sid, idxStr] = data.split(':');
      const sess = scoutSessions.get(sid);
      if (!sess) { await bot.answerCallbackQuery(query.id, { text: 'Подбор устарел — запусти /подбери заново.' }).catch(() => {}); return; }
      if (op === 'pick') {
        const idx = parseInt(idxStr, 10);
        if (sess.selected.has(idx)) sess.selected.delete(idx); else sess.selected.add(idx);
        const on = sess.selected.has(idx);
        await bot.answerCallbackQuery(query.id, { text: `${on ? '✅ №' + (idx + 1) + ' в подборке' : '➖ №' + (idx + 1) + ' убрал'} (всего ${sess.selected.size})` }).catch(() => {});
        // Обновляем подпись кнопки под этим фото (☑️/✅).
        try { await bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: on ? '☑️ Выбрано' : '✅ Беру', callback_data: `scout:pick:${sid}:${idx}` }]] }, { chat_id: query.message.chat.id, message_id: query.message.message_id }); } catch { /* ignore */ }
        return;
      }
      if (op === 'reset') {
        sess.selected.clear();
        await bot.answerCallbackQuery(query.id, { text: 'Сброшено' }).catch(() => {});
        await bot.sendMessage(sess.chatId, '🗑 Выбор сброшен. Отметь кадры заново или запусти /подбери с новой темой.').catch(() => {});
        return;
      }
      if (op === 'build') {
        if (!sess.selected.size) { await bot.answerCallbackQuery(query.id, { text: 'Отметь хотя бы одно фото ✅' }).catch(() => {}); return; }
        await bot.answerCallbackQuery(query.id, { text: 'Собираю' }).catch(() => {});
        const chosen = [...sess.selected].sort((a, b) => a - b).slice(0, 4).map((i) => sess.candidates[i] && sess.candidates[i].path).filter(Boolean);
        try {
          fs.mkdirSync(STUDIO_BUILD_DIR, { recursive: true });
          fs.writeFileSync(path.join(STUDIO_BUILD_DIR, `${Date.now()}.json`), JSON.stringify({ theme: sess.theme, chatId: sess.chatId, photos: chosen, at: new Date().toISOString() }));
          await bot.sendMessage(sess.chatId, `🎨 Собираю пост из выбранных (${chosen.length}) — финал пришлю тебе в личку.`).catch(() => {});
        } catch (e) { logger.error({ e: e.message }, 'scout build enqueue failed'); await bot.sendMessage(sess.chatId, '⚠️ Не смог поставить в сборку: ' + e.message).catch(() => {}); }
        scoutSessions.delete(sid);
        return;
      }
      await bot.answerCallbackQuery(query.id).catch(() => {});
      return;
    }
    const lang = uiLang(chatId);

    try {
      // 🔄 Rebuild a draft with the same theme but a fresh photo set + copy.
      if (data.startsWith('pub:redo:')) {
        const id = data.slice('pub:redo:'.length);
        const draft = publish.getDraft(id);
        await bot.answerCallbackQuery(query.id, { text: '🔄 Пересобираю…' }).catch(() => {});
        if (!draft || !draft.theme) { await bot.sendMessage(chatId, 'Черновик устарел — собери заново через ✨ Авто-пост.').catch(() => {}); return; }
        publish.dropDraft(id);
        const isReel = draft.igType === 'REEL' || draft.reelFormat;
        const isStory = draft.igType === 'STORY' || draft.storyFormat;
        const kindWord = isReel ? 'Reel' : isStory ? 'сторис' : 'пост';
        await bot.sendMessage(chatId, `🎨 Пересобираю ${kindWord} на других фото…`).catch(() => {});
        try {
          if (isReel) await calendar.buildReelAndRoute(bot, chatId, { theme: draft.theme, routine: false });
          else if (isStory) await calendar.buildStoryAndRoute(bot, chatId, { theme: draft.theme, routine: false });
          else await calendar.buildAndRoute(bot, chatId, { theme: draft.theme, slides: draft.slidesCount || 4, routine: false });
        } catch (err) {
          logger.error({ err: err.message }, 'rebuild failed');
          await bot.sendMessage(chatId, '❌ ' + err.message).catch(() => {});
        }
        return;
      }
      // Autopilot approval buttons (publish / best-time / discard).
      if (data.startsWith('pub:')) {
        const status = await publish.handleCallback(bot, chatId, data);
        await bot.answerCallbackQuery(query.id, status ? { text: status } : {}).catch(() => {});
        return;
      }
      // 📝/📱 «Помощник контентщика» (жена): выбирает формат кнопкой → бот ждёт её
      // фото/видео (режим хранится в сессии), затем оформляет и шлёт карточку публикации.
      if (data === 'make:post' || data === 'make:story') {
        const mode = data === 'make:story' ? 'story' : 'post';
        sessions.set(chatId, { mode, awaiting: 'wife_media' });
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const msg = lang === 'ru'
          ? (mode === 'story'
            ? '📱 Пришли фото или видео — сделаю красивую сторис в фирстиле с кнопкой публикации.\n<i>Можно добавить подпись к медиа — учту в тексте.</i>'
            : '📝 Пришли фото или видео — напишу пост с подписью и умными хэштегами, дам кнопку публикации.\n<i>Можно добавить подпись к медиа — учту в тексте.</i>')
          : (mode === 'story'
            ? '📱 Send a photo or video — I\'ll make a branded story with a publish button.'
            : '📝 Send a photo or video — I\'ll write a caption with smart hashtags and a publish button.');
        await bot.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: menuKb(lang) }).catch(() => {});
        return;
      }
      // ⚙️ Ещё — продвинутые инструменты владельца (автопилот/план/анализ).
      if (data === 'more:menu') {
        await bot.answerCallbackQuery(query.id).catch(() => {});
        await bot.sendMessage(chatId, lang === 'ru' ? '⚙️ Инструменты:' : '⚙️ Tools:', { reply_markup: advancedKeyboard(lang) }).catch(() => {});
        return;
      }
      // ✨ Auto-post button → ask for a theme (then message handler builds it).
      if (data === 'auto:new') {
        sessions.set(chatId, { awaiting: 'auto_topic' });
        await bot.answerCallbackQuery(query.id).catch(() => {});
        await bot.sendMessage(chatId, lang === 'ru'
          ? '✨ О чём пост? Напиши тему (или «-» — общий рекап недели):'
          : '✨ Post topic? Send a theme (or "-" for a weekly recap):',
          { reply_markup: menuKb(lang) }).catch(() => {});
        return;
      }
      // 📱 Story — ask for the theme, then build a 9:16 story (approval card).
      if (data === 'story:new') {
        sessions.set(chatId, { awaiting: 'story_topic' });
        await bot.answerCallbackQuery(query.id).catch(() => {});
        await bot.sendMessage(chatId, lang === 'ru'
          ? '📱 О чём сторис? Напиши тему (или «-» — за кулисами зала):'
          : '📱 Story topic? Send a theme (or "-" for behind-the-scenes):',
          { reply_markup: menuKb(lang) }).catch(() => {});
        return;
      }
      // 🎬 Reel — ask for the theme, then build a 9:16 motion video (not auto-posted).
      if (data === 'reel:new') {
        sessions.set(chatId, { awaiting: 'reel_topic' });
        await bot.answerCallbackQuery(query.id).catch(() => {});
        await bot.sendMessage(chatId, lang === 'ru'
          ? '🎬 О чём Reel? Напиши тему (или «-» — радостный момент тренировки):'
          : '🎬 Reel topic? Send a theme (or "-" for a joyful training moment):',
          { reply_markup: menuKb(lang) }).catch(() => {});
        return;
      }
      if (data === 'auto:status') {
        await bot.answerCallbackQuery(query.id).catch(() => {});
        await bot.sendMessage(chatId, autopilotStatusText(), {
          parse_mode: 'HTML',
          reply_markup: menuKb(lang),
        }).catch(() => {});
        return;
      }
      // 📅 Content plan — on-demand: generate a draft plan to review/edit/approve.
      if (data === 'plan:new' || data === 'plan:regen') {
        await bot.answerCallbackQuery(query.id, { text: '📅 Готовлю план…' }).catch(() => {});
        try { await proposePlanToOwner(bot, chatId); }
        catch (err) {
          logger.error({ err: err.message }, 'plan generation failed');
          await bot.sendMessage(chatId, '❌ Не получилось собрать план: ' + err.message).catch(() => {});
        }
        return;
      }
      // 🔎 Run the competitor analysis now (manual trigger of the 3-day loop).
      if (data === 'plan:analyze') {
        await bot.answerCallbackQuery(query.id, { text: '🔎 Анализирую…' }).catch(() => {});
        try { await calendar.runResearchAndReport(bot, chatId); }
        catch (err) {
          logger.error({ err: err.message }, 'manual research failed');
          await bot.sendMessage(chatId, '❌ Анализ не удался: ' + err.message).catch(() => {});
        }
        return;
      }
      if (data === 'plan:approve') {
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const saved = contentPlan.approve(chatId);
        if (!saved) { await bot.sendMessage(chatId, 'Черновик плана не найден — собери заново 📅.').catch(() => {}); return; }
        const s = sessions.get(chatId) || {}; delete s.awaiting; sessions.set(chatId, s);
        // Утверждён план → темы уходят в очередь СТУДИИ: критики ревьюят по одной
        // в день (content-studio крон 10:00 → студия-ревью), а готовый пост
        // (карточка pub:*) прилетает СЮДА, в личный контент-чат владельца.
        let queued = 0, groupChatId = null;
        try {
          try { groupChatId = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/studio-state.json'), 'utf8')).groupChatId; } catch { /* группа студии ещё не привязана */ }
          const themes = (saved.items || []).filter((it) => it.status === 'planned' && it.theme).map((it) => String(it.theme).slice(0, 300));
          if (groupChatId && themes.length) {
            fs.writeFileSync(path.join(__dirname, '../../data/studio-week-queue.json'),
              JSON.stringify({ createdAt: new Date().toISOString(), chatId: groupChatId, queue: themes.slice(0, 7).map((th) => ({ theme: th, done: false })) }));
            queued = themes.length;
          }
        } catch (err) { logger.error({ err: err.message }, 'plan→studio queue failed'); }
        const tail = queued
          ? `\n\n🎬 Отдал студии ${queued} тем — критики ревьюят по одной в день (10:00), готовый пост присылаю сюда на ✅ (публикация — только по твоему тапу «🕒 В лучшее время»).`
          : `\n\n⚠️ Студийная группа ещё не привязана — напиши что-нибудь в чате студии один раз, и посты пойдут через критиков.`;
        await bot.sendMessage(chatId,
          `✅ План утверждён.${tail}\n\n${escapeHtml(contentPlan.renderPlan(saved))}`,
          { parse_mode: 'HTML', reply_markup: planShowKb(lang) }).catch(() => {});
        return;
      }
      if (data === 'plan:show') {
        await bot.answerCallbackQuery(query.id).catch(() => {});
        await bot.sendMessage(chatId,
          `📋 <b>Текущий план</b>:\n\n${escapeHtml(contentPlan.renderPlan(contentPlan.load()))}`,
          { parse_mode: 'HTML', reply_markup: planShowKb(lang) }).catch(() => {});
        return;
      }
      if (data === 'plan:buildnext') {
        await bot.answerCallbackQuery(query.id).catch(() => {});
        const next = contentPlan.nextPlanned();
        if (!next) { await bot.sendMessage(chatId, 'В плане нет тем со статусом 🕒. Собери новый план 📅.').catch(() => {}); return; }
        await bot.sendMessage(chatId, `🎨 Собираю по плану: «${next.theme}»…`).catch(() => {});
        try { await calendar.buildNextPlanned(bot, chatId); }
        catch (err) { logger.error({ err: err.message }, 'plan buildnext failed'); await bot.sendMessage(chatId, '❌ ' + err.message).catch(() => {}); }
        return;
      }
      if (data === 'fmt:photo') {
        sessions.set(chatId, { format: 'photo_caption', awaiting: 'photo' });
        await bot.answerCallbackQuery(query.id).catch(() => {});
        await bot.sendMessage(chatId, t('content.ask_photo', lang), { reply_markup: menuKb(lang) }).catch(() => {});
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
      if (data === 'showlang') {
        await bot.answerCallbackQuery(query.id).catch(() => {});
        await bot.sendMessage(chatId, t('content.lang_prompt', lang), { reply_markup: menuKb(lang, langKeyboard().inline_keyboard) }).catch(() => {});
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
      calendar.start(bot, ALLOWED[0], {
        // Weekly auto-plan cron uses the bot's plan-review UI.
        proposePlan: () => proposePlanToOwner(bot, ALLOWED[0]),
      });
      logger.info({ owner: ALLOWED[0] }, 'autopilot calendar started');
    }
  } catch (err) {
    logger.error({ err: err.message }, 'autopilot calendar start failed');
  }

  // ── Студия: очередь на сборку по ✅. content-studio кладёт {theme,chatId} в
  //    data/studio-build/*.json → собираем черновик и постим В ЭТУ группу студии
  //    (кнопки pub:* владелец жмёт прямо там). routine:false — никогда не автопубликует.
  // Почасовой «подметатель» брошенных temp-папок фото (скаут без сборки, забытые
  // подборки, недочищенное). Удаляет подпапки data/studio-photos/* старше 2ч.
  const STUDIO_PHOTOS_DIR = path.join(__dirname, '../../data/studio-photos');
  setInterval(() => {
    try {
      if (!fs.existsSync(STUDIO_PHOTOS_DIR)) return;
      const cutoff = Date.now() - 2 * 60 * 60 * 1000;
      for (const name of fs.readdirSync(STUDIO_PHOTOS_DIR)) {
        const d = path.join(STUDIO_PHOTOS_DIR, name);
        try { const st = fs.statSync(d); if (st.isDirectory() && st.mtimeMs < cutoff) fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }, 60 * 60 * 1000);

  const STUDIO_BUILD_DIR = path.join(__dirname, '../../data/studio-build');
  let studioBusy = false;
  setInterval(async () => {
    if (studioBusy) return;
    let files;
    try { files = fs.existsSync(STUDIO_BUILD_DIR) ? fs.readdirSync(STUDIO_BUILD_DIR).filter((f) => f.endsWith('.json')).sort() : []; }
    catch { return; }
    if (!files.length) return;
    studioBusy = true;
    const fp = path.join(STUDIO_BUILD_DIR, files[0]);
    let req = null;
    try { req = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { logger.error({ e: e.message }, 'studio build req parse'); }
    // Невалидный запрос — только его удаляем сразу (собрать нечего).
    if (!req || !req.theme || !req.chatId) { try { fs.unlinkSync(fp); } catch {} studioBusy = false; return; }
    // 🛡 РОБАСТНОСТЬ (20.07): запрос НЕ удаляем при подхвате — только после УСПЕХА.
    // Так рестарт/краш посреди сборки не теряет пост (файл остаётся → пересоберётся
    // на следующем тике или после старта). Счётчик попыток в файле спасает от
    // «ядовитой» темы, которая падает всегда (иначе — бесконечный цикл).
    const attempt0 = (req.attempts || 0) + 1;
    const MAX_BUILD_RETRIES = Math.max(1, parseInt(process.env.STUDIO_BUILD_RETRIES || '3', 10));
    if (attempt0 > MAX_BUILD_RETRIES) {
      logger.error({ theme: req.theme, attempts: attempt0 }, 'studio build: превышен лимит попыток → пропуск');
      try { fs.unlinkSync(fp); } catch {}
      await bot.sendMessage(req.chatId, `⚠️ «${req.theme}» не собрался за ${MAX_BUILD_RETRIES} попыт(ки) (возможно, был перезапуск). Пропускаю — запусти заново через /next, когда будешь готов.`).catch(() => {});
      studioBusy = false; return;
    }
    try { fs.writeFileSync(fp, JSON.stringify({ ...req, attempts: attempt0 })); } catch {}
    {
      // ── Ветка «ФОТО ВЛАДЕЛЬЦА»: критики уже одобрили сырые фото в студии → просто
      //    собираем из НИХ (без панельного ревью готового поста) и шлём карточку в личку.
      if (Array.isArray(req.photos) && req.photos.length) {
        logger.info({ theme: req.theme, photos: req.photos.length }, 'studio: building from OWNER photos');
        try {
          await bot.sendMessage(req.chatId, `🎨 Собираю пост из твоих ${req.photos.length} фото…`).catch(() => {});
          const draft = await calendar.buildDraft(bot, req.chatId, { theme: req.theme, routine: false, suppliedPhotos: req.photos });
          const buffer = draft && draft.slides && draft.slides[0] && draft.slides[0].buffer;
          if (buffer) await bot.sendPhoto(req.chatId, buffer, { caption: 'Черновик из твоих фото' }).catch(() => {});
          await bot.sendMessage(req.chatId, '✅ Готово — финальный пост отправил тебе в личку.').catch(() => {});
          if (ALLOWED.length) await publish.route(bot, ALLOWED[0], draft);
          try { fs.unlinkSync(fp); } catch {}                                   // успех → снимаем запрос
          try { fs.rmSync(path.dirname(req.photos[0]), { recursive: true, force: true }); } catch {} // чистим всю temp-папку фото
        } catch (e) {
          logger.error({ e: e.message, attempt: attempt0 }, 'owner-photo build failed');
          await bot.sendMessage(req.chatId, `⚠️ Из твоих фото не собралось (попытка ${attempt0}/${MAX_BUILD_RETRIES}): ${e.message}. Повторю автоматически.`).catch(() => {});
          // файл НЕ удаляем → повтор на следующем тике (до лимита)
        }
        studioBusy = false; return;
      }
      logger.info({ theme: req.theme, chatId: req.chatId }, 'studio: building approved concept');
      try {
        const llm = require('./llm');
        const MAX = Math.max(1, parseInt(process.env.STUDIO_REVIEW_MAX || '5', 10));
        const PANEL = [
          { emoji: '🔍', name: 'Критик', system: 'Ты — строгий контент-критик детского акро-зала AcroGym (Доха). Смотришь на СОБРАННЫЙ пост Instagram (картинка): кадр, читаемость текста, брендфит, безопасность и уважение к детям. По-русски, коротко.' },
          { emoji: '👀', name: 'Зрители', system: 'Ты озвучиваешь фокус-группу родителей-подписчиков AcroGym (Доха). Смотришь на собранный пост Instagram (картинка) их глазами: зацепит ли родителя, захочется ли записать ребёнка. По-русски, коротко.' },
          { emoji: '📊', name: 'СММ', system: 'Ты — СММ-стратег детского акро-зала AcroGym (Доха). Смотришь на собранный пост Instagram (картинка) для продвижения: охват/вовлечённость/заявки. По-русски, коротко.' },
        ];
        const exclude = [];
        let draft = null;
        let feedback = '';  // накопленное ТЗ от команды для следующей пересборки
        studioStop.delete(String(req.chatId)); // свежий старт — сбрасываем возможный старый флаг
        const STOP_KB = { reply_markup: { inline_keyboard: [[{ text: '🛑 Стоп', callback_data: 'studio:stop' }]] } };
        for (let attempt = 1; attempt <= MAX; attempt++) {
          if (studioStop.has(String(req.chatId))) { await bot.sendMessage(req.chatId, '🛑 Остановлено по твоей команде.').catch(() => {}); draft = null; break; }
          await bot.sendMessage(req.chatId,
            attempt === 1 ? '🎨 Собираю черновик по утверждённому концепту…' : `🎨 Пересобираю с учётом правок (попытка ${attempt}/${MAX})…`,
            STOP_KB).catch(() => {});
          const briefTheme = feedback ? `${req.theme}\n\nПРАВКИ ОТ КОМАНДЫ (обязательно учесть): ${feedback}` : req.theme;
          draft = await calendar.buildDraft(bot, req.chatId, { theme: briefTheme, slides: 4, routine: false, exclude });
          if (studioStop.has(String(req.chatId))) { await bot.sendMessage(req.chatId, '🛑 Остановлено (сборка завершилась, дальше не иду).').catch(() => {}); draft = null; break; }
          const buffer = draft && draft.slides && draft.slides[0] && draft.slides[0].buffer;
          if (buffer) await bot.sendPhoto(req.chatId, buffer, { caption: `Черновик — попытка ${attempt}/${MAX}` }).catch(() => {});
          let allPass = true;
          const round1 = [];  // реплики 1-го круга панели (по картинке)
          if (buffer) {
            const b64 = buffer.toString('base64');
            const user =
              `Тема поста: «${req.theme}».\nПодпись: «${String(draft.caption || '').slice(0, 400)}».\n\n` +
              'Посмотри на СОБРАННЫЙ пост (картинка). Годится к публикации в Instagram детского акро-зала? ' +
              'Ответь СТРОГО: первым словом ДА или НЕТ. Если НЕТ — 1-2 предложения ЧТО КОНКРЕТНО не так и ЧТО ПОМЕНЯТЬ.';
            for (const r of PANEL) {
              let verdict = '';
              try {
                verdict = String(await llm.generateText({ system: r.system, user,
                  images: [{ data: b64, media_type: 'image/jpeg' }] }) || '').trim();
              } catch (e) { logger.error({ e: e.message, reviewer: r.name }, 'panel review failed'); verdict = 'ревью не удалось — засчитываю ДА'; }
              const ok = !verdict || /^\s*да\b/i.test(verdict) || /ревью не удалось/i.test(verdict);
              if (!ok) allPass = false;
              round1.push(`${r.name}: ${verdict}`);
              await bot.sendMessage(req.chatId, `${r.emoji} <b>${r.name}</b>\n${verdict}`, { parse_mode: 'HTML' }).catch(() => {});
            }
          }
          if (allPass) { await bot.sendMessage(req.chatId, `✅ Вся команда одобрила (попытка ${attempt}). Твоё слово, судья:`).catch(() => {}); break; }
          if (attempt === MAX) { await bot.sendMessage(req.chatId, `⚠️ За ${MAX} попыток команда не сошлась. Решай сам:`).catch(() => {}); break; }
          if (studioStop.has(String(req.chatId))) { await bot.sendMessage(req.chatId, '🛑 Остановлено — пересборку не запускаю.').catch(() => {}); draft = null; break; }
          // 2-й круг: панель ОБСУЖДАЕТ замечания друг друга и сходится в ЕДИНОМ мнении (без картинки — по репликам).
          const round2 = [];
          const talk = round1.join('\n');
          for (const r of PANEL) {
            let t2 = '';
            try {
              t2 = String(await llm.generateText({ system: r.system,
                user: `Тема: «${req.theme}». Мнения команды о собранном черновике:\n${talk}\n\nОтветь коллегам: с чем согласен и что ГЛАВНОЕ надо поменять. Двигай к ЕДИНОМУ решению. Коротко.` }) || '').trim();
            } catch (e) { logger.error({ e: e.message, reviewer: r.name }, 'panel round2 failed'); t2 = '(без реплики)'; }
            round2.push(`${r.name}: ${t2}`);
            await bot.sendMessage(req.chatId, `${r.emoji} <b>${r.name}</b> (2-й круг)\n${t2}`, { parse_mode: 'HTML' }).catch(() => {});
          }
          // Модератор сводит СОГЛАСОВАННОЕ мнение команды в ОДНО конкретное ТЗ.
          try {
            const synth = String(await llm.generateText({
              system: 'Ты — модератор контент-студии детского акро-зала AcroGym. Сведи ОБСУЖДЕНИЕ команды в ОДНО короткое конкретное ТЗ для пересборки: что поменять (фото/кадр, текст/подпись, подача). 2-4 пункта, по-русски, без воды.',
              user: `Тема: «${req.theme}».\nКруг 1:\n${round1.join('\n')}\n\nКруг 2 (сходятся):\n${round2.join('\n')}\n\nДай единое ТЗ на пересборку.`,
            }) || '').trim();
            feedback = synth || round1.join('; ');
          } catch (e) { logger.error({ e: e.message }, 'ТЗ synth failed'); feedback = round1.join('; '); }
          await bot.sendMessage(req.chatId, `🎬 <b>Модератор → content-bot</b> (единое ТЗ на пересборку):\n${feedback}`, { parse_mode: 'HTML' }).catch(() => {});
        }
        // Финал: обсуждение/ревью остаётся в группе, а ГОТОВЫЙ пост с кнопками уходит тебе в ЛИЧКУ.
        if (draft && !studioStop.has(String(req.chatId))) {
          await bot.sendMessage(req.chatId, '✅ Готово — финальный пост отправил тебе в личный content-чат (там копируй/публикуй как обычно).').catch(() => {});
          if (ALLOWED.length) await publish.route(bot, ALLOWED[0], draft); // карточка pub:* в личку владельцу
        }
        studioStop.delete(String(req.chatId)); // конец обработки — сбрасываем флаг
        try { fs.unlinkSync(fp); } catch {} // УСПЕХ (или стоп/финал) → снимаем запрос из очереди
      } catch (e) {
        logger.error({ e: e.message, attempt: attempt0 }, 'studio build/review failed');
        await bot.sendMessage(req.chatId, `⚠️ Черновик не собрался (попытка ${attempt0}/${MAX_BUILD_RETRIES}): ${e.message}. Повторю автоматически.`).catch(() => {});
        // Файл НЕ удаляем → следующий тик повторит (до лимита), переживёт и рестарт.
      }
    }
    studioBusy = false;
  }, 8000);

  // ── 🔍 СКАУТ: content-studio кладёт {theme,chatId} в data/studio-scout/*.json →
  //    подбираем умные кандидаты (photos.selectBest по каталогу) и кидаем их в группу
  //    с кнопками «✅ Беру». Владелец отмечает → scout:build собирает из выбранных.
  const STUDIO_SCOUT_DIR = path.join(__dirname, '../../data/studio-scout');
  let scoutBusy = false;
  setInterval(async () => {
    if (scoutBusy) return;
    let files;
    try { files = fs.existsSync(STUDIO_SCOUT_DIR) ? fs.readdirSync(STUDIO_SCOUT_DIR).filter((f) => f.endsWith('.json')).sort() : []; } catch { return; }
    if (!files.length) return;
    scoutBusy = true;
    const fp = path.join(STUDIO_SCOUT_DIR, files[0]);
    let req = null;
    try { req = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { logger.error({ e: e.message }, 'scout req parse'); }
    try { fs.unlinkSync(fp); } catch { /* ignore */ }
    if (req && req.theme && req.chatId) {
      logger.info({ theme: req.theme }, 'scout: searching library');
      try {
        const photosMod = require('./photos');
        await bot.sendMessage(req.chatId, `🔍 <b>Скаут</b> ищет фото под «${escapeHtml(req.theme)}» в библиотеке…`, { parse_mode: 'HTML' }).catch(() => {});
        const sel = await photosMod.scoutCandidates(req.theme, 6);
        const cands = (sel.photos || []).filter((p) => p && p.buffer);
        if (!cands.length) {
          await bot.sendMessage(req.chatId, `🔍 Скаут не нашёл в библиотеке кадров под «${escapeHtml(req.theme)}». Попробуй проще/иначе сформулировать, или кинь свои фото в чат.`, { parse_mode: 'HTML' }).catch(() => {});
        } else {
          const sid = String(Date.now());
          const dir = path.join(__dirname, '../../data/studio-photos', `scout-${sid}`);
          fs.mkdirSync(dir, { recursive: true });
          const candidates = [];
          for (let i = 0; i < cands.length; i++) {
            const cp = path.join(dir, `c${i + 1}.jpg`);
            try { fs.writeFileSync(cp, cands[i].buffer); candidates.push({ path: cp, name: cands[i].name || `c${i + 1}` }); } catch (e) { logger.warn({ e: e.message }, 'scout candidate save'); }
          }
          scoutSessions.set(sid, { chatId: req.chatId, theme: req.theme, candidates, selected: new Set() });
          const weakNote = sel.weak ? `⚠️ В библиотеке мало кадров именно под «${escapeHtml(req.theme)}» — вот что ближе всего (${candidates.length}). Можешь взять их или кинуть свои фото.\n\n` : '';
          await bot.sendMessage(req.chatId, `${weakNote}🔍 Скаут подобрал <b>${candidates.length}</b> кадров под «${escapeHtml(req.theme)}». Отметь «✅ Беру» на нужных (до 4), потом жми 🎨 Собрать:`, { parse_mode: 'HTML' }).catch(() => {});
          for (let i = 0; i < candidates.length; i++) {
            await bot.sendPhoto(req.chatId, fs.readFileSync(candidates[i].path), { caption: `№${i + 1}`, reply_markup: { inline_keyboard: [[{ text: '✅ Беру', callback_data: `scout:pick:${sid}:${i}` }]] } }).catch(() => {});
          }
          await bot.sendMessage(req.chatId, 'Отметил нужные? Собери пост из выбранных 👇', { reply_markup: { inline_keyboard: [
            [{ text: '🎨 Собрать из выбранных', callback_data: `scout:build:${sid}` }],
            [{ text: '🗑 Сбросить выбор', callback_data: `scout:reset:${sid}` }],
          ] } }).catch(() => {});
        }
      } catch (e) { logger.error({ e: e.message }, 'scout failed'); await bot.sendMessage(req.chatId, `⚠️ Скаут не смог подобрать: ${e.message}`).catch(() => {}); }
    }
    scoutBusy = false;
  }, 8000);

  // ── Студия: приватный итог владельцу в личку после обсуждения (чтобы не следить за группой).
  const STUDIO_NOTIFY_DIR = path.join(__dirname, '../../data/studio-notify');
  const escH = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  setInterval(() => {
    let files;
    try { files = fs.existsSync(STUDIO_NOTIFY_DIR) ? fs.readdirSync(STUDIO_NOTIFY_DIR).filter((f) => f.endsWith('.json')).sort() : []; } catch { return; }
    for (const f of files) {
      const fp = path.join(STUDIO_NOTIFY_DIR, f);
      let n = null;
      try { n = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { /* skip */ }
      try { fs.unlinkSync(fp); } catch { /* ignore */ }
      if (n && ALLOWED.length) {
        const isPlan = n.kind === 'plan';
        const head = isPlan
          ? '🗓 <b>План на неделю (студия)</b>'
          : `📋 <b>Студия обсудила тему</b>\n«${escH(String(n.topic || '').slice(0, 200))}»`;
        const foot = isPlan ? '' : '\n\n👉 Решение ждёт в группе студии — ✅ Делаем / ↩️ Переделать.';
        const body = `${head}\n\n${escH(String(n.proposal || '').slice(0, 3600))}${foot}`;
        bot.sendMessage(ALLOWED[0], body, { parse_mode: 'HTML' }).catch((e) => logger.error({ e: e.message }, 'studio notify DM'));
      }
    }
  }, 8000);

  // ── One-shot job kick: if data/run-job-once holds a calendar job name, build
  //    it on startup and remove the flag. Ops escape hatch to re-run a missed
  //    cron IN-PROCESS (approval-card buttons need the bot's in-memory drafts).
  //    Always routine:false — never auto-publishes.
  try {
    const kickPath = path.join(__dirname, '../../data/run-job-once');
    if (ALLOWED.length && fs.existsSync(kickPath)) {
      const name = fs.readFileSync(kickPath, 'utf8').trim();
      fs.unlinkSync(kickPath);
      const item = calendar.PLAN.find((p) => p.name === name);
      if (name === 'plan-next') {
        logger.info('run-job-once: building next planned content item');
        calendar.buildNextPlanned(bot, ALLOWED[0])
          .then((it) => { if (!it) logger.warn('run-job-once: no due plan item'); })
          .catch(async (err) => {
            logger.error({ err: err.message }, 'run-job-once plan-next failed');
            await bot.sendMessage(ALLOWED[0], `⚠️ Ручной перезапуск планового поста не собрался: ${err.message}`).catch(() => {});
          });
      } else if (!item) {
        logger.warn({ name }, 'run-job-once: unknown job name');
      } else {
        logger.info({ name }, 'run-job-once: building');
        calendar.buildAndRoute(bot, ALLOWED[0], { theme: item.theme, slides: item.slides, routine: false })
          .catch(async (err) => {
            logger.error({ err: err.message, name }, 'run-job-once failed');
            await bot.sendMessage(ALLOWED[0], `⚠️ Ручной перезапуск «${name}» не собрался: ${err.message}`).catch(() => {});
          });
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, 'run-job-once check failed');
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

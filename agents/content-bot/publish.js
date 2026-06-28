'use strict';

/**
 * Publish orchestrator + approval gate (Agent 4 — autonomous posting, Phase 1/3).
 *
 * Hybrid autonomy:
 *   - ROUTINE items (flagged by the content calendar) may auto-publish after
 *     passing self-verification.
 *   - Everything else is sent to the owner as an APPROVAL CARD; nothing reaches
 *     Instagram without an explicit ✅ tap.
 *
 * 🔴 SAFETY INVARIANTS
 *   - Publishing requires EITHER routine=true (calendar) OR an explicit approval
 *     tap from an allow-listed chat. No other path may call metricool autoPublish.
 *   - A draft that fails verify.js is NEVER auto-published; it is downgraded to
 *     manual review with the issues attached.
 *   - If Metricool is not configured, we fall back to delivering the assembled
 *     visuals + caption to the chat as a draft (current bot behavior preserved).
 */

const crypto = require('crypto');
const metricool = require('./metricool');
const agent = require('./agent');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('content-bot');

// Publishing is available via the Metricool REST token OR (no token / no paid
// API needed) via the Metricool MCP connector through the headless agent.
function canPublish() {
  return metricool.isConfigured() || agent.canPublish();
}

// Pending drafts awaiting approval: id → draft. In-memory (matches the bot's
// existing session model); a restart drops un-acted drafts, which is safe.
const pending = new Map();

/**
 * A draft:
 * {
 *   id, kind: 'post'|'story'|'reel',
 *   caption, igType: 'POST'|'STORY'|'REEL',
 *   slides: [{ url, alt, buffer? }],   // url = PUBLIC media URL for Metricool
 *   routine: boolean,                  // calendar routine → eligible to autopost
 *   verify: { ok, issues[] },          // result from verify.js
 *   source,                            // free-text provenance for the card/log
 * }
 */

function newDraft(d) {
  const id = crypto.randomBytes(6).toString('hex');
  const draft = { id, kind: 'post', igType: 'POST', slides: [], routine: false, ...d };
  pending.set(id, draft);
  return draft;
}

function getDraft(id) { return pending.get(id); }
function dropDraft(id) { pending.delete(id); }

// Approval keyboard for a draft card.
function approvalKeyboard(id) {
  return {
    inline_keyboard: [
      [{ text: '✅ Опубликовать сейчас', callback_data: `pub:now:${id}` }],
      [{ text: '🕒 В лучшее время', callback_data: `pub:best:${id}` },
       { text: '🔄 Пересобрать', callback_data: `pub:redo:${id}` }],
      [{ text: '🗑 Удалить', callback_data: `pub:drop:${id}` }],
    ],
  };
}

const mediaUrls = (draft) => (draft.slides || []).map((s) => s.url).filter(Boolean);
const mediaAlts = (draft) => (draft.slides || []).map((s) => s.alt || '');

/**
 * Send an approval card: the slides as a media group, then caption + buttons.
 * Returns the sent message (with buttons) so callers can track it if needed.
 */
async function sendApprovalCard(bot, chatId, draft) {
  const urls = mediaUrls(draft);
  // Preview the visuals (album). If we only have buffers, send the first.
  try {
    if (urls.length > 1) {
      await bot.sendMediaGroup(chatId, urls.map((u, i) => ({
        type: 'photo', media: u, ...(i === 0 ? { caption: `🧩 Draft ${draft.id} — ${draft.slides.length} slides` } : {}),
      })));
    } else if (urls.length === 1) {
      await bot.sendPhoto(chatId, urls[0]);
    } else if (draft.slides[0] && draft.slides[0].buffer) {
      await bot.sendPhoto(chatId, draft.slides[0].buffer);
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'approval preview send failed');
  }

  const verifyLine = draft.verify
    ? (draft.verify.ok ? '✅ self-check passed' : `⚠️ self-check issues: ${draft.verify.issues.join('; ')}`)
    : '';
  const header = `📝 <b>Draft ${draft.id}</b> — ${draft.kind}/${draft.igType}` +
    (draft.source ? `\n<i>${draft.source}</i>` : '') +
    (verifyLine ? `\n${verifyLine}` : '') +
    (canPublish() ? '' : '\n⚠️ Публикация недоступна — это только превью.');
  const body = `${header}\n\n<pre>${escapeHtml(draft.caption || '')}</pre>`;

  return bot.sendMessage(chatId, body, {
    parse_mode: 'HTML',
    reply_markup: canPublish() ? approvalKeyboard(draft.id) : undefined,
  }).catch((err) => logger.error({ err: err.message }, 'approval card send failed'));
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Publish a draft to Metricool. `mode` = 'now' | 'best' | Date.
 * 🔴 Caller must have verified authorization (routine OR approval tap).
 */
async function publishDraft(draft, { mode = 'now' } = {}) {
  const media = mediaUrls(draft);
  const altTexts = mediaAlts(draft);

  // Preferred when a REST token exists (cheaper, deterministic).
  if (metricool.isConfigured()) {
    let when = new Date();
    if (mode === 'best') when = await pickBestTime().catch(() => new Date());
    else if (mode instanceof Date) when = mode;
    const result = await metricool.schedulePost({ text: draft.caption, media, altTexts, igType: draft.igType, autoPublish: true, draft: false, when });
    logger.info({ id: draft.id, kind: draft.kind, mode: mode instanceof Date ? 'date' : mode, via: 'rest' }, 'draft published via metricool REST');
    return result;
  }

  // No token → publish via the Metricool MCP connector through the agent (free).
  if (!agent.canPublish()) throw new Error('no publish path available (no Metricool token and no agent CLI)');
  const res = await agent.publishPost({
    media, caption: draft.caption, altTexts, igType: draft.igType,
    when: mode instanceof Date ? mode : new Date(Date.now() + 2 * 60000),
    bestTime: mode === 'best',
    autoPublish: true,
  });
  if (!res.ok) throw new Error(res.error || 'publish failed');
  logger.info({ id: draft.id, kind: draft.kind, postId: res.postId, via: 'agent-mcp', costUsd: res.costUsd }, 'draft published via Metricool MCP');
  return res;
}

// Pick the next best Instagram time in the coming week; fall back to now+5min.
async function pickBestTime() {
  const from = new Date();
  const to = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  const iso = (d) => metricool.localDateTime(d);
  const heat = await metricool.getBestTime({ fromDate: iso(from), toDate: iso(to) });
  // Best-effort parse of Metricool's heatmap; if shape is unknown, soon.
  const best = extractBestSlot(heat);
  return best || new Date(Date.now() + 5 * 60 * 1000);
}

function extractBestSlot(heat) {
  try {
    const arr = heat && (heat.data || heat.values || heat);
    if (!Array.isArray(arr)) return null;
    let top = null;
    for (const e of arr) {
      const value = e.value ?? e.score ?? 0;
      const date = e.date || e.dateTime || e.time;
      if (date && (!top || value > top.value)) top = { value, date };
    }
    return top ? new Date(top.date) : null;
  } catch { return null; }
}

/**
 * Decide what to do with a freshly assembled draft (the hybrid gate).
 *  - routine + verify.ok + configured  → auto-publish, notify the owner.
 *  - otherwise                         → approval card (or preview if unconfigured).
 */
async function route(bot, ownerChatId, draft) {
  pending.set(draft.id, draft);
  const canAuto = draft.routine && draft.verify && draft.verify.ok && canPublish();
  if (canAuto) {
    try {
      await publishDraft(draft, { mode: 'best' });
      dropDraft(draft.id);
      await bot.sendMessage(ownerChatId,
        `🤖 Автопост (рутина) опубликован: <b>${draft.kind}/${draft.igType}</b>\n<i>${draft.source || ''}</i>`,
        { parse_mode: 'HTML' }).catch(() => {});
      return { action: 'auto-published' };
    } catch (err) {
      logger.error({ err: err.message, id: draft.id }, 'auto-publish failed → manual review');
      draft.source = `${draft.source || ''} (autopost failed: ${err.message})`;
    }
  }
  await sendApprovalCard(bot, ownerChatId, draft);
  return { action: 'awaiting-approval' };
}

/** Handle pub:* callback buttons. Returns a short status string for the toast. */
async function handleCallback(bot, chatId, data) {
  const m = /^pub:(now|best|drop):([0-9a-f]+)$/.exec(data);
  if (!m) return null;
  const [, op, id] = m;
  const draft = getDraft(id);
  if (!draft) return 'Draft expired';
  if (op === 'drop') { dropDraft(id); return '🗑 Удалено'; }
  try {
    await publishDraft(draft, { mode: op === 'best' ? 'best' : 'now' });
    dropDraft(id);
    await bot.sendMessage(chatId, `✅ Опубликовано (${op === 'best' ? 'в лучшее время' : 'сейчас'}): ${draft.kind}/${draft.igType}`).catch(() => {});
    return '✅ Готово';
  } catch (err) {
    logger.error({ err: err.message, id }, 'publish via approval failed');
    await bot.sendMessage(chatId, `❌ Ошибка публикации: ${err.message}`).catch(() => {});
    return '❌ Ошибка';
  }
}

module.exports = {
  newDraft, getDraft, dropDraft, route, sendApprovalCard,
  publishDraft, handleCallback, approvalKeyboard, pickBestTime, canPublish,
  _pending: pending,
};

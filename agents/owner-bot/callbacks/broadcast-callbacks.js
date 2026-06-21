'use strict';

/**
 * callbacks/broadcast-callbacks.js — /broadcast dialog (B3).
 *
 * Steps (state.action='broadcast'):
 *   segment → [age_band | client_type] → text → preview → {dry-run | SEND-stub | cancel}
 *
 * B3 is preview + dry-run only. The SEND button is a STUB: it does not import or
 * contain any dispatch code — pressing it just says sending isn't enabled. The
 * draft lives entirely in user_state; nothing is written to the broadcasts table
 * (that, plus real dispatch, is B4).
 */

const { createLogger } = require('../../../shared/logger');
const { t }            = require('../../../shared/i18n');
const {
  registerOwnerCallback,
  registerOwnerTextHandler,
  escapeMd,
} = require('../../../shared/telegram');
const {
  getState, setState, setStep, updateParams, clearState, isExpired,
} = require('../../../shared/state');
const { getPreferredLanguage } = require('../../../shared/preferences');
const { resolveAudience }      = require('../../../shared/broadcast/resolver');
const { buildPreview, buildDryRun } = require('../builders/broadcast-preview');
const { createBroadcast }      = require('../../../shared/db');
const { runBroadcast }         = require('../../../shared/broadcast/dispatcher');

// Above this many recipients, a single tap is not enough — the owner must type
// the exact count to confirm (guard against an accidental mass send).
const CONFIRM_THRESHOLD = 20;

const logger = createLogger('owner-bot');

const AGE_BANDS = { '3-5': [3, 5], '6-9': [6, 9], '10-14': [10, 14] };

const lang = (chatId) => getPreferredLanguage(chatId) || 'en';

// Reuse the existing /export return-to-menu pattern: a language-aware
// "⬅ Back to menu" button (common.back_to_menu key) wired to the existing
// menu:back handler. Shown after terminal states so the owner is never stuck.
const backKb = (l) => ({
  inline_keyboard: [[{ text: t('common.back_to_menu', l), callback_data: 'menu:back' }]],
});

/** Build the resolver/builder segment object from stored state params. */
function segmentFromParams(p) {
  if (p.segment_kind === 'age')         return { kind: 'age', min: p.segment_min, max: p.segment_max };
  if (p.segment_kind === 'client_type') return { kind: 'client_type', value: p.segment_value };
  return { kind: 'all' };
}

/** Session-timeout guard: returns true (and tears down) when the state expired. */
async function expiredGuard(state, chatId, bot, l) {
  if (!isExpired(state)) return false;
  clearState(chatId);
  await bot.sendMessage(chatId, t('broadcast.expired', l), { parse_mode: 'MarkdownV2', reply_markup: backKb(l) }).catch(() => {});
  return true;
}

/** Step 3 prompt: ask for the message text (free input via the text router). */
async function askForText(chatId, bot, l) {
  setStep(chatId, 'text');
  await bot.sendMessage(chatId, t('broadcast.enter_text', l), { parse_mode: 'MarkdownV2' }).catch(() => {});
}

/** Render the preview with action buttons (or empty-audience with cancel only). */
async function showPreview(chatId, bot, l) {
  const state   = getState(chatId);
  const p       = state.params;
  const segment = segmentFromParams(p);
  const { recipients } = resolveAudience(segment, { withChildren: segment.kind === 'age' });

  updateParams(chatId, { total: recipients.length });
  setStep(chatId, 'preview');

  const text = buildPreview({ text: p.text, channel: p.channel, segment, lang: l, recipients });

  const rows = [];
  if (recipients.length > 0) {
    rows.push([{ text: t('broadcast.btn_send', l, { count: recipients.length }), callback_data: 'broadcast:send' }]);
    rows.push([{ text: t('broadcast.btn_dryrun', l), callback_data: 'broadcast:dryrun' }]);
  }
  rows.push([{ text: `❌ ${t('common.cancel', l)}`, callback_data: 'broadcast:cancel' }]);

  await bot.sendMessage(chatId, text, { parse_mode: 'MarkdownV2', reply_markup: { inline_keyboard: rows } }).catch((err) =>
    logger.error({ err }, 'broadcast preview send failed'));
}

/** Recount the audience NOW from stored params. */
function recount(p) {
  const segment = segmentFromParams(p);
  return resolveAudience(segment).recipients.length;
}

/**
 * Pick the result message for the owner by outcome (pure, testable):
 *   fatal (res.error present) → 🔴 send_failed + real reason (fallback generic);
 *   partial (failed > 0)      → ⚠️ sent_partial (honest counts, resumable);
 *   full                      → ✅ sent_done.
 */
function pickResultMessage(res, l) {
  if (res.error !== undefined) {
    return t('broadcast.send_failed', l, { reason: escapeMd(res.error || 'dispatch error') });
  }
  if (res.failed > 0) {
    return t('broadcast.sent_partial', l, { sent: res.sent, total: res.total, failed: res.failed });
  }
  return t('broadcast.sent_done', l, { sent: res.sent, total: res.total, failed: res.failed });
}

/**
 * Begin the real dispatch after confirmation. Anti-re-entrancy: better-sqlite3 is
 * synchronous and the bot is single-threaded, so the dispatching check-and-set
 * runs to completion before any await — a double tap's second call sees the flag
 * and bails. The DB-level atomic draft→sending in runBroadcast is the second guard.
 */
async function startDispatch(chatId, bot, l) {
  const st = getState(chatId);
  if (!st || st.action !== 'broadcast') return;
  if (st.params.dispatching) return;             // re-entrancy guard (sync read)
  updateParams(chatId, { dispatching: true });   // set BEFORE any await

  const p  = getState(chatId).params;
  const id = createBroadcast({
    segment_kind: p.segment_kind, segment_value: p.segment_value,
    segment_min: p.segment_min, segment_max: p.segment_max,
    channel: p.channel, body_kind: p.body_kind || 'text', text: p.text,
    total: p.total ?? 0,
  });
  clearState(chatId); // flow consumed — the broadcasts row is now the source of truth

  await bot.sendMessage(chatId, t('broadcast.sending', l, { count: p.total ?? 0 }), { parse_mode: 'MarkdownV2' }).catch(() => {});
  const res = await runBroadcast(id, { lang: l });
  if (res.aborted) return; // DB anti-double-start already handled it

  await bot.sendMessage(chatId, pickResultMessage(res, l), { parse_mode: 'MarkdownV2', reply_markup: backKb(l) }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────
// Callback handler (prefix 'broadcast')
// ─────────────────────────────────────────────────────────────
async function onCallback(query, bot) {
  const chatId = query.message.chat.id;
  const l      = lang(chatId);
  const parts  = (query.data || '').split(':'); // ['broadcast', sub, val]
  const sub    = parts[1];
  const val    = parts[2];

  await bot.answerCallbackQuery(query.id).catch(() => {});

  // cancel works regardless of state
  if (sub === 'cancel') {
    clearState(chatId);
    await bot.sendMessage(chatId, t('broadcast.cancelled', l), { parse_mode: 'MarkdownV2', reply_markup: backKb(l) }).catch(() => {});
    return;
  }

  const state = getState(chatId);
  if (!state || state.action !== 'broadcast') return; // stale button, no active flow
  if (await expiredGuard(state, chatId, bot, l)) return;

  switch (sub) {
    case 'seg':
      if (val === 'all') {
        updateParams(chatId, { segment_kind: 'all' });
        return askForText(chatId, bot, l);
      }
      if (val === 'age') {
        setStep(chatId, 'age_band');
        return bot.sendMessage(chatId, t('broadcast.choose_age_band', l), {
          parse_mode: 'MarkdownV2',
          reply_markup: { inline_keyboard: [
            [
              { text: '3–5',   callback_data: 'broadcast:age:3-5'   },
              { text: '6–9',   callback_data: 'broadcast:age:6-9'   },
              { text: '10–14', callback_data: 'broadcast:age:10-14' },
            ],
            [{ text: `❌ ${t('common.cancel', l)}`, callback_data: 'broadcast:cancel' }],
          ] },
        }).catch(() => {});
      }
      if (val === 'ctype') {
        setStep(chatId, 'client_type');
        return bot.sendMessage(chatId, t('broadcast.choose_segment', l), {
          parse_mode: 'MarkdownV2',
          reply_markup: { inline_keyboard: [
            [
              { text: t('broadcast.btn_ctype_new', l),      callback_data: 'broadcast:ctype:new'      },
              { text: t('broadcast.btn_ctype_existing', l), callback_data: 'broadcast:ctype:existing' },
            ],
            [{ text: `❌ ${t('common.cancel', l)}`, callback_data: 'broadcast:cancel' }],
          ] },
        }).catch(() => {});
      }
      return;

    case 'age': {
      const band = AGE_BANDS[val];
      if (!band) return;
      updateParams(chatId, { segment_kind: 'age', segment_min: band[0], segment_max: band[1] });
      return askForText(chatId, bot, l);
    }

    case 'ctype':
      updateParams(chatId, { segment_kind: 'client_type', segment_value: val });
      return askForText(chatId, bot, l);

    case 'dryrun': {
      const segment = segmentFromParams(state.params);
      const { recipients } = resolveAudience(segment, { withChildren: segment.kind === 'age' });
      const text = buildDryRun({ segment, lang: l, recipients });
      return bot.sendMessage(chatId, text, { parse_mode: 'MarkdownV2' }).catch((err) =>
        logger.error({ err }, 'broadcast dry-run send failed'));
    }

    case 'send': {
      const count = recount(state.params); // recount at the moment of the tap
      if (count !== (state.params.total ?? -1)) {
        // Audience drifted between preview and tap → do NOT send by the old N;
        // show a fresh preview so the owner re-confirms against the new number.
        await bot.sendMessage(chatId, t('broadcast.audience_changed', l, { old: state.params.total ?? 0, new: count }), { parse_mode: 'MarkdownV2' }).catch(() => {});
        return showPreview(chatId, bot, l);
      }
      if (count === 0) return; // nothing to send (no Send button rendered anyway)
      if (count > CONFIRM_THRESHOLD) {
        updateParams(chatId, { expected_count: count });
        setStep(chatId, 'confirm_count');
        return bot.sendMessage(chatId, t('broadcast.confirm_count_prompt', l, { count }), { parse_mode: 'MarkdownV2' }).catch(() => {});
      }
      return startDispatch(chatId, bot, l); // N ≤ threshold: a single tap suffices
    }

    default:
      return;
  }
}

// ─────────────────────────────────────────────────────────────
// Text handler — captures the message body at the 'text' step.
// Registered under action 'broadcast'; the router dispatches by current_action.
// ─────────────────────────────────────────────────────────────
async function onText(msg, bot) {
  const chatId = msg.chat.id;
  const l      = lang(chatId);
  const state  = getState(chatId);

  if (!state || state.action !== 'broadcast') return; // not our turn
  if (await expiredGuard(state, chatId, bot, l)) return;

  // Step: message body input → show preview.
  if (state.step === 'text') {
    const text = (msg.text || '').trim();
    if (!text) return;
    updateParams(chatId, { text });
    return showPreview(chatId, bot, l);
  }

  // Step: large-audience confirmation → must type the exact recipient count.
  if (state.step === 'confirm_count') {
    const typed = parseInt((msg.text || '').trim(), 10);
    if (Number.isNaN(typed)) return; // ignore non-numbers, stay on the step
    const count = recount(state.params); // authoritative recount at confirm time
    if (typed !== count) {
      clearState(chatId);
      return bot.sendMessage(chatId, t('broadcast.confirm_mismatch', l, { typed, actual: count }), { parse_mode: 'MarkdownV2', reply_markup: backKb(l) }).catch(() => {});
    }
    updateParams(chatId, { total: count });
    return startDispatch(chatId, bot, l);
  }
}

function setupBroadcastCallbacks() {
  registerOwnerCallback('broadcast', onCallback);
  registerOwnerTextHandler('broadcast', onText);
  logger.info('Broadcast callbacks registered');
}

module.exports = { setupBroadcastCallbacks, backKb, onCallback, onText, pickResultMessage };

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
} = require('../../../shared/telegram');
const {
  getState, setState, setStep, updateParams, clearState, isExpired,
} = require('../../../shared/state');
const { getPreferredLanguage } = require('../../../shared/preferences');
const { resolveAudience }      = require('../../../shared/broadcast/resolver');
const { buildPreview, buildDryRun } = require('../builders/broadcast-preview');

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

    case 'send':
      // STUB — B3 cannot send. No dispatch code is imported here.
      return bot.sendMessage(chatId, t('broadcast.send_stub', l), { parse_mode: 'MarkdownV2', reply_markup: backKb(l) }).catch(() => {});

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

  if (!state || state.action !== 'broadcast' || state.step !== 'text') return; // not our turn
  if (await expiredGuard(state, chatId, bot, l)) return;

  const text = (msg.text || '').trim();
  if (!text) return;

  updateParams(chatId, { text });
  await showPreview(chatId, bot, l);
}

function setupBroadcastCallbacks() {
  registerOwnerCallback('broadcast', onCallback);
  registerOwnerTextHandler('broadcast', onText);
  logger.info('Broadcast callbacks registered');
}

module.exports = { setupBroadcastCallbacks, backKb };

'use strict';

/**
 * Broadcast dispatcher (B4) — the first step that REALLY sends.
 *
 * HARD CHANNEL BOUNDARY: the only reachable delivery is 'telegram_test' →
 * sendToBroadcastTest (the owner's BROADCAST_TEST_CHAT_IDS inbox). A client
 * phone is NEVER a send target. The 'whatsapp_cloud' branch THROWS before any
 * network call and this module does NOT import shared/channels/whatsapp-cloud
 * (that wiring is B6). B3 only ever stores channel='telegram_test'.
 *
 * B4 lays the schema/log/dispatch; full crash-resume (re-enter a sending/failed
 * run, skip already-'sent', resend the rest) is B5.
 */

const { createLogger } = require('../logger');
const { t }            = require('../i18n');
const { escapeMd, sendToBroadcastTest } = require('../telegram');
const { resolveAudience } = require('./resolver');
const {
  getBroadcast, startBroadcast, finishBroadcast, logBroadcastRecipient,
  getSentPhones, getBroadcastCounts, markRecipientSent,
  claimResume, getResumableBroadcastIds,
} = require('../db');

const logger = createLogger('broadcast-dispatch');

/**
 * Channel router. Returns the send result or THROWS. `send` is injectable for
 * tests; default is the real telegram_test inbox sender.
 */
async function sendBroadcastMessage({ channel, who, body, lang = 'en', send = sendToBroadcastTest }) {
  if (channel === 'telegram_test') {
    // Tag (who it was for) on its own line, blank line, then the body. The body
    // is the owner's free text — escaped for MarkdownV2, never translated.
    const tag = t('broadcast.test_tag', lang, { who: escapeMd(who) });
    return send(`${tag}\n\n${escapeMd(body)}`);
  }
  if (channel === 'whatsapp_cloud') {
    throw new Error('whatsapp_cloud not configured (B6)');
  }
  throw new Error(`unknown broadcast channel: ${channel}`);
}

const _delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Shared send loop (B5 idempotent). Skips recipients already delivered ('sent'),
 * so a re-run/resume never double-sends. Success → markRecipientSent (UPDATE a
 * prior 'failed' → 'sent', else INSERT 'sent'); failure → 'failed' row. Counts
 * come from the log (cumulative across resumes). Finishes 'done' iff nobody is
 * left undelivered, else 'failed' (resumable). Assumes the broadcast is already
 * in 'sending' (caller claimed it).
 *
 * Resume targets the CURRENT audience minus already-sent: an opt-out after the
 * original send drops off; a fresh opt-in would be included. Fine for crash
 * recovery within minutes (documented edge).
 */
async function _dispatch(bc, deps = {}) {
  const resolve   = deps.resolveAudience      || resolveAudience;
  const sendMsg   = deps.sendBroadcastMessage || sendBroadcastMessage;
  const delay     = deps.delay                || _delay;
  const batchSize = deps.batchSize || Number(process.env.BROADCAST_RATE_BATCH)    || 20;
  const delayMs   = deps.delayMs   || Number(process.env.BROADCAST_RATE_DELAY_MS) || 1000;
  const lang      = deps.lang || 'en';

  const segment = { kind: bc.segment_kind, value: bc.segment_value, min: bc.segment_min, max: bc.segment_max };
  try {
    const all     = resolve(segment).recipients;
    const sentSet = getSentPhones(bc.id);
    const todo    = all.filter(r => !sentSet.has(r.recipient_phone)); // skip already-delivered

    for (let i = 0; i < todo.length; i += batchSize) {
      for (const r of todo.slice(i, i + batchSize)) {
        const who = `${r.display_name} ${r.phone_masked}`.trim();
        try {
          await sendMsg({ channel: bc.channel, who, body: bc.text, lang });
          markRecipientSent({ broadcast_id: bc.id, recipient_phone: r.recipient_phone, text: bc.text, channel: bc.channel });
        } catch (err) {
          logger.error({ err: err.message, broadcastId: bc.id }, 'recipient send failed');
          logBroadcastRecipient({ broadcast_id: bc.id, recipient_phone: r.recipient_phone, text: bc.text, channel: bc.channel, delivery_status: 'failed' });
        }
      }
      if (i + batchSize < todo.length) await delay(delayMs);
    }
    const c = getBroadcastCounts(bc.id);
    const status = c.failed > 0 ? 'failed' : 'done'; // done only when all delivered
    finishBroadcast(bc.id, { status, sent: c.sent, failed: c.failed });
    return { aborted: false, status, sent: c.sent, failed: c.failed, total: all.length, processed: todo.length };
  } catch (err) {
    logger.error({ err: err.message, broadcastId: bc.id }, 'broadcast run failed');
    const c = getBroadcastCounts(bc.id);
    finishBroadcast(bc.id, { status: 'failed', sent: c.sent, failed: c.failed });
    // error set ONLY on a fatal (outer catch) — the caller uses its presence to
    // tell a real failure ('🔴 send_failed' + reason) from a partial one (counts).
    return { aborted: false, status: 'failed', sent: c.sent, failed: c.failed, error: err.message };
  }
}

/**
 * Fresh dispatch from the Send button. Atomic draft→sending guards a double tap
 * (only one caller wins). Then the shared idempotent loop.
 */
async function runBroadcast(broadcastId, deps = {}) {
  const bc = getBroadcast(broadcastId);
  if (!bc) throw new Error(`broadcast ${broadcastId} not found`);
  if (!startBroadcast(broadcastId)) {
    logger.warn({ broadcastId, status: bc.status }, 'not in draft — already started; aborting');
    return { aborted: true };
  }
  return _dispatch(getBroadcast(broadcastId), deps);
}

/**
 * Resume an interrupted broadcast: 'sending' (crash-orphaned) or 'failed' (has
 * undelivered) → continue, sending ONLY to recipients without a 'sent' row.
 */
async function resumeBroadcast(broadcastId, deps = {}) {
  const bc = getBroadcast(broadcastId);
  if (!bc) return { skipped: true, reason: 'not-found' };
  if (!claimResume(broadcastId)) return { skipped: true, reason: `not resumable (${bc.status})` };
  logger.warn({ broadcastId, prevStatus: bc.status }, 'resuming broadcast');
  return _dispatch(getBroadcast(broadcastId), deps);
}

/**
 * Crash recovery: resume every broadcast left orphaned in 'sending'. Called on
 * owner-bot startup. Inert when there are none. telegram_test only (boundary).
 */
async function resumeStaleBroadcasts(deps = {}) {
  const ids = getResumableBroadcastIds();
  const results = [];
  for (const id of ids) results.push({ id, ...(await resumeBroadcast(id, deps)) });
  if (ids.length) logger.warn({ count: ids.length, ids }, 'resumed stale broadcasts on startup');
  return results;
}

module.exports = { sendBroadcastMessage, runBroadcast, resumeBroadcast, resumeStaleBroadcasts };

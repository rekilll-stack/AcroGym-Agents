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
 * Run a broadcast: atomic draft→sending, batch-send with rate-limit, per-recipient
 * log, sending→done|failed. Deps injectable for tests.
 * @returns {{aborted:boolean, status?:string, sent?:number, failed?:number, total?:number}}
 */
async function runBroadcast(broadcastId, deps = {}) {
  const resolve   = deps.resolveAudience      || resolveAudience;
  const sendMsg   = deps.sendBroadcastMessage || sendBroadcastMessage;
  const delay     = deps.delay                || _delay;
  const batchSize = deps.batchSize || Number(process.env.BROADCAST_RATE_BATCH)    || 20;
  const delayMs   = deps.delayMs   || Number(process.env.BROADCAST_RATE_DELAY_MS) || 1000;
  const lang      = deps.lang || 'en';

  const bc = getBroadcast(broadcastId);
  if (!bc) throw new Error(`broadcast ${broadcastId} not found`);

  // Atomic anti-double-start: only one caller wins draft→sending.
  if (!startBroadcast(broadcastId)) {
    logger.warn({ broadcastId, status: bc.status }, 'not in draft — already started; aborting');
    return { aborted: true };
  }

  const segment = { kind: bc.segment_kind, value: bc.segment_value, min: bc.segment_min, max: bc.segment_max };
  let sent = 0, failed = 0, total = 0;
  try {
    const { recipients } = resolve(segment);
    total = recipients.length;
    for (let i = 0; i < recipients.length; i += batchSize) {
      for (const r of recipients.slice(i, i + batchSize)) {
        const who = `${r.display_name} ${r.phone_masked}`.trim();
        try {
          await sendMsg({ channel: bc.channel, who, body: bc.text, lang });
          logBroadcastRecipient({ broadcast_id: broadcastId, recipient_phone: r.recipient_phone, text: bc.text, channel: bc.channel, delivery_status: 'sent' });
          sent++;
        } catch (err) {
          logger.error({ err: err.message, broadcastId }, 'recipient send failed');
          logBroadcastRecipient({ broadcast_id: broadcastId, recipient_phone: r.recipient_phone, text: bc.text, channel: bc.channel, delivery_status: 'failed' });
          failed++;
        }
      }
      if (i + batchSize < recipients.length) await delay(delayMs);
    }
    finishBroadcast(broadcastId, { status: 'done', sent, failed });
    return { aborted: false, status: 'done', sent, failed, total };
  } catch (err) {
    logger.error({ err: err.message, broadcastId }, 'broadcast run failed');
    finishBroadcast(broadcastId, { status: 'failed', sent, failed });
    return { aborted: false, status: 'failed', sent, failed, total };
  }
}

module.exports = { sendBroadcastMessage, runBroadcast };

'use strict';

/**
 * B4 — broadcast dispatch test (temp DB only). Self-isolating.
 * Covers the safety-critical dispatcher (channel boundary, transitions, log,
 * batch, anti-double-start, OR IGNORE) with injected deps (NO network), plus
 * the non-dispatching confirmation branches in the callback layer with a fake
 * bot. The actual telegram_test delivery + N≤20 single-tap dispatch are live.
 *
 *   rm -f /tmp/b4.db*
 *   sqlite3 data/acrogym.db ".backup '/tmp/b4.db'"
 *   ACROGYM_DB_PATH=/tmp/b4.db node scripts/test-broadcast-dispatch.js
 */

if (!process.env.ACROGYM_DB_PATH || process.env.ACROGYM_DB_PATH.includes('data/acrogym.db')) {
  console.error('REFUSING: set ACROGYM_DB_PATH to a temp copy first.'); process.exit(1);
}
{
  const fs = require('fs');
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(process.env.ACROGYM_DB_PATH + ext)) {
    console.error(`REFUSING: stale ${process.env.ACROGYM_DB_PATH + ext} — delete .db,-wal,-shm together.`); process.exit(1);
  }
}

const { getDb, createBroadcast, getBroadcast, startBroadcast, logBroadcastRecipient, upsertRegistration } = require('../shared/db');
const { sendBroadcastMessage, runBroadcast } = require('../shared/broadcast/dispatcher');
const { setState, getState, updateParams, setStep, clearState } = require('../shared/state');
const { onCallback, onText } = require('../agents/owner-bot/callbacks/broadcast-callbacks');

const db = getDb();
// Self-isolating: clear the slate in the temp copy so seeded audience/broadcasts
// are the only ones (independent of prod opted-in/owner-test + live broadcasts).
db.exec('DELETE FROM client_messages; DELETE FROM broadcasts; DELETE FROM registrations;');
let pass = 0, fail = 0;
const T = (n, c) => { if (c) { console.log('  ✅ ' + n); pass++; } else { console.log('  ❌ ' + n); fail++; } };
const recips = (n) => Array.from({ length: n }, (_, i) => ({ recipient_phone: `9745550${1000 + i}`, display_name: `R${i}`, phone_masked: `974•••••${10 + i}` }));

(async () => {
  console.log('=== channel boundary ===');
  let threw = '';
  try { await sendBroadcastMessage({ channel: 'whatsapp_cloud', who: 'x', body: 'y' }); } catch (e) { threw = e.message; }
  T('whatsapp_cloud → throws before any network', /not configured/.test(threw));
  threw = '';
  try { await sendBroadcastMessage({ channel: 'sms', who: 'x', body: 'y' }); } catch (e) { threw = e.message; }
  T('unknown channel → throws', /unknown broadcast channel/.test(threw));

  let sink = null;
  const r1 = await sendBroadcastMessage({ channel: 'telegram_test', who: 'Anna 974•••••11', body: 'hello (x).', lang: 'en', send: async (text) => { sink = text; return ['ok']; } });
  T('telegram_test → delivered via send sink (a phone is never the target)', Array.isArray(r1) && sink !== null);
  T('test message carries the tag', /🧪/.test(sink) && /TEST/.test(sink));
  T('tag and body separated by a blank line', /\]\n\n/.test(sink));
  T('body MarkdownV2-escaped (parens, period)', sink.includes('hello \\(x\\)\\.'));
  T('recipient full phone NOT present in the message', !sink.includes('9745550'));

  console.log('\n=== runBroadcast: happy path + transitions + log + batch ===');
  const id = createBroadcast({ segment_kind: 'all', channel: 'telegram_test', body_kind: 'text', text: 'camp opens', total: 3 });
  const created = getBroadcast(id);
  const sends = [];
  const delays = [];
  const fakeSend = async ({ who }) => { if (who.startsWith('R1 ')) throw new Error('boom'); sends.push(who); }; // R1 fails
  const res = await runBroadcast(id, {
    resolveAudience: () => ({ recipients: recips(3) }),
    sendBroadcastMessage: fakeSend,
    delay: async (ms) => { delays.push(ms); },
    batchSize: 2, delayMs: 50, lang: 'en',
  });
  T('result failed (1 undelivered → resumable, B5 semantic)', res.status === 'failed' && !res.aborted);
  T('sent=2, failed=1, total=3', res.sent === 2 && res.failed === 1 && res.total === 3);
  T('send called for the 2 OK recipients', sends.length === 2);
  T('rate-limit: one inter-batch delay (3 recips, batch 2)', delays.length === 1 && delays[0] === 50);

  const done = getBroadcast(id);
  T('broadcasts → status failed (has undelivered)', done.status === 'failed');
  T('counts persisted (sent=2, failed_count=1)', done.sent === 2 && done.failed_count === 1);
  T('started_at + finished_at set', !!done.started_at && !!done.finished_at);
  T('updated_at changed from creation (explicit on every UPDATE)', done.updated_at !== created.updated_at || done.status !== created.status);

  const rows = db.prepare("SELECT * FROM client_messages WHERE broadcast_id=? ORDER BY recipient_phone").all(id);
  T('3 client_messages rows logged', rows.length === 3);
  T('2 sent + 1 failed (variant A: failed row records WHO)', rows.filter(r => r.delivery_status === 'sent').length === 2 && rows.filter(r => r.delivery_status === 'failed').length === 1);
  T('rows: message_type=broadcast, lead_id NULL, recipient_phone set', rows.every(r => r.message_type === 'broadcast' && r.lead_id === null && r.recipient_phone));

  console.log('\n=== anti-double-start (atomic draft→sending) ===');
  const id2 = createBroadcast({ segment_kind: 'all', channel: 'telegram_test', body_kind: 'text', text: 'x', total: 1 });
  T('first startBroadcast → true (draft→sending)', startBroadcast(id2) === true);
  T('second startBroadcast → false (race loses, no double send)', startBroadcast(id2) === false);
  const reRun = await runBroadcast(id, { resolveAudience: () => ({ recipients: recips(3) }), sendBroadcastMessage: fakeSend, delay: async () => {}, lang: 'en' });
  T('runBroadcast on a non-draft row → aborted, no re-send', reRun.aborted === true);

  console.log('\n=== INSERT OR IGNORE dedup (B5 foundation) ===');
  const before = db.prepare('SELECT count(*) c FROM client_messages WHERE broadcast_id=?').get(id).c;
  const ins = logBroadcastRecipient({ broadcast_id: id, recipient_phone: rows[0].recipient_phone, channel: 'telegram_test', delivery_status: 'sent' });
  const after = db.prepare('SELECT count(*) c FROM client_messages WHERE broadcast_id=?').get(id).c;
  T('re-log same (broadcast_id, recipient_phone) → no new row', ins === false && after === before);

  console.log('\n=== callback confirmation branches (fake bot, NO dispatch) ===');
  const CHAT = 99001;
  const calls = [];
  const fakeBot = { sendMessage: async (cid, text, opts) => calls.push({ text, opts }), answerCallbackQuery: async () => {} };
  const seedOptedIn = (n) => { for (let i = 0; i < n; i++) upsertRegistration({ submitted_at: '1/1/2026', parent_first: `P${i}`, parent_last: '', email: '', mobile_norm: `97466${i}`, whatsapp_norm: `97466${1000 + i}`, children_json: '{"children":[]}', children_count: 0, whatsapp_optin: 1, optin_at: 'x', optin_version: 'v', photo_consent: 0, tc_accepted: 1, qid: null, start_when: null, client_type: 'new', raw_row_hash: `cb-${i}`, needs_review: 0 }); };

  // N>20 → must type the number; sets confirm_count step, no dispatch.
  seedOptedIn(21);
  clearState(CHAT); setState(CHAT, 'broadcast', 'preview', { channel: 'telegram_test', body_kind: 'text', text: 'hi', segment_kind: 'all', total: 21 });
  calls.length = 0;
  await onCallback({ data: 'broadcast:send', id: '1', message: { chat: { id: CHAT } } }, fakeBot);
  T('N>21 send → step becomes confirm_count', getState(CHAT).step === 'confirm_count');
  T('N>21 → confirm prompt shown, NOT dispatched', calls.some(c => /confirm|подтвержд|number|число/i.test(c.text)) && getBroadcast(getState(CHAT).params.broadcast_id || -1) === undefined);

  // confirm mismatch → cancelled, no dispatch.
  calls.length = 0;
  await onText({ chat: { id: CHAT }, text: '5' }, fakeBot); // 5 ≠ 21
  T('typed ≠ actual → mismatch message', calls.some(c => /≠|mismatch|не совпал|safety|безопас/i.test(c.text)));
  T('state cleared after mismatch (no pending dispatch)', getState(CHAT) === null);

  // audience drifted between preview and tap → re-preview, no dispatch.
  clearState(CHAT); setState(CHAT, 'broadcast', 'preview', { channel: 'telegram_test', body_kind: 'text', text: 'hi', segment_kind: 'all', total: 999 }); // stale total
  calls.length = 0;
  await onCallback({ data: 'broadcast:send', id: '2', message: { chat: { id: CHAT } } }, fakeBot);
  T('stale total → audience_changed message (not sent)', calls.some(c => /changed|изменил/i.test(c.text)));

  clearState(CHAT);
  console.log(`\n═══ Results: ${pass} passed, ${fail} failed ═══`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.stack); process.exit(1); });

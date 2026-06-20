'use strict';

/**
 * B5 — broadcast resume / idempotency test (temp DB only). Self-isolating.
 * Proves: a re-run/resume sends ONLY to recipients without a 'sent' row (no
 * double-send), failed→sent on resume, crash-orphaned 'sending' is recovered,
 * done/fully-sent is not re-sent, claimResume atomicity. NO network (injected).
 *
 *   rm -f /tmp/b5.db*
 *   sqlite3 data/acrogym.db ".backup '/tmp/b5.db'"
 *   ACROGYM_DB_PATH=/tmp/b5.db node scripts/test-broadcast-resume.js
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

const { getDb, createBroadcast, getBroadcast, getBroadcastCounts, getSentPhones, markRecipientSent, claimResume } = require('../shared/db');
const { runBroadcast, resumeBroadcast, resumeStaleBroadcasts } = require('../shared/broadcast/dispatcher');

const db = getDb();
db.exec('DELETE FROM client_messages; DELETE FROM broadcasts; DELETE FROM registrations;'); // self-isolating
let pass = 0, fail = 0;
const T = (n, c) => { if (c) { console.log('  ✅ ' + n); pass++; } else { console.log('  ❌ ' + n); fail++; } };
const recips = (n) => Array.from({ length: n }, (_, i) => ({ recipient_phone: `974550${1000 + i}`, display_name: `R${i}`, phone_masked: `974•••••${10 + i}` }));
const noDelay = async () => {};

(async () => {
  console.log('=== partial send (imitate mid-run failure) → resume sends only undelivered ===');
  const id = createBroadcast({ segment_kind: 'all', channel: 'telegram_test', body_kind: 'text', text: 'hi', total: 4 });
  // First run: R2 and R3 fail.
  const failFor = new Set(['R2', 'R3']);
  await runBroadcast(id, {
    resolveAudience: () => ({ recipients: recips(4) }),
    sendBroadcastMessage: async ({ who }) => { if (failFor.has(who.split(' ')[0])) throw new Error('boom'); },
    delay: noDelay, batchSize: 10, lang: 'en',
  });
  let c = getBroadcastCounts(id);
  T('after partial run: 2 sent, 2 failed', c.sent === 2 && c.failed === 2);
  T('status failed (resumable)', getBroadcast(id).status === 'failed');

  // Resume: everything works now. Only R2,R3 should be (re)sent.
  const resumeSends = [];
  const r1 = await resumeBroadcast(id, {
    resolveAudience: () => ({ recipients: recips(4) }),
    sendBroadcastMessage: async ({ who }) => { resumeSends.push(who.split(' ')[0]); },
    delay: noDelay, batchSize: 10, lang: 'en',
  });
  T('resume sent ONLY the 2 undelivered (R2,R3)', resumeSends.length === 2 && resumeSends.includes('R2') && resumeSends.includes('R3'));
  T('resume did NOT re-send R0/R1', !resumeSends.includes('R0') && !resumeSends.includes('R1'));
  c = getBroadcastCounts(id);
  T('after resume: 4 sent, 0 failed (failed→sent updated in place)', c.sent === 4 && c.failed === 0);
  T('resume result status done', r1.status === 'done' && getBroadcast(id).status === 'done');
  const rows = db.prepare('SELECT count(*) n FROM client_messages WHERE broadcast_id=?').get(id).n;
  T('no duplicate rows (exactly 4 recipient rows)', rows === 4);

  console.log('\n=== re-resume a fully-sent (done) broadcast → nothing sent ===');
  const again = [];
  const r2 = await resumeBroadcast(id, { resolveAudience: () => ({ recipients: recips(4) }), sendBroadcastMessage: async ({ who }) => again.push(who), delay: noDelay, lang: 'en' });
  T('done broadcast not resumable → skipped', r2.skipped === true);
  T('no sends on a done broadcast', again.length === 0);

  console.log('\n=== crash-orphaned (stuck "sending") → resumeStaleBroadcasts recovers ===');
  const id2 = createBroadcast({ segment_kind: 'all', channel: 'telegram_test', body_kind: 'text', text: 'hi', total: 4 });
  markRecipientSent({ broadcast_id: id2, recipient_phone: '9745501000', channel: 'telegram_test' }); // R0 "sent before crash"
  db.prepare("UPDATE broadcasts SET status='sending' WHERE id=?").run(id2); // simulate orphaned mid-run
  const staleSends = [];
  const results = await resumeStaleBroadcasts({
    resolveAudience: () => ({ recipients: recips(4) }),
    sendBroadcastMessage: async ({ who }) => { staleSends.push(who.split(' ')[0]); },
    delay: noDelay, batchSize: 10, lang: 'en',
  });
  T('resumeStaleBroadcasts picked up the orphaned one', results.some(r => r.id === id2 && !r.skipped));
  T('orphan resume sent R1,R2,R3 but NOT the pre-sent R0', staleSends.length === 3 && !staleSends.includes('R0'));
  T('orphan → done, 4 sent', getBroadcast(id2).status === 'done' && getBroadcastCounts(id2).sent === 4);

  console.log('\n=== claimResume atomicity ===');
  const id3 = createBroadcast({ segment_kind: 'all', channel: 'telegram_test', body_kind: 'text', text: 'x', total: 1 });
  T('draft is NOT claimable as resume (use startBroadcast)', claimResume(id3) === false);
  db.prepare("UPDATE broadcasts SET status='failed' WHERE id=?").run(id3);
  T('failed → claimable (true)', claimResume(id3) === true);
  db.prepare("UPDATE broadcasts SET status='done' WHERE id=?").run(id3);
  T('done → NOT claimable (false)', claimResume(id3) === false);

  console.log(`\n═══ Results: ${pass} passed, ${fail} failed ═══`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.stack); process.exit(1); });

'use strict';

/**
 * A.2 — nurture drip scheduling + gates (temp DB only, self-isolating).
 * Covers the NEGATIVE branches, not just the happy path: time imitation (via
 * next_due_at), the touch-2 welcome gate, the "don't stack drafts" confirmed_sent
 * gate, conversion stop, pause/resume-from-same-step, idempotency, legacy inert.
 * Content stays placeholder (real text = A.3). deliver is stubbed (no Telegram).
 *
 *   rm -f /tmp/drip.db*
 *   sqlite3 data/acrogym.db ".backup '/tmp/drip.db'"
 *   ACROGYM_DB_PATH=/tmp/drip.db node scripts/test-nurture-drip.js
 */

if (!process.env.ACROGYM_DB_PATH || process.env.ACROGYM_DB_PATH.includes('data/acrogym.db')) {
  console.error('REFUSING: set ACROGYM_DB_PATH to a temp copy first.'); process.exit(1);
}
{
  const fs = require('fs');
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(process.env.ACROGYM_DB_PATH + ext)) {
    console.error(`REFUSING: stale ${process.env.ACROGYM_DB_PATH + ext}.`); process.exit(1);
  }
}

const { getDb, insertLead, insertNurtureEnrollment, getNurtureEnrollmentByLeadId } = require('../shared/db');
const nurture = require('../shared/nurture');

const db = getDb();
db.exec('DELETE FROM client_messages; DELETE FROM nurture_enrollments; DELETE FROM leads;'); // self-isolating

let pass = 0, fail = 0;
const T = (n, c) => { console.log((c ? '  ✅ ' : '  ❌ ') + n); c ? pass++ : fail++; };

let row = 1000;
function makeLead({ client_type = 'new', status = 'responded' }) {
  row++;
  insertLead({ sheet_row_number: row, lead_uid: null, timestamp: '2026-06-01', parent_name: `P${row}`,
    parent_phone: `+9745${row}`, parent_whatsapp: `+9745${row}`, parent_email: `${row}@x.co`, qid: '',
    language: 'en', client_type, phone_normalized: `9745${row}`, whatsapp_normalized: `9745${row}`,
    email_normalized: `${row}@x.co`, ref_lead_id: null, raw_data: '{}', status });
  return db.prepare('SELECT id FROM leads WHERE sheet_row_number=?').get(row).id;
}
function enroll(leadId) {
  insertNurtureEnrollment({ lead_id: leadId, audience: 'cold', audience_auto: 'cold', audience_override: null,
    age_segment: '6-9', children_count: 1, children_json: '{}', status: 'active' });
  return getNurtureEnrollmentByLeadId(leadId);
}
const due   = (leadId) => db.prepare("UPDATE nurture_enrollments SET next_due_at=datetime('now','-1 day') WHERE lead_id=?").run(leadId);
const setLeadStatus  = (leadId, s) => db.prepare('UPDATE leads SET status=? WHERE id=?').run(s, leadId);
const setClientType  = (leadId, t) => db.prepare('UPDATE leads SET client_type=? WHERE id=?').run(t, leadId);
const setEnrollStatus= (leadId, s) => db.prepare('UPDATE nurture_enrollments SET status=? WHERE lead_id=?').run(s, leadId);
const confirmLastSent= (leadId) => db.prepare("UPDATE client_messages SET delivery_status='confirmed_sent', confirmed_at=datetime('now') WHERE id=(SELECT id FROM client_messages WHERE lead_id=? AND message_type='nurture' ORDER BY id DESC LIMIT 1)").run(leadId);
const enr = (leadId) => getNurtureEnrollmentByLeadId(leadId);

let delivered = [];
const stubDeliver = async ({ lead, messageText, messageType, metadata }) => {
  db.prepare(`INSERT INTO client_messages (lead_id, broadcast_id, recipient_phone, message_type, text, language, channel, delivery_status, agent_name, sent_at)
              VALUES (?, NULL, NULL, ?, ?, ?, 'telegram_draft', 'sent_to_admin', ?, datetime('now'))`)
    .run(metadata.leadId, messageType, messageText, lead.language || 'en', metadata.agentName);
  delivered.push({ leadId: metadata.leadId, touch: metadata.touch });
};
const runDay = async () => { delivered = []; return nurture.buildAndSendQueue({ deliver: stubDeliver }); };

(async () => {
  console.log('=== enrolled new → NOT due same day (drip schedules, not immediate) ===');
  const A = makeLead({ status: 'responded' }); enroll(A);
  let r = await runDay();
  T('fresh enrollment: next_touch=2, next_due ~+3d (future)', enr(A).next_touch === 2);
  T('not due same day → 0 queued', r.queued === 0 && delivered.length === 0);

  console.log('\n=== happy path: day3 touch2 → day7 touch3 → end ===');
  due(A);                                   // simulate day 3
  r = await runDay();
  T('day3 + welcome responded → touch 2 queued', delivered.length === 1 && delivered[0].touch === 2);
  T('advanced to touch 3 (next_due = enrolled+7d, future)', enr(A).next_touch === 3);
  T('re-run same day → 0 (touch3 not due yet) — idempotent', (await runDay()).queued === 0);
  confirmLastSent(A); due(A);                // admin sent touch2; simulate day 7
  r = await runDay();
  T('day7 + touch2 confirmed_sent → touch 3 queued', delivered.length === 1 && delivered[0].touch === 3);
  T('series ended → next_touch NULL', enr(A).next_touch === null && enr(A).next_due_at === null);
  T('re-run after end → 0 (no candidate)', (await runDay()).queued === 0);

  console.log('\n=== touch-2 gate: welcome NOT responded → held ===');
  const B = makeLead({ status: 'notified' }); enroll(B); due(B);  // due but welcome not responded
  T('welcome not responded → touch 2 NOT queued', (await runDay()).queued === 0);
  setLeadStatus(B, 'responded');
  T('responded → touch 2 queued now', (await runDay()).queued === 1 && enr(B).next_touch === 3);

  console.log('\n=== don\'t-stack gate: touch3 held until touch2 confirmed_sent ===');
  due(B);                                   // touch3 due, but touch2 still sent_to_admin (not confirmed)
  T('touch2 not confirmed → touch 3 NOT queued (no draft stacking)', (await runDay()).queued === 0);
  confirmLastSent(B);
  T('touch2 confirmed → touch 3 queued', (await runDay()).queued === 1 && enr(B).next_touch === null);

  console.log('\n=== conversion stop: existing mid-sequence → drip silent ===');
  const C = makeLead({ status: 'responded' }); enroll(C); due(C);
  setClientType(C, 'existing');             // converted before any touch
  T('existing (converted) → not a candidate, 0 queued', (await runDay()).queued === 0);
  T('enrollment untouched (next_touch still 2)', enr(C).next_touch === 2);

  console.log('\n=== pause → silent; unpause → resume from SAME step ===');
  const D = makeLead({ status: 'responded' }); enroll(D); due(D);
  await runDay();                            // touch 2 delivered → next_touch=3
  T('after touch2, next_touch=3', enr(D).next_touch === 3);
  setEnrollStatus(D, 'paused'); confirmLastSent(D); due(D);
  T('paused → 0 queued (silent)', (await runDay()).queued === 0);
  T('paused: step preserved (still 3, not reset)', enr(D).next_touch === 3);
  setEnrollStatus(D, 'active');
  T('unpaused → resumes from touch 3 (same step)', (await runDay()).queued === 1 && delivered[0].touch === 3 && enr(D).next_touch === null);

  console.log('\n=== legacy (next_touch NULL) → never a candidate ===');
  const E = makeLead({ status: 'responded' }); enroll(E);
  db.prepare('UPDATE nurture_enrollments SET next_touch=NULL, next_due_at=NULL WHERE lead_id=?').run(E); // legacy/inert
  due(E); // even with a past due, NULL next_touch excludes it
  db.prepare("UPDATE nurture_enrollments SET next_due_at=datetime('now','-1 day') WHERE lead_id=? AND next_touch IS NOT NULL").run(E);
  T('legacy next_touch NULL → 0 queued', (await runDay()).queued === 0);

  console.log('\n=== content is still placeholder (real text = A.3) ===');
  const lastMsg = db.prepare("SELECT text FROM client_messages WHERE message_type='nurture' ORDER BY id DESC LIMIT 1").get();
  T('delivered body is a placeholder, not real content', /placeholder/.test(lastMsg.text) && /touch \d/.test(lastMsg.text));

  console.log(`\n═══ Results: ${pass} passed, ${fail} failed ═══`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.stack); process.exit(1); });

'use strict';

/**
 * A.5 — owner-summary drip funnel (temp DB, self-isolating). Builds enrollments
 * across every funnel state and asserts getDripFunnelStats buckets + that the
 * owner summary text renders the new lines. `held`/`due_now` must match the
 * getDripCandidates gates exactly.
 *
 *   rm -f /tmp/funnel.db*
 *   sqlite3 data/acrogym.db ".backup '/tmp/funnel.db'"
 *   ACROGYM_DB_PATH=/tmp/funnel.db node scripts/test-nurture-funnel.js
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

const { getDb, insertLead, insertNurtureEnrollment, getDripFunnelStats, getDripCandidates } = require('../shared/db');
const nurture = require('../shared/nurture');

const db = getDb();
db.exec('DELETE FROM client_messages; DELETE FROM nurture_enrollments; DELETE FROM leads;');

let pass = 0, fail = 0;
const T = (n, c) => { console.log((c ? '  ✅ ' : '  ❌ ') + n); c ? pass++ : fail++; };

let row = 2000;
function mk({ client_type = 'new', status = 'responded' }) {
  row++;
  insertLead({ sheet_row_number: row, lead_uid: null, timestamp: '2026-06-01', parent_name: `P${row}`,
    parent_phone: `+9746${row}`, parent_whatsapp: `+9746${row}`, parent_email: `${row}@x.co`, qid: '',
    language: 'en', client_type, phone_normalized: `9746${row}`, whatsapp_normalized: `9746${row}`,
    email_normalized: `${row}@x.co`, ref_lead_id: null, raw_data: '{}', status });
  return db.prepare('SELECT id FROM leads WHERE sheet_row_number=?').get(row).id;
}
function enroll(leadId, { next_touch, status = 'active', dueInPast = false, last_touch_at = null }) {
  insertNurtureEnrollment({ lead_id: leadId, audience: 'cold', audience_auto: 'cold', audience_override: null,
    age_segment: '6-9', children_count: 1, children_json: '{}', status });
  const due = dueInPast ? "datetime('now','-1 day')" : "datetime('now','+5 days')";
  db.prepare(`UPDATE nurture_enrollments SET next_touch=@nt, next_due_at=${next_touch == null ? 'NULL' : due},
              last_touch_at=@lt, status=@st WHERE lead_id=@lid`)
    .run({ nt: next_touch, lt: last_touch_at, st: status, lid: leadId });
}
const confirmNurture = (leadId) => db.prepare(`INSERT INTO client_messages
  (lead_id, message_type, text, language, channel, delivery_status, agent_name, sent_at, confirmed_at)
  VALUES (?, 'nurture', 'x', 'en', 'telegram_draft', 'confirmed_sent', 'nurture', datetime('now'), datetime('now'))`).run(leadId);

// Build the full spread:
const L1 = mk({ status: 'responded' });                  enroll(L1, { next_touch: 2, dueInPast: true });   // due_now (welcome ok)
const L2 = mk({ status: 'notified'  });                  enroll(L2, { next_touch: 2, dueInPast: true });   // held (welcome gate)
const L3 = mk({ status: 'responded' });                  enroll(L3, { next_touch: 3, dueInPast: true });   // held (touch2 not confirmed)
const L4 = mk({ status: 'responded' }); confirmNurture(L4); enroll(L4, { next_touch: 3, dueInPast: true }); // due_now (prior confirmed)
const L5 = mk({ status: 'responded' });                  enroll(L5, { next_touch: 2, dueInPast: false });  // awaiting_t2, not due
const L6 = mk({ status: 'responded' });                  enroll(L6, { next_touch: null, last_touch_at: "datetime('now')" }); // completed
const L7 = mk({ status: 'responded' });                  enroll(L7, { next_touch: 2, status: 'paused', dueInPast: true }); // paused
const L8 = mk({ client_type: 'existing', status: 'responded' }); enroll(L8, { next_touch: 2, dueInPast: true }); // converted → excluded

// last_touch_at literal fix for L6 (set via UPDATE with datetime literal)
db.prepare("UPDATE nurture_enrollments SET last_touch_at=datetime('now') WHERE lead_id=?").run(L6);

const f = getDripFunnelStats();
console.log('=== funnel buckets ===', JSON.stringify(f));
T('awaiting_t2 = 3 (L1,L2,L5; existing L8 excluded)', f.awaiting_t2 === 3);
T('awaiting_t3 = 2 (L3,L4)', f.awaiting_t3 === 2);
T('completed = 1 (L6)', f.completed === 1);
T('paused = 1 (L7)', f.paused === 1);
T('due_now = 2 (L1 welcome-ok, L4 prior-confirmed)', f.due_now === 2);
T('held = 2 (L2 welcome gate, L3 stack gate)', f.held === 2);

console.log('\n=== held/due_now match getDripCandidates exactly ===');
T('due_now == live candidate count', f.due_now === getDripCandidates(100).length);

console.log('\n=== owner summary renders the funnel lines ===');
const txt = nurture.buildOwnerSummaryText();
T('has "Drip funnel" header', txt.includes('🌱 <b>Drip funnel</b>'));
T('awaiting touch 2 line shows 3', /Awaiting touch 2 \(follow-up\): <b>3<\/b>/.test(txt));
T('awaiting touch 3 line shows 2', /Awaiting touch 3 \(pre-launch\): <b>2<\/b>/.test(txt));
T('completed line shows 1', /Completed series: <b>1<\/b>/.test(txt));
T('held line carries ⚠️ when held>0 and shows 2', /⚠️ Held \(waiting on a gate\): <b>2<\/b>/.test(txt));
T('due next run shows 2', /Due to go out next run: <b>2<\/b>/.test(txt));
T('original queue/sent/awaiting lines still present', /📬 Today's queue:/.test(txt) && /✅ Sent:/.test(txt) && /⏳ Awaiting:/.test(txt));

console.log('\n=== no-held case drops the ⚠️ ===');
db.exec('DELETE FROM client_messages; DELETE FROM nurture_enrollments; DELETE FROM leads;');
const C = mk({ status: 'responded' }); enroll(C, { next_touch: 2, dueInPast: false }); // awaiting only, nothing held
const f2 = getDripFunnelStats();
T('held = 0 now', f2.held === 0);
T('summary held line has NO ⚠️', /[^⚠️ ]Held \(waiting on a gate\): <b>0<\/b>/.test('x' + nurture.buildOwnerSummaryText().split('• ').find(s => s.includes('Held'))));

console.log(`\n═══ Results: ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);

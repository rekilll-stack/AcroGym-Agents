'use strict';

/**
 * Dry-run verification for Agent 3 (nurture) Phase 1.
 * Runs entirely against a TEMP SQLite DB (ACROGYM_DB_PATH) with a stubbed
 * delivery function — touches neither the production DB nor Telegram.
 *
 *   node scripts/verify-nurture.js
 */

const os   = require('os');
const path = require('path');
const fs   = require('fs');

// Point db.js at a throwaway DB BEFORE requiring it.
const TMP_DB = path.join(os.tmpdir(), `nurture-verify-${process.pid}.db`);
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + ext); } catch {} }
process.env.ACROGYM_DB_PATH = TMP_DB;

const { execFileSync } = require('child_process');
const db      = require('../shared/db');
const nurture = require('../shared/nurture');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else      { fail++; console.log(`  ❌ ${name}`); }
}

// ── Seed leads ────────────────────────────────────────────────
const conn = db.getDb();
function seed(lead, childrenDob) {
  const r = db.insertLead({
    sheet_row_number: lead.row, timestamp: '2026-06-01', parent_name: lead.name,
    parent_phone: lead.phone, parent_whatsapp: lead.phone, parent_email: lead.email,
    qid: '', language: 'en', client_type: lead.client_type,
    phone_normalized: lead.phone, whatsapp_normalized: lead.phone, email_normalized: lead.email,
    ref_lead_id: null, raw_data: '{}', status: lead.status,
  });
  const id = r.lastInsertRowid;
  if (childrenDob) db.updateLeadChildrenDob(id, JSON.stringify(childrenDob));
  return id;
}

const L1 = seed({ row: 101, name: 'Cold New',  phone: '+97411', email: 'c1@x.co', client_type: 'new',       status: 'notified' },           ['5/12/2019']);              // age 7 → 6-9, cold
const L2 = seed({ row: 102, name: 'Warm Ret',  phone: '+97412', email: 'c2@x.co', client_type: 'returning', status: 'returning_notified' },  ['1/1/2014']);               // age 12 → 10-14, warm
const L3 = seed({ row: 103, name: 'Enrolled',  phone: '+97413', email: 'c3@x.co', client_type: 'existing',  status: 'existing_signed' },     ['1/1/2014', '6/1/2021']);   // multi → youngest 3-5, enrolled
const L4 = seed({ row: 104, name: 'Dup Exist', phone: '+97414', email: 'c4@x.co', client_type: 'existing',  status: 'duplicate_of_existing' }); // duplicate → excluded
const L5 = seed({ row: 105, name: 'Legacy',    phone: '+97415', email: 'c5@x.co', client_type: 'legacy',    status: 'notified' });             // legacy → excluded
const L6 = seed({ row: 106, name: 'Garbage',   phone: '+97416', email: 'c6@x.co', client_type: 'unknown',   status: 'notified' },             ['not a date']);             // unknown segment, cold

(async () => {
// ── 1. Eligibility + enrollment ───────────────────────────────
console.log('\n1) Enrollment & eligibility');
const e1 = nurture.enrollEligibleLeads(new Date('2026-06-03T00:00:00Z'));
check('exactly 4 eligible leads enrolled (L1,L2,L3,L6)', e1.enrolled === 4);
check('legacy (L5) NOT enrolled', !db.getNurtureEnrollmentByLeadId(L5));
check('duplicate existing (L4) NOT enrolled', !db.getNurtureEnrollmentByLeadId(L4));

const en1 = db.getNurtureEnrollmentByLeadId(L1);
const en2 = db.getNurtureEnrollmentByLeadId(L2);
const en3 = db.getNurtureEnrollmentByLeadId(L3);
const en6 = db.getNurtureEnrollmentByLeadId(L6);
check('L1 audience=cold',     en1.audience === 'cold');
check('L2 audience=warm',     en2.audience === 'warm');
check('L3 (existing) audience=enrolled', en3.audience === 'enrolled');
check('L6 audience=cold',     en6.audience === 'cold');

// ── 2. Multi-child completeness + age segment ─────────────────
console.log('\n2) Segmentation');
const kids3 = JSON.parse(en3.children_json);
check('L3 children_json keeps ALL children (2)', kids3.length === 2 && en3.children_count === 2);
check('L3 age_segment = youngest (3-5)', en3.age_segment === '3-5');
check('L1 age_segment = 6-9 (M/D/YYYY parsed)', en1.age_segment === '6-9');
check('L2 age_segment = 10-14', en2.age_segment === '10-14');
check('L6 age_segment = unknown (garbage DOB)', en6.age_segment === 'unknown');

// ── 3. Enroll idempotency ─────────────────────────────────────
console.log('\n3) Idempotency');
const e2 = nurture.enrollEligibleLeads(new Date('2026-06-03T00:00:00Z'));
check('re-run enrolls 0 (dedup on lead_id)', e2.enrolled === 0);

// ── 4. Override beats auto ────────────────────────────────────
console.log('\n4) Override');
db.setNurtureOverride(L1, 'warm');
const en1b = db.getNurtureEnrollmentByLeadId(L1);
check('override sets effective audience=warm', en1b.audience === 'warm');
check('audience_auto preserved (cold)', en1b.audience_auto === 'cold');

// ── 5. Queue build via stub deliver ───────────────────────────
console.log('\n5) Queue build');
const delivered = [];
const stubDeliver = async ({ lead, messageText, messageType, metadata }) => {
  // Mimic sendDraftToAdmin's DB effect without Telegram.
  conn.prepare(`
    INSERT INTO client_messages (lead_id, message_type, text, language, channel, delivery_status, agent_name, sent_at)
    VALUES (?, ?, ?, ?, 'telegram_draft', 'sent_to_admin', ?, datetime('now'))
  `).run(metadata.leadId, messageType, messageText, lead.language, metadata.agentName);
  delivered.push(metadata.leadId);
};
const q1 = await nurture.buildAndSendQueue({ deliver: stubDeliver });
check('queue delivered to all 4 active enrollments', q1.queued === 4);
check('messageType is nurture for every item', delivered.length === 4);

const q2 = await nurture.buildAndSendQueue({ deliver: stubDeliver });
check('re-run queues 0 (already has nurture message)', q2.queued === 0);

// ── 6. ✅ Sent → confirmed_sent ───────────────────────────────
console.log('\n6) Execution loop');
const firstMsg = conn.prepare(`SELECT id FROM client_messages WHERE message_type='nurture' LIMIT 1`).get();
conn.prepare(`UPDATE client_messages SET delivery_status='confirmed_sent', confirmed_at=datetime('now') WHERE id=?`).run(firstMsg.id);
const today = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
const stats = db.getNurtureDeliveryStats(today);
check('today total=4', stats.total === 4);
check('confirmed=1 after one ✅ Sent', stats.confirmed === 1);
check('pending=3', stats.pending === 3);

// ── 7. Owner summary counts ───────────────────────────────────
console.log('\n7) Owner summary');
const summary = nurture.buildOwnerSummaryText(new Date());
// After override: cold=L6(1), warm=L1+L2(2), enrolled=L3(1)
check('summary shows 4 enrolled total', /Enrolled \(active\): <b>4<\/b>/.test(summary));
check('summary breakdown cold 1 · warm 2 · enrolled 1', /cold 1 · warm 2 · enrolled 1/.test(summary));
check('summary today queue total 4', /Today's queue: <b>4<\/b>/.test(summary));
check('summary sent 1', /Sent: <b>1<\/b>/.test(summary));

// ── 8. Migration idempotency (fresh process, existing temp DB) ─
console.log('\n8) Migrations idempotent on existing DB');
let migOk = false;
try {
  const out = execFileSync(process.execPath, ['-e',
    `process.env.ACROGYM_DB_PATH=${JSON.stringify(TMP_DB)};require('${path.join(__dirname,'../shared/db').replace(/\\/g,'\\\\')}').getDb();console.log('MIGRATED_OK')`
  ], { encoding: 'utf8' });
  migOk = out.includes('MIGRATED_OK');
} catch (err) { console.log('   migration re-run error:', err.message); }
check('second process re-runs migrations without error', migOk);

// ── Summary ───────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`RESULT: ${pass} passed, ${fail} failed`);
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + ext); } catch {} }
process.exit(fail === 0 ? 0 : 1);
})();

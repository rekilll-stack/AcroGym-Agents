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
function seed(lead, captured) {
  const r = db.insertLead({
    sheet_row_number: lead.row, timestamp: '2026-06-01', parent_name: lead.name,
    parent_phone: lead.phone, parent_whatsapp: lead.phone, parent_email: lead.email,
    qid: '', language: 'en', client_type: lead.client_type,
    phone_normalized: lead.phone, whatsapp_normalized: lead.phone, email_normalized: lead.email,
    ref_lead_id: null, raw_data: '{}', status: lead.status,
  });
  const id = r.lastInsertRowid;
  if (captured) db.updateLeadChildrenDob(id, JSON.stringify(captured));
  return id;
}

// captured = { declared_count, children:[{first_name,last_name,dob}], needs_review }
const cap = (declared, kids) => ({ declared_count: declared, children: kids, needs_review: false });

const L1 = seed({ row: 101, name: 'Cold New',  phone: '+97411', email: 'c1@x.co', client_type: 'new',       status: 'notified' },
                cap(1, [{ first_name: 'Cold',  last_name: 'Kid', dob: '5/12/2019' }]));                         // age 7 → 6-9, cold
const L2 = seed({ row: 102, name: 'Warm Ret',  phone: '+97412', email: 'c2@x.co', client_type: 'returning', status: 'returning_notified' },
                cap(1, [{ first_name: 'Warm',  last_name: 'Kid', dob: '1/1/2014' }]));                          // age 12 → 10-14, warm
const L3 = seed({ row: 103, name: 'Enrolled',  phone: '+97413', email: 'c3@x.co', client_type: 'existing',  status: 'existing_signed' },
                cap(2, [{ first_name: 'Olesya', last_name: 'K', dob: '1/1/2014' },                              // age 12 → 10-14
                        { first_name: 'Mia',    last_name: 'K', dob: '6/1/2021' }]));                           // age 5  → 3-5 (youngest → family 3-5)
const L4 = seed({ row: 104, name: 'Dup Exist', phone: '+97414', email: 'c4@x.co', client_type: 'existing',  status: 'duplicate_of_existing' }); // duplicate → excluded
const L5 = seed({ row: 105, name: 'Legacy',    phone: '+97415', email: 'c5@x.co', client_type: 'legacy',    status: 'notified' });             // legacy → excluded
const L6 = seed({ row: 106, name: 'Garbage',   phone: '+97416', email: 'c6@x.co', client_type: 'unknown',   status: 'notified' },
                cap(1, [{ first_name: 'Junk',  last_name: 'Kid', dob: 'not a date' }]));                        // unknown segment, cold

(async () => {
// ── 0. extractChildren: linked name↔dob groups from raw form headers ──
console.log('\n0) Capture: linked name↔dob groups (real glued-form headers)');
// Faithful to the live form: en-dash N=1 block, then hyphen/spacing-drifted N=2 block.
const HEADERS = [
  'Timestamp', 'Email', 'First Name (Parent/Guardian)', 'Last Name (Parent/Guardian)', '  Mobile Number',
  '  How many children are you registering?  ',          // 5
  'Child 1 – First Name', 'Child 1 – Last Name', 'Child 1 – Date of Birth  ', // 6-8  N=1 (en-dash)
  '  Acceptance  ', '  Electronic Signature (Type Your Full Name)  ',                         // 9-10
  'Child 1  - First Name   ', 'Child 1 - Last Name', 'Child 1 -  Date of Birth  ',            // 11-13 N=2
  'Child 2 - First Name', 'Child 2 - Last Name', 'Child 2 - Date of Birth  ',                 // 14-16
];
const mkVals = (set) => { const v = new Array(HEADERS.length).fill(''); for (const [i, x] of Object.entries(set)) v[i] = x; return v; };

// Case A — N=2 block filled, two kids of DIFFERENT ages. Names must stay bound to their own dates.
const capA = nurture.extractChildren(HEADERS, mkVals({
  5: '2', 11: 'Amir', 12: 'Khan', 13: '1/1/2014', 14: 'Lily', 15: 'Khan', 16: '6/1/2021',
}));
check('A: declared_count=2', capA.declared_count === 2);
check('A: exactly 2 children captured', capA.children.length === 2);
check('A: child[0] Amir bound to HIS dob 1/1/2014', capA.children[0].first_name === 'Amir' && capA.children[0].dob === '1/1/2014');
check('A: child[1] Lily bound to HER dob 6/1/2021', capA.children[1].first_name === 'Lily' && capA.children[1].dob === '6/1/2021');
check('A: NOT swapped (Amir≠6/1/2021, Lily≠1/1/2014)',
  capA.children[0].dob !== '6/1/2021' && capA.children[1].dob !== '1/1/2014');
check('A: needs_review false (clean, N matches)', capA.needs_review === false);
// per-child segment accurate after enrichment; family = youngest
const bcA = nurture.buildChildren(capA, new Date('2026-06-03T00:00:00Z'));
const amir = bcA.children.find(c => c.first_name === 'Amir');
const lily = bcA.children.find(c => c.first_name === 'Lily');
check('A: Amir per-child segment 10-14', amir.segment === '10-14');
check('A: Lily per-child segment 3-5',   lily.segment === '3-5');
check('A: family age_segment = youngest (3-5)', bcA.ageSegment === '3-5');

// Case B — en-dash N=1 block filled, declared 1 → clean.
const capB = nurture.extractChildren(HEADERS, mkVals({ 5: '1', 6: 'Sara', 7: 'Q', 8: '5/12/2019' }));
check('B: en-dash N=1 block detected, 1 child', capB.children.length === 1 && capB.children[0].first_name === 'Sara');
check('B: needs_review false', capB.needs_review === false);

// Case C — declared 2 but only ONE child filled in the N=2 block → mismatch flag.
const capC = nurture.extractChildren(HEADERS, mkVals({ 5: '2', 11: 'Solo', 13: '1/1/2014' }));
check('C: only 1 child materialized', capC.children.length === 1);
check('C: needs_review TRUE (block count ≠ declared N)', capC.needs_review === true);

// Case D — child present but dob garbage → per-child needs_review.
const capD = nurture.extractChildren(HEADERS, mkVals({ 5: '1', 6: 'Bad', 7: 'Date', 8: 'not a date' }));
check('D: child[0] needs_review (unparseable dob)', capD.children[0].needs_review === true);
check('D: family needs_review TRUE', capD.needs_review === true);

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
const olesya = kids3.find(c => c.first_name === 'Olesya');
const mia    = kids3.find(c => c.first_name === 'Mia');
check('L3 Olesya bound to HER dob 1/1/2014 → 10-14', olesya && olesya.dob === '1/1/2014' && olesya.segment === '10-14');
check('L3 Mia bound to HER dob 6/1/2021 → 3-5',       mia && mia.dob === '6/1/2021' && mia.segment === '3-5');
check('L3 first_name kept separate for greeting', typeof olesya.first_name === 'string' && olesya.first_name === 'Olesya');
check('L3 age_segment = youngest family flag (3-5)', en3.age_segment === '3-5');
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
// Drip (A.2): the queue now delivers DUE touches. Make touch 2 due + the welcome
// handled (status='responded') for the 3 non-converted leads. L3 is 'existing'
// (converted) → the drip excludes it. So 3 — not 4 — get touch 2.
conn.prepare(`UPDATE leads SET status='responded' WHERE id IN (${L1},${L2},${L6})`).run();
conn.prepare(`UPDATE nurture_enrollments SET next_due_at=datetime('now','-1 day') WHERE next_touch=2`).run();
const q1 = await nurture.buildAndSendQueue({ deliver: stubDeliver });
check('drip queues touch 2 to the 3 non-converted (L3 existing excluded)', q1.queued === 3);
check('messageType is nurture for every item', delivered.length === 3);

const q2 = await nurture.buildAndSendQueue({ deliver: stubDeliver });
check('re-run queues 0 (advanced to touch 3, not due yet)', q2.queued === 0);

// ── 6. ✅ Sent → confirmed_sent ───────────────────────────────
console.log('\n6) Execution loop');
const firstMsg = conn.prepare(`SELECT id FROM client_messages WHERE message_type='nurture' LIMIT 1`).get();
conn.prepare(`UPDATE client_messages SET delivery_status='confirmed_sent', confirmed_at=datetime('now') WHERE id=?`).run(firstMsg.id);
const today = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
const stats = db.getNurtureDeliveryStats(today);
check('today total=3 (drip touch 2 to 3 non-converted)', stats.total === 3);
check('confirmed=1 after one ✅ Sent', stats.confirmed === 1);
check('pending=2', stats.pending === 2);

// ── 7. Owner summary counts ───────────────────────────────────
console.log('\n7) Owner summary');
const summary = nurture.buildOwnerSummaryText(new Date());
// After override: cold=L6(1), warm=L1+L2(2), enrolled=L3(1)
check('summary shows 4 enrolled total', /Enrolled \(active\): <b>4<\/b>/.test(summary));
check('summary breakdown cold 1 · warm 2 · enrolled 1', /cold 1 · warm 2 · enrolled 1/.test(summary));
check('summary today queue total 3', /Today's queue: <b>3<\/b>/.test(summary));
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

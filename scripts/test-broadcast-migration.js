'use strict';

/**
 * B1 — broadcast migration (v22) test (temp DB only).
 *
 * Proves the additive migration: broadcasts table, client_messages.broadcast_id
 * + recipient_phone, the 3 indexes (incl. the partial UNIQUE), leads.child_age,
 * that existing data is intact, and that the REAL saveLead persists child_age.
 *
 *   rm -f /tmp/b1.db*
 *   sqlite3 data/acrogym.db ".backup '/tmp/b1.db'"   # consistent — captures WAL
 *   ACROGYM_DB_PATH=/tmp/b1.db node scripts/test-broadcast-migration.js
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

const { getDb } = require('../shared/db');
const { saveLead } = require('../agents/lead-helper/index'); // require.main guard → no agent start

const db = getDb(); // open temp + migrate to v22

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { console.log('  ✅ ' + n); pass++; } else { console.log('  ❌ ' + n); fail++; } };

const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
const idxSql = (name) => { const r = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name=?`).get(name); return r && r.sql; };

console.log('=== broadcasts table created with the agreed columns ===');
const bc = cols('broadcasts');
const expectBc = ['id','status','segment_kind','segment_value','segment_min','segment_max','channel','body_kind','text','template_name','template_params_json','total','sent','failed_count','created_at','updated_at','started_at','finished_at'];
t('broadcasts exists', bc.length > 0);
t('broadcasts has all expected columns', expectBc.every(c => bc.includes(c)));

console.log('=== client_messages additive columns ===');
const cm = cols('client_messages');
t('client_messages.broadcast_id added', cm.includes('broadcast_id'));
t('client_messages.recipient_phone added', cm.includes('recipient_phone'));
t('old client_messages columns intact (lead_id, delivery_status, sent_at)',
  ['lead_id','delivery_status','sent_at','message_type','channel'].every(c => cm.includes(c)));

console.log('=== leads.child_age added, old columns intact ===');
const ld = cols('leads');
t('leads.child_age added', ld.includes('child_age'));
t('old leads columns intact (lead_uid, children_dob, source, parent_name)',
  ['lead_uid','children_dob','source','parent_name','phone_normalized'].every(c => ld.includes(c)));

console.log('=== 3 new indexes present, last one UNIQUE + partial ===');
t('idx_broadcasts_status exists', !!idxSql('idx_broadcasts_status'));
t('idx_client_msgs_broadcast exists', !!idxSql('idx_client_msgs_broadcast'));
const uSql = idxSql('idx_cm_broadcast_recipient');
t('idx_cm_broadcast_recipient exists', !!uSql);
t('…is UNIQUE', /UNIQUE/i.test(uSql || ''));
t('…is partial (WHERE broadcast_id IS NOT NULL)', /WHERE\s+broadcast_id\s+IS\s+NOT\s+NULL/i.test(uSql || ''));

console.log('=== existing data intact (prod copy: leads=12, registrations=8) ===');
t('leads rows untouched (12)', db.prepare('SELECT count(*) c FROM leads').get().c === 12);
t('registrations rows untouched (8)', db.prepare('SELECT count(*) c FROM registrations').get().c === 8);
const cmBefore = db.prepare('SELECT count(*) c FROM client_messages').get().c;
console.log('  client_messages rows before test inserts:', cmBefore);

console.log('=== partial UNIQUE(broadcast_id, recipient_phone) enforced ===');
const bId = db.prepare(`INSERT INTO broadcasts (status, segment_kind, channel, body_kind, text, total)
                        VALUES ('draft','all','telegram_test','text','hi',1)`).run().lastInsertRowid;
const insCm = (broadcastId, phone) => db.prepare(`INSERT INTO client_messages
  (lead_id, message_type, text, language, channel, delivery_status, agent_name, broadcast_id, recipient_phone)
  VALUES (NULL, 'broadcast', 'hi', 'en', 'telegram_test', 'sent', 'broadcast', @b, @p)`).run({ b: broadcastId, p: phone });
insCm(bId, '97455500001');
let dupRejected = false;
try { insCm(bId, '97455500001'); } catch (e) { dupRejected = /UNIQUE/i.test(e.message); }
t('same (broadcast_id, recipient_phone) twice → rejected by UNIQUE', dupRejected);
let orIgnore = db.prepare(`INSERT OR IGNORE INTO client_messages
  (lead_id, message_type, channel, delivery_status, broadcast_id, recipient_phone)
  VALUES (NULL,'broadcast','telegram_test','sent',@b,@p)`).run({ b: bId, p: '97455500001' });
t('INSERT OR IGNORE on dup → 0 rows (resend is a no-op)', orIgnore.changes === 0);
// Partial: NULL broadcast_id rows must NOT collide with each other.
const n1 = db.prepare(`INSERT INTO client_messages (lead_id, message_type, channel, delivery_status) VALUES (NULL,'nurture','telegram','sent')`).run();
const n2 = db.prepare(`INSERT INTO client_messages (lead_id, message_type, channel, delivery_status) VALUES (NULL,'nurture','telegram','sent')`).run();
t('two NULL-broadcast_id rows coexist (partial index, no false collision)', n1.changes === 1 && n2.changes === 1);

console.log('=== REAL saveLead persists child_age (isolated UPDATE) ===');
const parsed = {
  lead_uid: 'b1-test-uid-001', timestamp: '2026-06-20 10:00:00',
  parent_name: 'B1 Tester', parent_phone: '+97455500777', parent_whatsapp: '+97455500777',
  parent_email: 'b1@x.com', qid: 'Q1', client_type: 'new',
  source: null, children_dob: null, child_age: '7',
};
const res = saveLead(null, parsed, '97455500777', '97455500777', 'b1@x.com', 'new');
const saved = db.prepare('SELECT child_age FROM leads WHERE id = ?').get(res.lastInsertRowid);
t('saveLead inserted the lead', !!res.lastInsertRowid);
t('child_age persisted via saveLead', saved && saved.child_age === '7');
// Isolation: a lead with no child_age still saves cleanly (no throw, null age).
const res2 = saveLead(null, { ...parsed, lead_uid: 'b1-test-uid-002', child_age: undefined }, '97455500778', '97455500778', 'b1b@x.com', 'new');
const saved2 = db.prepare('SELECT child_age FROM leads WHERE id = ?').get(res2.lastInsertRowid);
t('lead without child_age still saves (age null, no break)', !!res2.lastInsertRowid && saved2.child_age == null);

console.log(`\n═══ Results: ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);

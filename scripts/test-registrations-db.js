'use strict';

/**
 * R3 — registrations DB layer test (temp DB only).
 *   rm -f /tmp/reg-db.db*
 *   sqlite3 data/acrogym.db ".backup '/tmp/reg-db.db'"   # consistent — captures WAL
 *   ACROGYM_DB_PATH=/tmp/reg-db.db node scripts/test-registrations-db.js
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

const { getDb, upsertRegistration, getRegistrations, getOptedInRecipients } = require('../shared/db');
getDb(); // open temp + migrate
// Self-isolating: clear registrations in the temp copy so absolute-count
// assertions don't depend on prod rows the .backup carried in.
getDb().exec('DELETE FROM registrations;');

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { console.log('  ✅ ' + n); pass++; } else { console.log('  ❌ ' + n); fail++; } };

const kids = (arr) => JSON.stringify({ declared_count: arr.length, children: arr, needs_review: false });
const mk = (over) => Object.assign({
  submitted_at: '1/1/2026 10:00:00', parent_first: 'P', parent_last: 'L', email: 'p@x.com',
  mobile_norm: '97450000001', whatsapp_norm: '97450000001',
  children_json: kids([{ first_name: 'K', last_name: '', dob: '1/1/2019' }]), children_count: 1,
  whatsapp_optin: 1, optin_at: '1/1/2026 10:00:00', optin_version: 'wa_v1',
  photo_consent: 0, tc_accepted: 1, qid: null, start_when: null, client_type: 'new',
  raw_row_hash: 'h-default', needs_review: 0,
}, over);

console.log('=== upsert (DO NOTHING) ===');
let r = upsertRegistration(mk({ raw_row_hash: 'hA' }));
t('insert new hash → inserted', r.action === 'inserted');
r = upsertRegistration(mk({ raw_row_hash: 'hA', parent_first: 'CHANGED-IGNORED' }));
t('same hash again → skipped (DO NOTHING)', r.action === 'skipped');
t('no duplicate row for hA', getRegistrations().filter(x => x.raw_row_hash === 'hA').length === 1);
r = upsertRegistration(mk({ raw_row_hash: 'hB' }));
t('different hash → inserted (2nd row)', r.action === 'inserted' && getRegistrations().length === 2);

console.log('=== getOptedInRecipients filters ===');
// needs_review excluded
upsertRegistration(mk({ raw_row_hash: 'hReview', whatsapp_norm: '97455500099', needs_review: 1 }));
t('needs_review=1 excluded from audience', !getOptedInRecipients({ kind: 'all' }).some(x => x.whatsapp_norm === '97455500099'));
// optin=0 excluded
upsertRegistration(mk({ raw_row_hash: 'hNoOpt', whatsapp_norm: '97455500088', whatsapp_optin: 0 }));
t('whatsapp_optin=0 excluded from audience', !getOptedInRecipients({ kind: 'all' }).some(x => x.whatsapp_norm === '97455500088'));

console.log('=== dedup by phone (latest submitted_at wins) ===');
upsertRegistration(mk({ raw_row_hash: 'hDupOld', whatsapp_norm: '97455511111', submitted_at: '1/10/2026 09:00:00', parent_first: 'Old' }));
upsertRegistration(mk({ raw_row_hash: 'hDupNew', whatsapp_norm: '97455511111', submitted_at: '3/15/2026 09:00:00', parent_first: 'New' }));
const dup = getOptedInRecipients({ kind: 'all' }).filter(x => x.whatsapp_norm === '97455511111');
t('two rows same phone → ONE recipient', dup.length === 1);
t('kept the latest submission', dup[0] && dup[0].parent_first === 'New');

console.log('=== age segment (any child in band) ===');
// child born 2014 (~12 → 10-14) AND 2021 (~5 → 3-5)
upsertRegistration(mk({ raw_row_hash: 'hAge', whatsapp_norm: '97455522222',
  children_json: kids([{ first_name: 'Teen', last_name: '', dob: '1/1/2014' }, { first_name: 'Tot', last_name: '', dob: '1/1/2021' }]), children_count: 2 }));
const in35 = getOptedInRecipients({ kind: 'age', min: 3, max: 5 }).some(x => x.whatsapp_norm === '97455522222');
const in1014 = getOptedInRecipients({ kind: 'age', min: 10, max: 14 }).some(x => x.whatsapp_norm === '97455522222');
const in69 = getOptedInRecipients({ kind: 'age', min: 6, max: 9 }).some(x => x.whatsapp_norm === '97455522222');
t('reg with kids in 3-5 AND 10-14 → in band 3-5', in35);
t('reg with kids in 3-5 AND 10-14 → in band 10-14', in1014);
t('same reg → NOT in band 6-9 (no child there)', !in69);

console.log('=== client_type segment ===');
upsertRegistration(mk({ raw_row_hash: 'hNew', whatsapp_norm: '97455533333', client_type: 'new' }));
upsertRegistration(mk({ raw_row_hash: 'hExist', whatsapp_norm: '97455544444', client_type: 'existing' }));
const news = getOptedInRecipients({ kind: 'client_type', value: 'new' });
const exists = getOptedInRecipients({ kind: 'client_type', value: 'existing' });
t('client_type=new returns new, not existing', news.some(x => x.whatsapp_norm === '97455533333') && !news.some(x => x.whatsapp_norm === '97455544444'));
t('client_type=existing returns existing, not new', exists.some(x => x.whatsapp_norm === '97455544444') && !exists.some(x => x.whatsapp_norm === '97455533333'));

console.log(`\n═══ Results: ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);

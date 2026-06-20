'use strict';

/**
 * B2 — broadcast audience resolver test (temp DB only).
 *
 * Self-isolating: seeds its OWN opted-in registrations and asserts deltas, so it
 * does not depend on the copy's state (the lesson from the registration tests).
 * Also asserts the prod-copy property: segment 'all' is EMPTY (all 8 optin=0).
 *
 *   rm -f /tmp/b2.db*
 *   sqlite3 data/acrogym.db ".backup '/tmp/b2.db'"   # consistent — captures WAL
 *   ACROGYM_DB_PATH=/tmp/b2.db node scripts/test-broadcast-resolver.js
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

const { getDb, upsertRegistration } = require('../shared/db');
const { resolveAudience, maskPhone } = require('../shared/broadcast/resolver');

const db = getDb();
let pass = 0, fail = 0;
const t = (n, c) => { if (c) { console.log('  ✅ ' + n); pass++; } else { console.log('  ❌ ' + n); fail++; } };

const kids = (arr) => JSON.stringify({ declared_count: arr.length, children: arr, needs_review: false });
const mk = (over) => Object.assign({
  submitted_at: '1/1/2026 10:00:00', parent_first: 'P', parent_last: 'Hidden', email: 'p@x.com',
  mobile_norm: '97450000001', whatsapp_norm: '97450000001',
  children_json: kids([{ first_name: 'K', last_name: '', dob: '1/1/2019' }]), children_count: 1,
  whatsapp_optin: 1, optin_at: '1/1/2026 10:00:00', optin_version: 'wa_v1',
  photo_consent: 0, tc_accepted: 1, qid: null, start_when: null, client_type: 'new',
  raw_row_hash: 'h', needs_review: 0,
}, over);

console.log('=== prod-copy property: segment all → EMPTY (all 8 optin=0) ===');
const allProd = resolveAudience({ kind: 'all' });
console.log('  total on prod copy:', allProd.total);
t('audience empty by design (no opted-in registrations yet)', allProd.total === 0);

console.log('\n=== seed synthetic opted-in registrations (self-isolating) ===');
// A: new, child 2014 (~12 → band 10-14). Two submissions same phone → dedup.
upsertRegistration(mk({ raw_row_hash: 'A-old', whatsapp_norm: '97455511111', client_type: 'new',
  submitted_at: '1/10/2026 09:00:00', parent_first: 'Aold',
  children_json: kids([{ first_name: 'Teen', last_name: '', dob: '1/1/2014' }]) }));
upsertRegistration(mk({ raw_row_hash: 'A-new', whatsapp_norm: '97455511111', client_type: 'new',
  submitted_at: '3/15/2026 09:00:00', parent_first: 'Anew',
  children_json: kids([{ first_name: 'Teen', last_name: '', dob: '1/1/2014' }]) }));
// B: existing, two children 2014 (~12) AND 2021 (~5) → bands 10-14 AND 3-5.
upsertRegistration(mk({ raw_row_hash: 'B', whatsapp_norm: '97455522222', client_type: 'existing', parent_first: 'Bea',
  children_json: kids([{ first_name: 'Teen', last_name: '', dob: '1/1/2014' }, { first_name: 'Tot', last_name: '', dob: '1/1/2021' }]) }));
// C: opted OUT → excluded. D: needs_review → excluded.
upsertRegistration(mk({ raw_row_hash: 'C', whatsapp_norm: '97455533333', whatsapp_optin: 0, parent_first: 'Cyril' }));
upsertRegistration(mk({ raw_row_hash: 'D', whatsapp_norm: '97455544444', needs_review: 1, parent_first: 'Dana' }));

const regCountAfterSeed = db.prepare('SELECT count(*) c FROM registrations').get().c;

console.log('\n=== all: opted-in only, deduped, excludes optout/review ===');
const all = resolveAudience({ kind: 'all' });
const phones = all.recipients.map(r => r.recipient_phone);
t('A present (opted-in)', phones.includes('97455511111'));
t('B present (opted-in)', phones.includes('97455522222'));
t('C excluded (optin=0)', !phones.includes('97455533333'));
t('D excluded (needs_review=1)', !phones.includes('97455544444'));
t('A deduped → exactly one row for the phone', phones.filter(p => p === '97455511111').length === 1);
const a = all.recipients.find(r => r.recipient_phone === '97455511111');
t('dedup kept the LATEST submission (Anew)', a && a.display_name === 'Anew');

console.log('\n=== client_type segment ===');
const news = resolveAudience({ kind: 'client_type', value: 'new' }).recipients.map(r => r.recipient_phone);
const exis = resolveAudience({ kind: 'client_type', value: 'existing' }).recipients.map(r => r.recipient_phone);
t('client_type=new → A, not B', news.includes('97455511111') && !news.includes('97455522222'));
t('client_type=existing → B, not A', exis.includes('97455522222') && !exis.includes('97455511111'));

console.log('\n=== age segment (any child in band) ===');
const in1014 = resolveAudience({ kind: 'age', min: 10, max: 14 }).recipients.map(r => r.recipient_phone);
const in35   = resolveAudience({ kind: 'age', min: 3,  max: 5  }).recipients.map(r => r.recipient_phone);
const in69   = resolveAudience({ kind: 'age', min: 6,  max: 9  }).recipients.map(r => r.recipient_phone);
t('age 10-14 → A and B (both have a 2014 child)', in1014.includes('97455511111') && in1014.includes('97455522222'));
t('age 3-5 → B only (only B has a 2021 child)', in35.includes('97455522222') && !in35.includes('97455511111'));
t('age 6-9 → nobody', in69.length === 0);

console.log('\n=== recipient shape: full phone for dispatch, masked for preview ===');
const b = all.recipients.find(r => r.recipient_phone === '97455522222');
t('recipient_phone = whatsapp_norm (full, for dispatch)', b && b.recipient_phone === '97455522222');
t('display_name = parent_first only (no last name)', b && b.display_name === 'Bea');
t('phone_masked = 974•••••22 (country + last 2)', b && b.phone_masked === '974•••••22');
t('masked carries NO full middle digits (no leak in preview)', b && !b.phone_masked.includes('55522'));
t('maskPhone unit: 97455511111 → 974•••••11', maskPhone('97455511111') === '974•••••11');

console.log('\n=== read-only: resolver wrote nothing ===');
const regCountAfterResolve = db.prepare('SELECT count(*) c FROM registrations').get().c;
t('registrations count unchanged by resolveAudience calls', regCountAfterResolve === regCountAfterSeed);

console.log(`\n═══ Results: ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);

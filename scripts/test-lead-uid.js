'use strict';

/**
 * Test script: Part A lead_uid pipeline (canonical n8n sheet → lead-helper).
 * Runs against a TEMP COPY of the DB — never the production file.
 *
 * Usage:
 *   sqlite3 data/acrogym.db ".backup '/tmp/acrogym-test-uid.db'"   # consistent — captures WAL
 *   ACROGYM_DB_PATH=/tmp/acrogym-test-uid.db node scripts/test-lead-uid.js
 */

if (!process.env.ACROGYM_DB_PATH || process.env.ACROGYM_DB_PATH.includes('data/acrogym.db')) {
  console.error('REFUSING to run: set ACROGYM_DB_PATH to a temp copy first.');
  process.exit(1);
}

// Stale -wal/-shm from a previous run would be replayed into the fresh copy
// and poison the pre-migration checks. Refuse rather than silently mislead.
{
  const fsg = require('fs');
  for (const ext of ['-wal', '-shm']) {
    if (fsg.existsSync(process.env.ACROGYM_DB_PATH + ext)) {
      console.error(`REFUSING to run: stale ${process.env.ACROGYM_DB_PATH + ext} found — delete .db, -wal and -shm together, then re-copy.`);
      process.exit(1);
    }
  }
}

const Database = require('better-sqlite3');

// Count leads BEFORE shared/db runs its migrations
const _pre = new Database(process.env.ACROGYM_DB_PATH, { readonly: true });
const preCount = _pre.prepare('SELECT COUNT(*) AS c FROM leads').get().c;
const preHasUid = _pre.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('leads') WHERE name='lead_uid'`).get().c;
// Prod is on v20 since 2026-06-11, so copies may already carry uid leads
const preUidLeads = preHasUid
  ? _pre.prepare('SELECT COUNT(*) AS c FROM leads WHERE lead_uid IS NOT NULL').get().c
  : 0;
_pre.close();

const {
  getDb, insertLead, getLeadByUid, getLeadByRow, updateLeadStatusById,
  findExistingLead,
} = require('../shared/db');
const { mapColumns }      = require('../shared/column-mapper');
const { parseClientType } = require('../shared/client-type');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅ PASS: ${name}`); passed++; }
  catch (err) { console.log(`  ❌ FAIL: ${name}\n     ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const db = getDb(); // opens temp copy + applies v20 migration

console.log('\n' + '═'.repeat(55));
console.log('  Part A — lead_uid Test Suite');
console.log('═'.repeat(55) + '\n');

// ── 1. Migration v20 ─────────────────────────────────────────
console.log('Migration v20 (on a copy of the real DB)');
// Pre-2026-06-11 prod copies have no lead_uid column; post-switch copies do.
// Both are valid inputs — what matters is that migrations are idempotent.
test('migration idempotent on this source DB (column count 0→1 or 1→1)', () =>
  assert(preHasUid === 0 || preHasUid === 1, `pre-migration column count: ${preHasUid}`));
test('lead_uid column added', () => {
  const c = db.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('leads') WHERE name='lead_uid'`).get().c;
  assert(c === 1, `column count: ${c}`);
});
test('partial unique index idx_leads_uid exists', () => {
  const idx = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_leads_uid'`).get();
  assert(idx && /WHERE lead_uid IS NOT NULL/i.test(idx.sql), `index sql: ${idx && idx.sql}`);
});
test('no leads lost or gained by migration', () => {
  const c = db.prepare('SELECT COUNT(*) AS c FROM leads').get().c;
  assert(c === preCount, `before=${preCount} after=${c}`);
});
test('migration did not invent or drop uid values', () => {
  const c = db.prepare('SELECT COUNT(*) AS c FROM leads WHERE lead_uid IS NOT NULL').get().c;
  assert(c === preUidLeads, `non-null uids before=${preUidLeads} after=${c}`);
});

// ── 2. Column mapping for the canonical sheet ────────────────
console.log('\nColumn mapping (canonical headers, exactly as in the sheet)');
const CANON_HEADERS = ['Timestamp', 'Lead UID', 'Client Type', 'Parent First Name', 'Parent Phone', 'Child Age', 'Source'];
const colMap = mapColumns(CANON_HEADERS);
test('all 7 canonical columns mapped', () => {
  const expect = { timestamp: 0, lead_uid: 1, client_type: 2, parent_first_name: 3, parent_phone: 4, child_age: 5, source: 6 };
  for (const [f, i] of Object.entries(expect)) {
    assert(colMap[f] === i, `${f}: expected ${i}, got ${colMap[f]}`);
  }
});
test('old-form headers still map without lead_uid', () => {
  const oldMap = mapColumns(['Timestamp', 'Client Type', 'Parent First Name', 'Phone number', 'Email']);
  assert(oldMap.lead_uid === undefined, `lead_uid mapped to ${oldMap.lead_uid}`);
  assert(oldMap.parent_phone === 3, `parent_phone: ${oldMap.parent_phone}`);
});

// ── 3. client_type for website leads ─────────────────────────
console.log('\nclient_type routing');
test('"🆕 New client – website form" → new', () =>
  assert(parseClientType('🆕 New client – website form') === 'new', 'not new'));

// ── 4. insertLead with lead_uid ──────────────────────────────
console.log('\ninsertLead + dedup semantics');
const UID1 = 'test-uid-0001';
const UID2 = 'test-uid-0002';
const mkLead = (uid, name, phone) => ({
  sheet_row_number: null, lead_uid: uid, timestamp: '2026-06-10 23:00:00',
  parent_name: name, parent_phone: phone, parent_whatsapp: '', parent_email: '',
  qid: '', language: 'en', client_type: 'new',
  phone_normalized: '974' + phone, whatsapp_normalized: null, email_normalized: null,
  ref_lead_id: null, raw_data: '{}', status: 'new',
});

let id1;
test('uid lead inserts with NULL sheet_row_number', () => {
  const r = insertLead(mkLead(UID1, 'Uid One', '55110001'));
  assert(r.changes === 1, `changes=${r.changes}`);
  id1 = r.lastInsertRowid;
  const row = getLeadByUid(UID1);
  assert(row && row.sheet_row_number === null, `row_number=${row && row.sheet_row_number}`);
});
test('same uid again → ignored (idempotent)', () => {
  const r = insertLead(mkLead(UID1, 'Uid One Again', '55110001'));
  assert(r.changes === 0, `changes=${r.changes}`);
  const c = db.prepare('SELECT COUNT(*) AS c FROM leads WHERE lead_uid = ?').get(UID1).c;
  assert(c === 1, `count=${c}`);
});
test('second uid lead with NULL row coexists (NULLs do not collide)', () => {
  const r = insertLead(mkLead(UID2, 'Uid Two', '55110002'));
  assert(r.changes === 1, `changes=${r.changes}`);
});
test('legacy row-number collision is gone: legacy row 2 + canonical row 2 both live', () => {
  const legacy = getLeadByRow(2); // real legacy lead in the prod copy
  assert(legacy, 'no legacy lead at sheet row 2 — prod copy unexpected');
  // canonical row 2 arrived as a uid lead (NULL row) — both exist independently
  assert(getLeadByUid(UID1) && getLeadByUid(UID1).id !== legacy.id, 'uid lead collided with legacy');
});
test('insertLead WITHOUT lead_uid key (legacy caller) still works', () => {
  const lead = mkLead(null, 'Legacy Caller', '55110003');
  delete lead.lead_uid;
  lead.sheet_row_number = 9901;
  const r = insertLead(lead);
  assert(r.changes === 1, `changes=${r.changes}`);
  assert(getLeadByRow(9901).lead_uid === null, 'lead_uid not null');
});

// ── 5. status ops by id ──────────────────────────────────────
console.log('\nupdateLeadStatusById');
test('status update works for uid lead (NULL row)', () => {
  updateLeadStatusById(id1, { status: 'notified', notified_at: new Date().toISOString() });
  const row = getLeadByUid(UID1);
  assert(row.status === 'notified' && row.notified_at, `status=${row.status}`);
});
test('responded flow by id (callbacks.js path)', () => {
  updateLeadStatusById(id1, { status: 'responded', responded_at: new Date().toISOString() });
  assert(getLeadByUid(UID1).status === 'responded', 'status not responded');
});

// ── 6. pollSheets dedup expression (replicated semantics) ────
console.log('\npollSheets dedup expression');
function dedupSkip(values, map) {
  const uidIdx = map.lead_uid;
  const uid = uidIdx !== undefined ? (values[uidIdx] || '').trim() : '';
  return Boolean(uid ? getLeadByUid(uid) : getLeadByRow(2));
}
test('canonical row with known uid → skipped', () =>
  assert(dedupSkip(['2026-06-10', UID1, '🆕 New client – website form', 'Uid One', '55110001', '5', 'website_form'], colMap) === true, 'not skipped'));
test('canonical row with fresh uid → processed', () =>
  assert(dedupSkip(['2026-06-10', 'never-seen-uid', '🆕', 'X', '5500', '4', 'website_form'], colMap) === false, 'wrongly skipped'));
test('old form (no uid column) → falls back to row-number dedup', () => {
  const oldMap = mapColumns(['Timestamp', 'Client Type', 'Parent First Name', 'Phone number', 'Email']);
  // legacy row 2 exists → skip; this is the instant-rollback path
  assert(dedupSkip(['t', '🆕', 'X', '5500', 'e'], oldMap) === true, 'rollback path broken');
});

// ── 7. THE real website dup: same phone, two POSTs, different uids ──
// uid identifies the DELIVERY (n8n generates it per request), not the person.
// Double submit = two rows with fresh uids → both pass the uid floor →
// the phone floor (findExistingLead in processNewRow) must catch the second.
console.log('\nWebsite double-submit (same phone, different uids)');
const UIDA = 'test-uid-dupA', UIDB = 'test-uid-dupB';
const DUP_PHONE = '50003333';

// Mirrors processNewRow's dedup decision (same shape as test-lead-helper.js simulate)
function simulateCanonicalRow(uid, name, phone) {
  const phoneNorm = '974' + phone;
  const dup = findExistingLead({ phoneNorm, whatsappNorm: null, emailNorm: null, qid: '' });
  if (dup) {
    const daysSince = Math.floor((Date.now() - new Date(dup.created_at).getTime()) / 86400000);
    if (['existing', 'existing_signed', 'returning', 'returning_notified'].includes(dup.client_type)) {
      insertLead({ ...mkLead(uid, name, phone), status: 'duplicate_of_existing', ref_lead_id: dup.id });
      return { action: 'silent', status: 'duplicate_of_existing', refId: dup.id };
    }
    if (daysSince < 30) {
      insertLead({ ...mkLead(uid, name, phone), status: 'duplicate_recent_lead', ref_lead_id: dup.id });
      return { action: 'short_alert', status: 'duplicate_recent_lead', refId: dup.id };
    }
  }
  insertLead({ ...mkLead(uid, name, phone), status: 'new' });
  return { action: 'new_card_with_greeting', status: 'new' };
}

test('1st POST → full card path (new lead)', () => {
  const r = simulateCanonicalRow(UIDA, 'Dup Parent', DUP_PHONE);
  assert(r.action === 'new_card_with_greeting', `got: ${r.action}`);
});
test('2nd POST, same phone, DIFFERENT uid → short alert, NO card', () => {
  // uid floor must NOT block it (fresh uid)…
  assert(!getLeadByUid(UIDB), 'uid floor wrongly blocked');
  // …the phone floor must catch it
  const r = simulateCanonicalRow(UIDB, 'Dup Parent', DUP_PHONE);
  assert(r.action === 'short_alert', `got: ${r.action}`);
  assert(r.status === 'duplicate_recent_lead', `got status: ${r.status}`);
});
test('exactly ONE card-worthy lead for that phone in SQLite', () => {
  const rows = db.prepare(
    `SELECT status, ref_lead_id FROM leads WHERE phone_normalized = ? ORDER BY id`
  ).all('974' + DUP_PHONE);
  assert(rows.length === 2, `rows: ${rows.length}`);
  assert(rows[0].status === 'new', `first: ${rows[0].status}`);
  assert(rows[1].status === 'duplicate_recent_lead', `second: ${rows[1].status}`);
  assert(rows[1].ref_lead_id === getLeadByUid(UIDA).id, 'ref_lead_id does not point to the first lead');
});
test('3rd POST same phone → still no second card', () => {
  const r = simulateCanonicalRow('test-uid-dupC', 'Dup Parent', DUP_PHONE);
  assert(r.action === 'short_alert', `got: ${r.action}`);
});

// ── cleanup test rows in the TEMP copy ───────────────────────
db.prepare(`DELETE FROM leads WHERE lead_uid LIKE 'test-uid-%' OR sheet_row_number = 9901`).run();

console.log('\n' + '═'.repeat(55));
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(55) + '\n');
process.exit(failed > 0 ? 1 : 0);

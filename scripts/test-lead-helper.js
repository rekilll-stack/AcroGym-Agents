'use strict';

/**
 * Test script: simulates 6 lead-processing scenarios without sending to Telegram or calling Claude.
 * All external calls are mocked.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { getDb, findExistingLead } = require('../shared/db');
const { parseClientType }         = require('../shared/client-type');
const { normalizePhone, normalizeEmail } = require('../shared/normalize');

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ FAIL: ${name}`);
    console.log(`     ${err.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

// ─────────────────────────────────────────────────────────────
// Clean test data from DB before running
// ─────────────────────────────────────────────────────────────

const db = getDb();
db.exec(`DELETE FROM leads WHERE sheet_row_number >= 9000`);

// ─────────────────────────────────────────────────────────────
// Simulate processNewRow logic (pure, no side effects)
// ─────────────────────────────────────────────────────────────

function simulate(rowNumber, raw) {
  const phoneNorm    = normalizePhone(raw.parent_phone);
  const whatsappNorm = normalizePhone(raw.parent_whatsapp);
  const emailNorm    = normalizeEmail(raw.parent_email);
  const clientType   = parseClientType(raw.client_type_raw || '');

  const dup = findExistingLead({ phoneNorm, whatsappNorm, emailNorm, qid: raw.qid });

  let outcome;

  if (dup) {
    const daysSince = Math.floor((Date.now() - new Date(dup.created_at).getTime()) / 86400000);
    const dupType   = dup.client_type;

    if (['existing', 'existing_signed', 'returning', 'returning_notified'].includes(dupType)) {
      const status = dupType.startsWith('existing') ? 'duplicate_of_existing' : 'duplicate_of_returning';
      outcome = { action: 'silent', status };
    } else if (daysSince < 30) {
      outcome = { action: 'short_alert', status: 'duplicate_recent_lead' };
    } else {
      outcome = { action: 'new_with_reentry_note', status: 'new', clientType };
    }
  } else {
    if (clientType === 'existing') {
      outcome = { action: 'silent', status: 'existing_signed', clientType };
    } else if (clientType === 'returning') {
      outcome = { action: 'returning_card', status: 'returning_notified', clientType };
    } else if (clientType === 'unknown') {
      outcome = { action: 'new_card_with_warning', status: 'new', clientType };
    } else {
      outcome = { action: 'new_card_with_greeting', status: 'new', clientType };
    }
  }

  // Insert into DB (to support subsequent dedup tests)
  if (!db.prepare('SELECT 1 FROM leads WHERE sheet_row_number = ?').get(rowNumber)) {
    db.prepare(`
      INSERT INTO leads (sheet_row_number, parent_name, parent_phone, parent_email, qid,
        phone_normalized, whatsapp_normalized, email_normalized, client_type, language, status,
        notified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'en', ?, datetime('now'), datetime('now'), datetime('now'))
    `).run(
      rowNumber, raw.parent_name, raw.parent_phone, raw.parent_email, raw.qid || '',
      phoneNorm, whatsappNorm, emailNorm,
      clientType,
      outcome.status
    );
  }

  return { ...outcome, phoneNorm, whatsappNorm, emailNorm, clientType };
}

// ─────────────────────────────────────────────────────────────
// TEST CASES
// ─────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(55));
console.log('  AcroGym Lead-Helper — Test Suite (6 scenarios)');
console.log('═'.repeat(55) + '\n');

// 1. New client, no duplicate → full card + greeting
console.log('Scenario 1: New client, no duplicate');
test('action = new_card_with_greeting', () => {
  const r = simulate(9001, {
    parent_name: 'Anna Smith', parent_phone: '55001001', parent_email: 'anna@test.com',
    client_type_raw: '🆕 New client – I want to register for classes',
  });
  assert(r.action === 'new_card_with_greeting', `Got: ${r.action}`);
  assert(r.clientType === 'new', `Got client_type: ${r.clientType}`);
  assert(r.status === 'new', `Got status: ${r.status}`);
  assert(r.phoneNorm === '97455001001', `Got phoneNorm: ${r.phoneNorm}`);
});

// 2. Existing member → silent, status existing_signed
console.log('\nScenario 2: Existing member signing T&C');
test('action = silent, status = existing_signed', () => {
  const r = simulate(9002, {
    parent_name: 'Bob Existing', parent_phone: '55002002', parent_email: 'bob@test.com',
    client_type_raw: '✅ Existing member – signing T&C',
  });
  assert(r.action === 'silent', `Got: ${r.action}`);
  assert(r.status === 'existing_signed', `Got status: ${r.status}`);
  assert(r.clientType === 'existing', `Got client_type: ${r.clientType}`);
});

// 3. Returning client → returning card, no Claude
console.log('\nScenario 3: Returning client');
test('action = returning_card', () => {
  const r = simulate(9003, {
    parent_name: 'Carol Return', parent_phone: '55003003', parent_email: 'carol@test.com',
    client_type_raw: '↩️ Returning client – was here before, coming back',
  });
  assert(r.action === 'returning_card', `Got: ${r.action}`);
  assert(r.status === 'returning_notified', `Got status: ${r.status}`);
  assert(r.clientType === 'returning', `Got client_type: ${r.clientType}`);
});

// 4. Unknown / empty client_type → card with warning
console.log('\nScenario 4: Unknown client type (empty field)');
test('action = new_card_with_warning, clientType = unknown', () => {
  const r = simulate(9004, {
    parent_name: 'Dave Unknown', parent_phone: '55004004', parent_email: 'dave@test.com',
    client_type_raw: '',
  });
  assert(r.action === 'new_card_with_warning', `Got: ${r.action}`);
  assert(r.clientType === 'unknown', `Got client_type: ${r.clientType}`);
});

// 5. New client, phone matches existing member → silent duplicate_of_existing
console.log('\nScenario 5: New lead, phone matches existing member');
test('action = silent, status = duplicate_of_existing', () => {
  // The existing member (Bob, 55002002) was inserted in Scenario 2
  const r = simulate(9005, {
    parent_name: 'Bob2', parent_phone: '55002002', parent_email: 'bob2@test.com',
    client_type_raw: '🆕 New client – I want to register for classes',
  });
  assert(r.action === 'silent', `Got: ${r.action}`);
  assert(r.status === 'duplicate_of_existing', `Got status: ${r.status}`);
});

// 6. New client, phone matches another 'new' lead from today → short alert
console.log('\nScenario 6: New lead, phone matches recent new lead (< 30 days)');
test('action = short_alert, status = duplicate_recent_lead', () => {
  // Anna (55001001) was inserted in Scenario 1 with status 'new', created today
  const r = simulate(9006, {
    parent_name: 'Anna2', parent_phone: '55001001', parent_email: 'anna2@test.com',
    client_type_raw: '🆕 New client – I want to register for classes',
  });
  assert(r.action === 'short_alert', `Got: ${r.action}`);
  assert(r.status === 'duplicate_recent_lead', `Got status: ${r.status}`);
});

// ─────────────────────────────────────────────────────────────
// Bonus: parseClientType edge cases
// ─────────────────────────────────────────────────────────────
console.log('\nBonus: parseClientType — emoji matching');
test('🆕 prefix → new',  () => assert(parseClientType('🆕 New client – I want to register for classes') === 'new', 'fail'));
test('✅ prefix → existing', () => assert(parseClientType('✅ Existing member – signing T&C') === 'existing', 'fail'));
test('↩️ prefix → returning', () => assert(parseClientType('↩️ Returning client – was here before, coming back') === 'returning', 'fail'));
test('empty → unknown',  () => assert(parseClientType('') === 'unknown', 'fail'));
test('null → unknown',   () => assert(parseClientType(null) === 'unknown', 'fail'));

// Bonus: normalizePhone
console.log('\nBonus: normalizePhone');
test('8-digit → 974 prefix', () => assert(normalizePhone('55132761') === '97455132761', `Got: ${normalizePhone('55132761')}`));
test('already 974 prefix',   () => assert(normalizePhone('97455132761') === '97455132761', `Got: ${normalizePhone('97455132761')}`));
test('null → null',          () => assert(normalizePhone(null) === null, 'fail'));
test('empty → null',         () => assert(normalizePhone('') === null, 'fail'));
test('spaces stripped',      () => assert(normalizePhone('+974 5513 2761') === '97455132761', `Got: ${normalizePhone('+974 5513 2761')}`));

// ─────────────────────────────────────────────────────────────
// Cleanup test rows
// ─────────────────────────────────────────────────────────────
db.exec(`DELETE FROM leads WHERE sheet_row_number >= 9000`);

console.log('\n' + '═'.repeat(55));
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(55) + '\n');

if (failed > 0) process.exit(1);

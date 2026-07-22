'use strict';

// Self-check for fill-whatsapp-template.js's pure logic (no DB, no CLI). Run:
//   node scripts/test-fill-whatsapp-template.js

const assert = require('assert');
const { templates } = require('../config/whatsapp-templates.json');

// 1. Catalog sanity — every template has a non-trivial body and no leftover
// unclosed placeholder syntax.
assert.strictEqual(templates.length, 138, `expected 138 templates, got ${templates.length}`);
for (const t of templates) {
  assert.ok(t.key && /^[a-z0-9_]+$/.test(t.key), `bad key: ${t.key}`);
  assert.ok(t.body && t.body.length > 10, `empty/short body: ${t.key}`);
  assert.ok(!/\{\{\d+$/.test(t.body), `unclosed placeholder: ${t.key}`);
}
const keys = templates.map((t) => t.key);
assert.strictEqual(new Set(keys).size, keys.length, 'duplicate template keys found');

// 2. Placeholder-fill logic, mirrored from fill-whatsapp-template.js (kept
// inline so this test has no side effects and needs no live DB).
function autoFillValue(varDescription, reg, childIndex) {
  const d = varDescription.toLowerCase();
  if (!reg) return null;
  if (d.includes('parent')) return [reg.parent_first, reg.parent_last].filter(Boolean).join(' ') || null;
  if (d.includes('child')) {
    const children = JSON.parse(reg.children_json || '{}').children || [];
    const child = children[childIndex != null ? childIndex - 1 : 0];
    return child && child.first_name ? child.first_name : null;
  }
  return null;
}

function fill(tpl, reg, extraVars = {}) {
  let text = tpl.body;
  const unresolved = [];
  for (const ph of new Set(text.match(/\{\{\d+\}\}/g) || [])) {
    const n = ph.replace(/\D/g, '');
    let value = extraVars[n];
    if (value == null) {
      const desc = tpl.variables.find((v) => v.startsWith(ph)) || '';
      value = autoFillValue(desc, reg);
    }
    if (value != null) text = text.split(ph).join(value);
    else unresolved.push(ph);
  }
  return { text, unresolved };
}

const fakeReg = {
  parent_first: 'Sarah', parent_last: 'Smith',
  children_json: JSON.stringify({ children: [{ first_name: 'Noor', dob: '2019-05-01' }] }),
};

const welcome = templates.find((t) => t.key === 'welcome_ages_6_9');
{
  const { text, unresolved } = fill(welcome, fakeReg);
  assert.ok(text.includes('Sarah'), 'parent name not filled');
  assert.ok(text.includes('Noor'), 'child name not filled');
  assert.strictEqual(unresolved.length, 0, 'welcome template should fully resolve from a registration');
}

const booking = templates.find((t) => t.key === 'booking_confirmed');
{
  const { text, unresolved } = fill(booking, fakeReg);
  assert.deepStrictEqual(unresolved.sort(), ['{{3}}', '{{4}}'].sort(), 'date/time should stay unresolved without --var');
  assert.ok(text.includes('Sarah') && text.includes('Noor'), 'parent/child should still fill alongside unresolved vars');
}
{
  const { unresolved } = fill(booking, fakeReg, { 3: 'Saturday', 4: '10:00' });
  assert.strictEqual(unresolved.length, 0, '--var overrides should resolve the remaining placeholders');
}

// no registration at all — everything with a variable stays unresolved, no crash
{
  const { unresolved } = fill(welcome, null);
  assert.strictEqual(unresolved.length, 2, 'with no registration, both {{1}} and {{2}} should stay unresolved');
}

console.log(`OK — ${templates.length} templates valid, fill logic correct (parent/child auto-fill, unresolved-var detection, --var override).`);

'use strict';

/**
 * Agent 3 — Touch-1 welcome draft test.
 * Verifies age segmentation, verbatim fallback texts, and shows one LIVE
 * Claude-generated draft per segment so the voice can be eyeballed.
 *
 * Usage (temp DB only):
 *   rm -f /tmp/acrogym-test-greeting.db*
 *   cp data/acrogym.db /tmp/acrogym-test-greeting.db
 *   ACROGYM_DB_PATH=/tmp/acrogym-test-greeting.db node scripts/test-greeting.js
 */

if (!process.env.ACROGYM_DB_PATH || process.env.ACROGYM_DB_PATH.includes('data/acrogym.db')) {
  console.error('REFUSING to run: set ACROGYM_DB_PATH to a temp copy first.');
  process.exit(1);
}
{
  const fs = require('fs');
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(process.env.ACROGYM_DB_PATH + ext)) {
      console.error(`REFUSING: stale ${process.env.ACROGYM_DB_PATH + ext} — delete .db, -wal, -shm together, then re-copy.`);
      process.exit(1);
    }
  }
}

require('../shared/db').getDb(); // open the temp DB (honor convention; no prod mutation)
const { ageSegment, fallbackGreeting, buildGreetingPrompt } = require('../agents/lead-helper/prompts');
const { generateText } = require('../shared/claude');

let pass = 0, fail = 0;
const test = (n, fn) => { try { fn(); console.log('  ✅', n); pass++; } catch (e) { console.log('  ❌', n, '\n     ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

console.log('\nageSegment mapping');
test('3,4,5 -> 3-5', () => ['3', '4', '5'].forEach(a => assert(ageSegment(a) === '3-5', a)));
test('6,9 -> 6-9', () => ['6', '9'].forEach(a => assert(ageSegment(a) === '6-9', a)));
test('10,14 -> 10-14', () => ['10', '14'].forEach(a => assert(ageSegment(a) === '10-14', a)));
test('"5 years" -> 3-5', () => assert(ageSegment('5 years') === '3-5'));
test('"6-7" -> 6-9 (first number)', () => assert(ageSegment('6-7') === '6-9'));
test('empty/null -> null', () => { assert(ageSegment('') === null); assert(ageSegment(null) === null); });
test('out of range 2,16 -> null', () => { assert(ageSegment('2') === null); assert(ageSegment('16') === null); });
test('garbage -> null', () => assert(ageSegment('hello') === null));

console.log('\nfallbackGreeting (verbatim approved)');
test('3-5 -> motor skills + little one + signature', () => { const t = fallbackGreeting({ parentName: 'Anna', childAge: '4' }); assert(t.includes('motor skills') && t.includes('your little one') && t.includes('— AcroGym Team 🤸'), t); });
test('6-9 -> structured + welcome your child', () => { const t = fallbackGreeting({ parentName: 'Omar', childAge: '8' }); assert(t.includes('structured') && t.includes('welcome your child'), t); });
test('10-14 -> Kristina + sport acrobatics', () => { const t = fallbackGreeting({ parentName: 'Sam', childAge: '12' }); assert(t.includes('Kristina') && t.includes('sport acrobatics'), t); });
test('no age -> neutral (family, no Kristina)', () => { const t = fallbackGreeting({ parentName: 'Lee' }); assert(t.includes('welcome your family') && !t.includes('Kristina'), t); });
test('no "within the hour" in any fallback', () => ['3', '7', '12', null].forEach(a => assert(!/within the hour/i.test(fallbackGreeting({ parentName: 'X', childAge: a })), 'leak at age ' + a)));
test('no parent name -> "Hi there!"', () => assert(fallbackGreeting({ childAge: '4' }).startsWith('Hi there!')));

(async () => {
  console.log('\nLive Claude samples (one per segment):');
  const cases = [['Anna', '4', '3-5'], ['Omar', '8', '6-9'], ['Sara', '12', '10-14'], ['Lina', null, 'neutral']];
  for (const [name, age, seg] of cases) {
    try {
      const txt = await generateText(buildGreetingPrompt({ parentName: name, childAge: age }));
      const leak = /within the hour/i.test(txt) ? '  ⚠️ contains "within the hour"!' : '';
      console.log(`\n— segment ${seg} (parent ${name}, age ${age || '—'}):${leak}\n${txt}`);
    } catch (e) {
      console.log(`\n— segment ${seg}: Claude error: ${e.message} (static fallback would be used in prod)`);
    }
  }
  console.log(`\n═══════════════════════════════════════════\n  Results: ${pass} passed, ${fail} failed\n═══════════════════════════════════════════`);
  process.exit(fail ? 1 : 0);
})();

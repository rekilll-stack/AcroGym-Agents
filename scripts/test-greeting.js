'use strict';

/**
 * Agent 3 — Touch-1 welcome draft test.
 * Verifies age segmentation, verbatim fallback texts, and shows one LIVE
 * Claude-generated draft per segment so the voice can be eyeballed.
 *
 * Usage (temp DB only):
 *   rm -f /tmp/acrogym-test-greeting.db*
 *   sqlite3 data/acrogym.db ".backup '/tmp/acrogym-test-greeting.db'"   # consistent — captures WAL
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

console.log('\nageSegment mapping (grid 25.07.2026: 2-3/3-4/4-5/6-8/10-14, boundary → older group)');
test('2 -> 2-3', () => assert(ageSegment('2') === '2-3'));
test('3 -> 3-4 (boundary → older)', () => assert(ageSegment('3') === '3-4'));
test('4,5 -> 4-5 (5 is NOT baby format)', () => ['4', '5'].forEach(a => assert(ageSegment(a) === '4-5', a)));
test('6,8,9 -> 6-8 (9 has no own group)', () => ['6', '8', '9'].forEach(a => assert(ageSegment(a) === '6-8', a)));
test('10,14 -> 10-14', () => ['10', '14'].forEach(a => assert(ageSegment(a) === '10-14', a)));
test('"5 years" -> 4-5', () => assert(ageSegment('5 years') === '4-5'));
test('"6-7" -> 6-8 (first number)', () => assert(ageSegment('6-7') === '6-8'));
test('empty/null -> null', () => { assert(ageSegment('') === null); assert(ageSegment(null) === null); });
test('out of range 1,16 -> null', () => { assert(ageSegment('1') === null); assert(ageSegment('16') === null); });
test('garbage -> null', () => assert(ageSegment('hello') === null));

console.log('\nfallbackGreeting (verbatim)');
test('2-3 -> toddler/little one + signature', () => { const t = fallbackGreeting({ parentName: 'Anna', childAge: '2' }); assert(t.includes('toddlers') && t.includes('your little one') && t.includes('— AcroGym Team 🤸'), t); });
test('3-4 -> playful but structured + little one', () => { const t = fallbackGreeting({ parentName: 'Dana', childAge: '3' }); assert(t.includes('playful but structured') && t.includes('your little one'), t); });
test('4-5 -> foundations + NO little one (coach fix 25.07)', () => { const t = fallbackGreeting({ parentName: 'Kholoud', childAge: '5' }); assert(t.includes('real gymnastics foundations') && !t.includes('little one') && t.includes('welcome your child'), t); });
test('6-8 -> structured + welcome your child', () => { const t = fallbackGreeting({ parentName: 'Omar', childAge: '8' }); assert(t.includes('structured') && t.includes('welcome your child'), t); });
test('10-14 -> Kristina + sport acrobatics', () => { const t = fallbackGreeting({ parentName: 'Sam', childAge: '12' }); assert(t.includes('Kristina') && t.includes('sport acrobatics'), t); });
test('no age -> neutral (family, no Kristina)', () => { const t = fallbackGreeting({ parentName: 'Lee' }); assert(t.includes('welcome your family') && !t.includes('Kristina'), t); });
test('no "within the hour" in any fallback', () => ['2', '3', '5', '7', '12', null].forEach(a => assert(!/within the hour/i.test(fallbackGreeting({ parentName: 'X', childAge: a })), 'leak at age ' + a)));
test('no parent name -> "Hi there!"', () => assert(fallbackGreeting({ childAge: '4' }).startsWith('Hi there!')));

(async () => {
  console.log('\nLive Claude samples (one per segment):');
  const cases = [['Anna', '2', '2-3'], ['Dana', '3', '3-4'], ['Kholoud', '5', '4-5'], ['Omar', '8', '6-8'], ['Sara', '12', '10-14'], ['Lina', null, 'neutral']];
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

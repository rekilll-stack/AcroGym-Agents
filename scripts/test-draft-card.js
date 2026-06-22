'use strict';

/**
 * A.4 — admin draft card touch marker. The "касание N (kind)" marker must appear
 * in the card FRAMING (so the admin sees which touch they're sending) but NEVER
 * inside the copyable client text. No DB / no Telegram — pure card builder.
 *
 *   node scripts/test-draft-card.js
 */

const { buildDraftCard } = require('../shared/client-messaging');

let pass = 0, fail = 0;
const T = (n, c) => { console.log((c ? '  ✅ ' : '  ❌ ') + n); c ? pass++ : fail++; };

const lead = { parent_name: 'Sara', parent_whatsapp: '+97455511111', language: 'EN' };
const CLIENT = "Hi Sara! Following up after you reached out about AcroGym. Reply whenever it's convenient. 🤸";

console.log('=== nurture drip: marker in framing, NOT in client text ===');
for (const [touch, kind] of [[2, 'follow-up'], [3, 'pre-launch']]) {
  const card = buildDraftCard({ lead, messageText: CLIENT, messageType: 'nurture', touch });
  T(`touch ${touch}: header shows "Прогрев — касание ${touch} (${kind})"`,
    card.includes(`🏷️ Тип: Прогрев — касание ${touch} (${kind})`));
  // The copyable text sits between the separators — the marker must not be there.
  const copyBlock = card.split('──────── СКОПИРОВАТЬ ────────\n')[1].split('\n──────')[0];
  T(`touch ${touch}: copyable block == exact client text (no marker leak)`, copyBlock === CLIENT);
  T(`touch ${touch}: "касание" appears ONLY once (header), not in copy block`,
    (card.match(/касание/g) || []).length === 1 && !copyBlock.includes('касание'));
}

console.log('\n=== other message types unchanged (no marker) ===');
const greet = buildDraftCard({ lead, messageText: 'Hi!', messageType: 'greeting' });
T('greeting: plain "Тип: Приветствие", no touch marker', greet.includes('🏷️ Тип: Приветствие\n') && !greet.includes('касание'));
const nurtureNoTouch = buildDraftCard({ lead, messageText: 'Hi!', messageType: 'nurture' });
T('nurture without touch meta: no marker (defensive)', nurtureNoTouch.includes('🏷️ Тип: Прогрев\n') && !nurtureNoTouch.includes('касание'));
const badTouch = buildDraftCard({ lead, messageText: 'Hi!', messageType: 'nurture', touch: 1 });
T('nurture touch 1 (greeting, not a drip touch): no marker', !badTouch.includes('касание'));

console.log(`\n═══ Results: ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);

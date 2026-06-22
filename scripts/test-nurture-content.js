'use strict';

/**
 * A.3 — drip touch 2/3 content (prompts + verbatim fallbacks) + the pipe seam.
 * Pure-ish: prompt/fallback assertions need no DB; the delivery-seam section uses
 * a temp DB to prove real content lands in the ADMIN draft (never the client).
 *
 *   rm -f /tmp/drip-content.db*
 *   sqlite3 data/acrogym.db ".backup '/tmp/drip-content.db'"
 *   ACROGYM_DB_PATH=/tmp/drip-content.db node scripts/test-nurture-content.js
 */

if (!process.env.ACROGYM_DB_PATH || process.env.ACROGYM_DB_PATH.includes('data/acrogym.db')) {
  console.error('REFUSING: set ACROGYM_DB_PATH to a temp copy first.'); process.exit(1);
}
{
  const fs = require('fs');
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(process.env.ACROGYM_DB_PATH + ext)) {
    console.error(`REFUSING: stale ${process.env.ACROGYM_DB_PATH + ext}.`); process.exit(1);
  }
}

const { buildDripPrompt, dripFallback } = require('../agents/lead-helper/prompts');
const { buildDripContent } = require('../agents/lead-helper/drip-content');
const { getDb, insertLead, insertNurtureEnrollment, getNurtureEnrollmentByLeadId } = require('../shared/db');
const nurture = require('../shared/nurture');

let pass = 0, fail = 0;
const T = (n, c) => { console.log((c ? '  ✅ ' : '  ❌ ') + n); c ? pass++ : fail++; };

const SEGS = ['3-5', '6-9', '10-14', 'neutral', 'unknown', null];

(async () => {
  console.log('=== fallbacks: verbatim, {{name}} substituted, touch-2 has 🤸 / touch-3 has NONE ===');
  for (const touch of [2, 3]) {
    for (const ageSegment of SEGS) {
      const txt = dripFallback({ touch, parentName: 'Sara', ageSegment });
      const seg = (ageSegment === '3-5' || ageSegment === '6-9' || ageSegment === '10-14') ? ageSegment : 'neutral';
      T(`t${touch}/${ageSegment ?? 'null'}: starts "Hi Sara!"`, txt.startsWith('Hi Sara!'));
      T(`t${touch}/${ageSegment ?? 'null'}: no leftover {{name}} placeholder`, !/\{\{?name\}?\}|\$\{/.test(txt));
      if (touch === 2) T(`t2/${ageSegment ?? 'null'}: ends with 🤸`, /🤸$/.test(txt.trim()));
      else             T(`t3/${ageSegment ?? 'null'}: NO emoji`, !/🤸/.test(txt) && /you're ready\.$/.test(txt.trim()) === /you're ready\.$/.test(txt.trim()));
      T(`t${touch}/${ageSegment ?? 'null'}: maps to '${seg}' bucket`, txt === dripFallback({ touch, parentName: 'Sara', ageSegment: seg }));
    }
  }
  // touch-3 has zero emoji across the whole catalog (explicit, owner's edit)
  for (const ageSegment of ['3-5', '6-9', '10-14', 'neutral']) {
    T(`t3/${ageSegment}: contains no emoji char at all`,
      !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(dripFallback({ touch: 3, parentName: 'Sara', ageSegment })));
    T(`t2/${ageSegment}: DOES carry the 🤸`,
      /🤸/.test(dripFallback({ touch: 2, parentName: 'Sara', ageSegment })));
  }

  console.log('\n=== empty/blank name → "there" ===');
  T('empty name → "Hi there!"', dripFallback({ touch: 2, parentName: '', ageSegment: '6-9' }).startsWith('Hi there!'));
  T('whitespace name → "Hi there!"', dripFallback({ touch: 3, parentName: '   ', ageSegment: null }).startsWith('Hi there!'));

  console.log('\n=== prompts: touch goal + reused SEGMENT_GUIDANCE / neutral, name + exemplar in user ===');
  for (const touch of [2, 3]) {
    const realSeg = buildDripPrompt({ touch, parentName: 'Sara', ageSegment: '10-14' });
    T(`t${touch}: system reuses 10-14 SEGMENT_GUIDANCE (sport acrobatics)`, /sport acrobatics/.test(realSeg.system) && /Kristina/.test(realSeg.system));
    T(`t${touch}: system English-only + "Hi <name>"`, /English only/.test(realSeg.system) && /Hi <name>/.test(realSeg.system));
    T(`t${touch}: user names the parent + carries the exemplar`, /parent named Sara/.test(realSeg.user) && realSeg.user.includes('Hi Sara!'));
    T(`t${touch}: model + small token budget`, realSeg.model === 'claude-sonnet-4-5' && realSeg.maxTokens <= 400);

    const neutral = buildDripPrompt({ touch, parentName: 'Sara', ageSegment: 'unknown' });
    T(`t${touch}: unknown segment → neutral guidance (no "little one"), avoids age angle`,
      /age is unknown/.test(neutral.system) && /avoid "little one"/.test(neutral.system) && !/sport acrobatics/.test(neutral.system));
  }
  // touch-specific goal wording present
  T('t2 system: "gentle check-in" follow-up goal', /gentle check-in/.test(buildDripPrompt({ touch: 2, parentName: 'X', ageSegment: '6-9' }).system));
  T('t3 system: "open this September" + no specific day', /opens this September/.test(buildDripPrompt({ touch: 3, parentName: 'X', ageSegment: '6-9' }).system) && /Do NOT invent a specific day/.test(buildDripPrompt({ touch: 3, parentName: 'X', ageSegment: '6-9' }).system));
  T('t2 system: at most one light emoji', /one light emoji/.test(buildDripPrompt({ touch: 2, parentName: 'X', ageSegment: '6-9' }).system));
  T('t3 system: Do NOT use any emoji', /Do NOT use any emoji/.test(buildDripPrompt({ touch: 3, parentName: 'X', ageSegment: '6-9' }).system));

  console.log('\n=== buildDripContent: Claude OK → uses model text; Claude down → verbatim fallback ===');
  const cand = { next_touch: 2, parent_name: 'Sara', age_segment: '6-9' };
  const okText = await buildDripContent(cand, { generate: async () => 'MODEL DRAFT ✨' });
  T('Claude returns text → that text is used', okText === 'MODEL DRAFT ✨');
  const downText = await buildDripContent(cand, { generate: async () => { throw new Error('rate limit'); } });
  T('Claude throws → verbatim fallback returned', downText === dripFallback({ touch: 2, parentName: 'Sara', ageSegment: '6-9' }));
  const emptyText = await buildDripContent(cand, { generate: async () => '' });
  T('Claude empty string → verbatim fallback returned', emptyText === dripFallback({ touch: 2, parentName: 'Sara', ageSegment: '6-9' }));

  console.log('\n=== seam A.3/A.4: real content flows to ADMIN DRAFT, never the client ===');
  const db = getDb();
  db.exec('DELETE FROM client_messages; DELETE FROM nurture_enrollments; DELETE FROM leads;'); // self-isolating
  insertLead({ sheet_row_number: 9001, lead_uid: null, timestamp: '2026-06-01', parent_name: 'Sara',
    parent_phone: '+9745001', parent_whatsapp: '+9745001', parent_email: 's@x.co', qid: '', language: 'en',
    client_type: 'new', phone_normalized: '9745001', whatsapp_normalized: '9745001', email_normalized: 's@x.co',
    ref_lead_id: null, raw_data: '{}', status: 'responded' });
  const leadId = db.prepare('SELECT id FROM leads WHERE sheet_row_number=9001').get().id;
  insertNurtureEnrollment({ lead_id: leadId, audience: 'cold', audience_auto: 'cold', audience_override: null,
    age_segment: '6-9', children_count: 1, children_json: '{}', status: 'active' });
  db.prepare("UPDATE nurture_enrollments SET next_due_at=datetime('now','-1 day') WHERE lead_id=?").run(leadId); // due (touch 2)

  let captured = null;
  const stubDeliver = async (args) => {
    captured = args;
    db.prepare(`INSERT INTO client_messages (lead_id, broadcast_id, recipient_phone, message_type, text, language, channel, delivery_status, agent_name, sent_at)
                VALUES (?, NULL, NULL, ?, ?, ?, 'telegram_draft', 'sent_to_admin', ?, datetime('now'))`)
      .run(args.metadata.leadId, args.messageType, args.messageText, args.lead.language || 'en', args.metadata.agentName);
  };
  // Claude down → exercises the verbatim path through the real content builder.
  const buildContent = (c) => buildDripContent(c, { generate: async () => { throw new Error('down'); } });
  const r = await nurture.buildAndSendQueue({ deliver: stubDeliver, buildContent });

  T('one touch queued', r.queued === 1);
  T('delivered body is REAL content, not the placeholder', captured && !/placeholder/.test(captured.messageText) && captured.messageText.startsWith('Hi Sara!'));
  T('body == approved verbatim touch-2 / 6-9 fallback', captured.messageText === dripFallback({ touch: 2, parentName: 'Sara', ageSegment: '6-9' }));
  const stored = db.prepare("SELECT channel, delivery_status, recipient_phone FROM client_messages WHERE lead_id=? ORDER BY id DESC LIMIT 1").get(leadId);
  T('delivery mechanism UNCHANGED: admin draft (telegram_draft / sent_to_admin)', stored.channel === 'telegram_draft' && stored.delivery_status === 'sent_to_admin');
  T('NOT auto-sent to a client number (recipient_phone NULL)', stored.recipient_phone === null);
  T('enrollment advanced touch 2 → 3 (pipe intact)', getNurtureEnrollmentByLeadId(leadId).next_touch === 3);

  console.log(`\n═══ Results: ${pass} passed, ${fail} failed ═══`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.stack); process.exit(1); });

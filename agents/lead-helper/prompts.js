'use strict';

// Touch-1 welcome draft (Agent 3 — nurture prompter).
// The bot only DRAFTS this; the admin edits and sends it to the parent
// personally via WhatsApp. Addressed to the PARENT by first name; the child is
// referred to impersonally (we don't capture a child name). Age-segmented tone.

const BRAND =
  "AcroGym, a children's gymnastics center opening September 2026 in The Pearl, " +
  "Qatar. Brand voice: reliability, energy, movement, safety, professionalism.";

// Per-segment angle for the model. Segments mirror the REAL class grid
// (owner + head coach, 25.07.2026): 2-3 / 3-4 / 4-5 / 6-8 / 10-14 — these are
// different classes, not one "3-5 babies" bucket. A boundary age belongs to the
// OLDER group (3 → 3-4; 4 and 5 → 4-5, per owner: "4-5 относится к 4-5").
const SEGMENT_GUIDANCE = {
  '2-3':
    'The child is 2-3 years old (toddler class). Emphasis: playful movement ' +
    'exploration — crawling, climbing and first balance games; body awareness ' +
    'and coordination basics in a soft, safe, caring environment.',
  '3-4':
    'The child is 3-4 years old. Emphasis: playful but structured classes — ' +
    'balance, coordination, learning to follow the coach, first gymnastics ' +
    'shapes and rolls through games; growing confidence and independence.',
  '4-5':
    'The child is 4-5 years old — NOT a toddler format. Emphasis: real ' +
    'gymnastics foundations — proper rolls, bridges and handstand prep, ' +
    'strength and flexibility basics, focus and discipline built through fun. ' +
    'Refer to the child as "your child" — NOT "little one".',
  '6-8':
    'The child is 6-8 years old. Emphasis: building real gymnastics skills, ' +
    'strength and confidence through structured, energetic classes kids love.',
  '10-14':
    'The child is 10-14 years old. Emphasis: sport acrobatics — technique, ' +
    'strength and real athletic progress — coached by Kristina, a Master of ' +
    'Sport and champion gymnast. Refer to the child as "your child" or "your ' +
    'young athlete" — NOT "little one" (they are a teen/pre-teen).',
};

// Static fallback when Claude is unavailable, AND the style anchor the prompt
// follows. 6-8/10-14/neutral are owner-signed (June); 2-3/3-4/4-5 drafted
// 25.07.2026 on the owner's "сам изучи и добавь" after the coach corrected the
// age grid (a 5-y-o got a "little ones 3-5" draft — wrong, not a baby format).
const FALLBACK = {
  '2-3': (p) =>
    `Hi ${p}! 🤸 Thank you so much for your interest in AcroGym. For toddlers, ` +
    `classes are all about playful movement — crawling, climbing and first balance ` +
    `games that build body awareness and coordination in a soft, safe space. Our team ` +
    `will be in touch soon to tell you everything. We'd love to welcome your little one!\n` +
    `— AcroGym Team 🤸`,
  '3-4': (p) =>
    `Hi ${p}! 🤸 Thank you so much for your interest in AcroGym. At this age classes ` +
    `are playful but structured — balance games, coordination and those first gymnastics ` +
    `shapes and rolls, all learned through play with caring coaches. Our team will be in ` +
    `touch soon with all the details. We'd love to welcome your little one!\n` +
    `— AcroGym Team 🤸`,
  '4-5': (p) =>
    `Hi ${p}! 🤸 Thanks so much for reaching out to AcroGym. At this age kids are ready ` +
    `for real gymnastics foundations — rolls, bridges and first handstands, building ` +
    `strength, flexibility and focus while having fun. Our team will get back to you soon ` +
    `with all the details. We can't wait to welcome your child!\n` +
    `— AcroGym Team 🤸`,
  '6-8': (p) =>
    `Hi ${p}! 🤸 Thanks so much for reaching out to AcroGym. This is a wonderful ` +
    `age to build real gymnastics skills, strength and confidence — through structured, ` +
    `energetic classes that kids genuinely love. Our team will get back to you soon with ` +
    `all the details. We can't wait to welcome your child!\n` +
    `— AcroGym Team 🤸`,
  '10-14': (p) =>
    `Hi ${p}! 🤸 Thank you for your interest in AcroGym. For this age we focus on ` +
    `sport acrobatics — technique, strength and real athletic progress — coached by ` +
    `Kristina, a Master of Sport and champion gymnast. Our team will reach out soon with ` +
    `everything you need to know. Looking forward to welcoming your child!\n` +
    `— AcroGym Team 🤸`,
  'neutral': (p) =>
    `Hi ${p}! 🤸 Thank you for reaching out to AcroGym — we're so glad you're ` +
    `interested. Our team will get in touch soon to tell you all about our classes and ` +
    `answer any questions you have. We'd love to welcome your family!\n` +
    `— AcroGym Team 🤸`,
};

/**
 * Maps a free-text child age to a segment, or null when unknown/out of range.
 * Parses the first 1-2 digit number ("5", "5 years", "6-7" -> 6).
 */
function ageSegment(raw) {
  if (raw == null) return null;
  const m = String(raw).match(/\d{1,2}/);
  if (!m) return null;
  const age = parseInt(m[0], 10);
  if (age === 2) return '2-3';
  if (age === 3) return '3-4';               // boundary age → older group
  if (age === 4 || age === 5) return '4-5';  // 5 is NOT a baby format (coach, 25.07)
  if (age >= 6 && age <= 9) return '6-8';    // no separate 9-y group — closest tone
  if (age >= 10 && age <= 14) return '10-14';
  return null; // out of range -> neutral draft
}

function systemPrompt(segmentHint) {
  return (
    `You are the assistant of ${BRAND} ` +
    'Write a warm, personal WhatsApp welcome message to a PARENT who just submitted ' +
    'an inquiry. Address the parent by their first name; refer to the child ' +
    'impersonally ("your little one" / "your child") — never invent a child name. ' +
    'Tone: friendly, professional, not dry. Length: 3-5 sentences, 1-2 emojis. ' +
    'Do NOT mention specific prices, schedules or address (unknown yet). Do NOT ' +
    'promise a callback time. End with the signature: "— AcroGym Team 🤸". ' +
    (segmentHint || "The child's age is unknown — keep it general, no age-specific angle. " +
      'Refer to the child as "your child" or "your family" — avoid "little one" (an ageless lead may be a teen).')
  );
}

/**
 * Builds the Claude prompt for the welcome draft.
 * @param {object} p
 * @param {string} [p.parentName]
 * @param {string|number} [p.childAge]
 */
function buildGreetingPrompt({ parentName, childAge } = {}) {
  const seg = ageSegment(childAge);
  const name = firstName(parentName) || 'there';
  const exemplar = FALLBACK[seg || 'neutral'](name);
  return {
    system: systemPrompt(seg ? SEGMENT_GUIDANCE[seg] : null),
    user:
      `Write the welcome message for a parent named ${name}.\n\n` +
      'Follow this approved example closely for tone, length, key points and ' +
      'signature, but rephrase it naturally in your own words (do not copy verbatim):\n\n' +
      exemplar,
    maxTokens: 400,
    model: 'claude-opus-5',
  };
}

/**
 * Verbatim approved fallback draft — used when Claude is unavailable.
 */
function fallbackGreeting({ parentName, childAge } = {}) {
  const seg = ageSegment(childAge) || 'neutral';
  const name = firstName(parentName) || 'there';
  return FALLBACK[seg](name);
}

// ─────────────────────────────────────────────────────────────
// Drip touches 2 & 3 (Agent 3 — A.3)
//
// The bot only DRAFTS these to the admin queue; the admin sends each to the
// parent personally via WhatsApp — never auto-sent. English only. Per-age angle
// REUSES touch-1 SEGMENT_GUIDANCE verbatim (not four new prompts). Touch 2 =
// day-3 follow-up (reconnect, invite a question — no selling). Touch 3 = day-7
// pre-launch warm (we open this September — keep warm, no pressure; NO emoji by
// design, so three touches don't all carry the same 🤸).
// ─────────────────────────────────────────────────────────────

// Neutral age hint when the segment is unknown (mirrors systemPrompt's neutral
// branch — never "little one", an ageless lead may be a teen).
const DRIP_NEUTRAL_GUIDANCE =
  "The child's age is unknown — keep it general, with no age-specific angle. " +
  'Refer to the child as "your child" or "your family" — avoid "little one".';

// Per-touch goal + extra rules woven into the system prompt.
const DRIP_TOUCH = {
  2: {
    goal:
      'a PARENT who reached out about classes for their child about 3 days ago ' +
      "and hasn't written back yet. This is a gentle check-in: reconnect and make " +
      'it easy to ask a question — NOT to sell, not to push.',
    extra:
      "Invite a question; keep it low-pressure. Make NO promises we can't keep — " +
      'no prices, no schedules, no guaranteed spots, no specific dates. At most ' +
      'one light emoji.',
  },
  3: {
    goal:
      'a PARENT who reached out about classes for their child about a week ago. ' +
      'AcroGym opens this September. Keep them warm and gently let them know ' +
      "we're opening — NOT a hard sell, no pressure; they should feel welcome and " +
      'in no rush.',
    extra:
      'You MAY say we open in September. Do NOT invent a specific day, prices, ' +
      'class times, or guaranteed spots. Offer to let them know when enrollment ' +
      'opens; keep it low-pressure. Do NOT use any emoji.',
  },
};

// Owner-signed verbatim fallback texts (A.3). Touch 2 ends with 🤸; touch 3 has
// NO emoji by design. Used as the static fallback when Claude is unavailable AND
// as the style anchor the prompt follows.
const DRIP_FALLBACK = {
  2: {
    '2-3': (p) =>
      `Hi ${p}! Just following up since you got in touch about AcroGym. If you're ` +
      `wondering how toddler classes work — the movement games, the climbing, those ` +
      `first balance wins — I'd be glad to walk you through it. Reply whenever suits you. 🤸`,
    '3-4': (p) =>
      `Hi ${p}! Just following up since you got in touch about AcroGym. If you're ` +
      `curious how classes work at this age — playful but structured, with balance games ` +
      `and first gymnastics shapes — I'd be glad to tell you more. Reply whenever suits you. 🤸`,
    '4-5': (p) =>
      `Hi ${p}! Following up after you reached out about AcroGym. If you have any ` +
      `questions about how we start real gymnastics foundations at this age — rolls, ` +
      `bridges, first handstands — I'm here, just reply whenever it's convenient. 🤸`,
    '6-8': (p) =>
      `Hi ${p}! Following up after you reached out about AcroGym. If you have any ` +
      `questions about how we build real gymnastics skills at this age, or what a class ` +
      `actually looks like, I'm here — just reply whenever it's convenient. 🤸`,
    '10-14': (p) =>
      `Hi ${p}! Just checking in since you got in touch about AcroGym. If any questions ` +
      `have come up about our sport acrobatics training or how we work with this age ` +
      `group, I'd be glad to answer them — reply whenever suits you. 🤸`,
    'neutral': (p) =>
      `Hi ${p}! Just checking in after you reached out about AcroGym a few days ago. ` +
      `If any questions have come up about our classes or how we work with kids, I'm ` +
      `happy to help — just reply here whenever it's convenient. 🤸`,
  },
  3: {
    '2-3': (p) =>
      `Hi ${p}! A little update from AcroGym — we're opening this September, and we'd ` +
      `love to welcome your little one. If you'd like, I'll make sure you're among the ` +
      `first to know when we start enrolling. Reply whenever you're ready.`,
    '3-4': (p) =>
      `Hi ${p}! Wanted to keep you posted — AcroGym opens this September, and we'd love ` +
      `to welcome your little one to our playful classes. If you'd like, I can let you ` +
      `know the moment enrollment opens. No rush — reply whenever suits you.`,
    '4-5': (p) =>
      `Hi ${p}! Quick update from AcroGym — we're opening this September, and we'd love ` +
      `to have your child start their gymnastics journey with us. I can let you know as ` +
      `soon as enrollment opens. No pressure — just reply whenever you're ready.`,
    '6-8': (p) =>
      `Hi ${p}! Wanted to keep you posted — AcroGym opens this September, and we'd love ` +
      `to have your child join us. If you're interested, I can let you know the moment ` +
      `enrollment opens. No pressure — just reply whenever suits you.`,
    '10-14': (p) =>
      `Hi ${p}! Quick update from AcroGym — we're opening this September. If your teen ` +
      `is keen on acrobatics, we'd love to have them with us, and I'm happy to let you ` +
      `know as soon as we start enrolling. Reply whenever you're ready.`,
    'neutral': (p) =>
      `Hi ${p}! Just wanted to keep you in the loop — AcroGym opens this September, and ` +
      `we'd love to have your child with us. If you'd like, I can let you know as soon ` +
      `as enrollment opens. No rush at all — just reply whenever you're ready.`,
  },
};

/** nurture age_segment ('2-3'|'3-4'|'4-5'|'6-8'|'10-14'|'unknown'|null) → fallback/guidance key. */
const DRIP_SEG_KEYS = new Set(['2-3', '3-4', '4-5', '6-8', '10-14']);
function dripSegKey(ageSegment) {
  return DRIP_SEG_KEYS.has(ageSegment) ? ageSegment : 'neutral';
}

function dripSystemPrompt(touch, segmentHint) {
  const t = DRIP_TOUCH[touch];
  return (
    `You are the assistant of ${BRAND} ` +
    `Write a short, warm WhatsApp message to ${t.goal} ` +
    'Address the parent by their first name; refer to the child impersonally — ' +
    'never invent a child name. English only. Open with "Hi <name>" — personal ' +
    'and friendly, never "Dear customer". 2-4 short sentences, WhatsApp length. ' +
    'Sound like a real person texting, not a marketing bot. ' +
    `${t.extra} ` +
    (segmentHint || DRIP_NEUTRAL_GUIDANCE)
  );
}

/**
 * Builds the Claude prompt for a drip touch (2 or 3).
 * @param {object} p
 * @param {2|3} p.touch
 * @param {string} [p.parentName]
 * @param {string} [p.ageSegment]  nurture age_segment
 */
function buildDripPrompt({ touch, parentName, ageSegment } = {}) {
  const seg  = dripSegKey(ageSegment);
  const name = firstName(parentName) || 'there';
  const exemplar = DRIP_FALLBACK[touch][seg](name);
  const kind = touch === 2 ? 'follow-up' : 'pre-launch';
  return {
    system: dripSystemPrompt(touch, seg === 'neutral' ? null : SEGMENT_GUIDANCE[seg]),
    user:
      `Write the ${kind} message for a parent named ${name}.\n\n` +
      'Follow this approved example closely for tone, length and key points, but ' +
      'rephrase it naturally in your own words (do not copy verbatim):\n\n' +
      exemplar,
    maxTokens: 300,
    model: 'claude-opus-5',
  };
}

/** Verbatim approved drip fallback — used when Claude is unavailable. */
function dripFallback({ touch, parentName, ageSegment } = {}) {
  const seg  = dripSegKey(ageSegment);
  const name = firstName(parentName) || 'there';
  return DRIP_FALLBACK[touch][seg](name);
}

// Fixed welcome draft (owner-approved verbatim, 11.08.2026). Replaces the
// age-segmented AI draft for touch-1: owner wants ONE consistent message with
// real facts (open date, mall, price, ages 2-16 + adults 18+). Name inserted
// after "Hello", same as the earlier per-name drafts.
// Only the first name goes into messages (owner 11.08: «фамилию не надо»).
// "Mwende Ma Liv" -> "Mwende". Empty/whitespace -> ''.
function firstName(raw) {
  return String(raw || '').trim().split(/\s+/)[0] || '';
}

function welcomeDraft({ parentName } = {}) {
  const name = firstName(parentName);
  const hello = name ? `Hello ${name}!` : 'Hello!';
  return (
    `${hello} \u{1F44B} This is AcroGym \u2014 thank you for your interest! \u{1F9E1}\n\n` +
    `We're excited to welcome you to our brand-new gymnastics center \u2014 we open on ` +
    `September 1st at Lagoona Mall, Doha! \u{1F938}\n\n` +
    `We have classes for kids aged 2 to 16, in small groups matched by age \u2014 and adult ` +
    `classes for 18+ too! A class costs around 100 QAR \u2014 come and see how you love it!\n\n` +
    `Would you like me to book a spot for the first week of September? \u{1F60A}`
  );
}

module.exports = {
  buildGreetingPrompt, fallbackGreeting, welcomeDraft, firstName, ageSegment,
  buildDripPrompt, dripFallback,
};

'use strict';

// Touch-1 welcome draft (Agent 3 — nurture prompter).
// The bot only DRAFTS this; the admin edits and sends it to the parent
// personally via WhatsApp. Addressed to the PARENT by first name; the child is
// referred to impersonally (we don't capture a child name). Age-segmented tone.

const BRAND =
  "AcroGym, a children's gymnastics center opening September 2026 in The Pearl, " +
  "Qatar. Brand voice: reliability, energy, movement, safety, professionalism.";

// Per-segment angle for the model.
const SEGMENT_GUIDANCE = {
  '3-5':
    'The child is 3-5 years old. Emphasis: play, balance and first confident ' +
    'movements; coordination and motor skills; a safe, caring environment.',
  '6-9':
    'The child is 6-9 years old. Emphasis: building real gymnastics skills, ' +
    'strength and confidence through structured, energetic classes kids love.',
  '10-14':
    'The child is 10-14 years old. Emphasis: sport acrobatics — technique, ' +
    'strength and real athletic progress — coached by Kristina, a Master of ' +
    'Sport and champion gymnast. Refer to the child as "your child" or "your ' +
    'young athlete" — NOT "little one" (they are a teen/pre-teen).',
};

// Approved verbatim texts (owner-signed). Used as the static fallback when
// Claude is unavailable, AND as the style anchor the prompt follows.
const FALLBACK = {
  '3-5': (p) =>
    `Hi ${p}! 🤸 Thank you so much for your interest in AcroGym. At this age, ` +
    `gymnastics is all about play, balance and those first confident movements — ` +
    `building coordination and motor skills in a safe, caring environment. Our team ` +
    `will be in touch soon to tell you everything. We'd love to welcome your little one!\n` +
    `— AcroGym Team 🤸`,
  '6-9': (p) =>
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
  if (age >= 3 && age <= 5) return '3-5';
  if (age >= 6 && age <= 9) return '6-9';
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
  const name = (parentName || '').trim() || 'there';
  const exemplar = FALLBACK[seg || 'neutral'](name);
  return {
    system: systemPrompt(seg ? SEGMENT_GUIDANCE[seg] : null),
    user:
      `Write the welcome message for a parent named ${name}.\n\n` +
      'Follow this approved example closely for tone, length, key points and ' +
      'signature, but rephrase it naturally in your own words (do not copy verbatim):\n\n' +
      exemplar,
    maxTokens: 400,
    model: 'claude-sonnet-4-5',
  };
}

/**
 * Verbatim approved fallback draft — used when Claude is unavailable.
 */
function fallbackGreeting({ parentName, childAge } = {}) {
  const seg = ageSegment(childAge) || 'neutral';
  const name = (parentName || '').trim() || 'there';
  return FALLBACK[seg](name);
}

module.exports = { buildGreetingPrompt, fallbackGreeting, ageSegment };

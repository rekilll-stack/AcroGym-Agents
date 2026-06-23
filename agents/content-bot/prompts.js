'use strict';

/**
 * Content-bot prompts (C.2) — Instagram text formats.
 *
 * Brand voice: WARM & FAMILY-FIRST with a QUIET PREMIUM undertone. The bot only
 * DRAFTS — Kirill copies and publishes by hand. English only.
 *
 * Three text formats: 'post' (one ready Instagram post), 'ideas' (5-7 post
 * ideas), 'plan' (a one-week content plan). Each returns { system, user,
 * maxTokens, model } for shared/claude.js generateText, plus a graceful, clearly
 * tagged fallback for when Claude is unavailable.
 */

// ─────────────────────────────────────────────────────────────
// Brand context + voice (shared across formats; consistent with lead-helper)
// ─────────────────────────────────────────────────────────────
const BRAND_CONTEXT =
  "AcroGym is a children's gymnastics center opening in September 2026 in The " +
  "Pearl, Doha, Qatar. The heart of the brand: \"grow through movement, " +
  "confidence, and joy\". Audience: parents of children aged 3-14 in Doha " +
  "(expat and local community). Head coach: Kristina — Master of Sport, 5× " +
  "Russian national champion, European medalist, 10+ years of coaching " +
  "experience.";

const VOICE =
  "VOICE — warm and family-first, with a quiet premium undertone:\n" +
  "- Lead with warmth: a parent's emotion, a child's joy and growing " +
  "confidence, first little wins, a safe and caring environment.\n" +
  "- Let premium come through naturally, never loud: real expertise (coach " +
  "Kristina's credentials), a thoughtful program, a calm confident tone. " +
  "Premium is felt, not announced.\n" +
  "- AVOID cheap urgency (\"Hurry! Sign up now! Discount!\"), dry corporate " +
  "lines, empty hype, and \"we're the best / #1\" claims. Confident calm, not " +
  "slogans.\n" +
  "- English only — even if the user's topic is written in Russian or another " +
  "language, ALWAYS understand it and write the output in English.\n" +
  "- Pre-launch: the center opens in September 2026. You may build gentle " +
  "anticipation (\"opening this September\"), but NEVER invent a specific day, " +
  "prices, schedule, or address.\n" +
  "- Never invent facts. If something isn't given above, stay graceful and " +
  "general rather than fabricate specifics.";

// Curated hashtag pool — the model picks a relevant subset (popular + niche).
const HASHTAG_POOL =
  "#AcroGym #DohaKids #Gymnastics #KidsGymnastics #DohaMoms #DohaFamily " +
  "#QatarKids #GymnasticsForKids #ThePearlQatar #DohaParents #KidsActivitiesDoha " +
  "#QatarFamily #ChildrenGymnastics #DohaLife #ActiveKids #KidsFitness " +
  "#DohaCommunity #GymnasticsLife";

const COMMON = `You are the social-media content assistant for AcroGym.\n${BRAND_CONTEXT}\n\n${VOICE}`;

// ─────────────────────────────────────────────────────────────
// Per-format system prompts
// ─────────────────────────────────────────────────────────────
const FORMATS = {
  post: {
    label: 'Full post',
    maxTokens: 700,
    system:
      `${COMMON}\n\n` +
      'TASK: Write ONE ready-to-publish Instagram post about the topic the user ' +
      'gives. 2-4 short paragraphs. Open with warmth/emotion, weave in understated ' +
      'expertise, and end with a soft, gentle invitation (never an aggressive ' +
      'call-to-action). Then add a final line of 8-15 relevant hashtags — pick a ' +
      'natural mix of popular and niche from this pool (you may adapt):\n' +
      `${HASHTAG_POOL}\n\n` +
      'Output ONLY the post text followed by the hashtag line. No preamble, no ' +
      'explanations, no quotation marks around it.',
    instruction: (topic) => `Topic / context for the post:\n${topic}`,
  },
  ideas: {
    label: 'Ideas',
    maxTokens: 600,
    system:
      `${COMMON}\n\n` +
      'TASK: Give 5-7 Instagram post IDEAS for the theme the user gives. Each idea ' +
      'on its own line as: a short punchy title — then one line on the angle/what ' +
      "it's about. Make the angles varied (educational, emotional, behind-the-" +
      'scenes, parent reassurance, child milestones, the coach, the program). Keep ' +
      'each idea brief. No hashtags here. Output ONLY the numbered list.',
    instruction: (topic) => `Theme / rubric for the ideas:\n${topic}`,
  },
  plan: {
    label: 'Week plan',
    maxTokens: 800,
    system:
      `${COMMON}\n\n` +
      'TASK: Build a ONE-WEEK Instagram content plan (5-7 posts) around the theme ' +
      'the user gives. For each post: Day — a short topic/angle — and a content ' +
      'type tag in brackets (e.g. [educational], [emotional], [behind-the-scenes], ' +
      '[benefits], [meet the coach]). Ensure variety across the week. Keep each ' +
      'line concise. Output ONLY the plan, one post per line.',
    instruction: (topic) => `Theme / focus for the week:\n${topic}`,
  },
};

function isFormat(f) {
  return Object.prototype.hasOwnProperty.call(FORMATS, f);
}

function formatLabel(f) {
  return isFormat(f) ? FORMATS[f].label : f;
}

/**
 * Build the Claude prompt for a format + topic.
 * @param {'post'|'ideas'|'plan'} format
 * @param {string} topic
 */
function buildContentPrompt(format, topic) {
  const f = FORMATS[format];
  if (!f) throw new Error(`unknown content format: ${format}`);
  const t = String(topic || '').trim() || 'AcroGym children\'s gymnastics in Doha';
  return {
    system: f.system,
    user:
      "The user's topic may be written in Russian or any language — understand it, " +
      'then write the output ENTIRELY IN ENGLISH regardless of the input language.\n\n' +
      f.instruction(t),
    maxTokens: f.maxTokens,
    model: 'claude-opus-4-8', // owner choice: top quality for brand-voice content (low volume)
  };
}

// ─────────────────────────────────────────────────────────────
// Graceful fallbacks (Claude unavailable). Clearly tagged as offline skeletons
// so a fallback is never mistaken for a finished, AI-polished draft.
// ─────────────────────────────────────────────────────────────
const OFFLINE_TAG = '⚠️ (offline skeleton — generator unavailable, tap 🔄 Regenerate to try again)';

function fallbackContent(format, topic) {
  const t = String(topic || '').trim() || 'AcroGym';
  if (format === 'ideas') {
    return `${OFFLINE_TAG}\n\nPost ideas on "${t}":\n` +
      `1. A child's first little win — the moment of joy and confidence.\n` +
      `2. Meet coach Kristina — experience that quietly reassures parents.\n` +
      `3. Behind the scenes — a calm, caring, well-prepared environment.\n` +
      `4. Why movement matters — gymnastics for growing bodies and minds.\n` +
      `5. Opening this September — a warm note of anticipation.`;
  }
  if (format === 'plan') {
    return `${OFFLINE_TAG}\n\nOne-week plan on "${t}":\n` +
      `Mon — Welcome to AcroGym, our story and heart [emotional]\n` +
      `Tue — What a first class feels like for your child [educational]\n` +
      `Wed — Meet coach Kristina [meet the coach]\n` +
      `Thu — Why gymnastics builds confidence [benefits]\n` +
      `Fri — A peek inside our space [behind-the-scenes]\n` +
      `Sat — A small milestone, a big smile [emotional]\n` +
      `Sun — Opening this September — join us [gentle invitation]`;
  }
  // post
  return `${OFFLINE_TAG}\n\nThere's a special kind of joy in watching a child ` +
    `discover what their body can do — a first balance, a first confident landing, ` +
    `a first proud smile. At AcroGym, that's the heart of everything: helping ` +
    `children grow through movement, confidence, and joy.\n\n` +
    `Guided by coach Kristina's years of experience, every class is thoughtful, ` +
    `safe, and full of warmth. We're opening this September in The Pearl, Doha — ` +
    `and we'd love to welcome your family.\n\n` +
    `#AcroGym #DohaKids #KidsGymnastics #DohaFamily #ThePearlQatar #QatarKids #GymnasticsForKids #DohaParents`;
}

// ─────────────────────────────────────────────────────────────
// Photo caption (C.4 — vision). Claude Opus 4.8 looks at a photo and writes an
// English Instagram caption in the brand voice. 🔴 CHILD SAFETY enforced in the
// system prompt — about the activity/atmosphere, never individual children.
// ─────────────────────────────────────────────────────────────
const CAPTION_SYSTEM =
  `${COMMON}\n\n` +
  'TASK: You are given a PHOTO from AcroGym. Look at it and write ONE ready-to-' +
  'publish Instagram caption in the brand voice — warm and family-first with a ' +
  'quiet premium undertone. Reference the activity, energy and atmosphere in the ' +
  'photo naturally. End with a soft, gentle invitation (never an aggressive call-' +
  'to-action). Then a final line of 8-15 relevant hashtags (mix popular + niche), ' +
  `e.g.:\n${HASHTAG_POOL}\n\n` +
  '🔴 CHILD SAFETY — STRICT, NON-NEGOTIABLE:\n' +
  '- The photo likely shows children. Write about the ACTIVITY, the movement, the ' +
  'joy, the care and the environment — NOT about individual children.\n' +
  "- Do NOT describe any child's physical appearance, body, face, clothing or " +
  'looks. Do NOT estimate ages. Do NOT use or invent names. Do NOT single out a ' +
  'specific child.\n' +
  '- Keep it about the experience and the community, in a general, warm way. If in ' +
  'doubt, stay general.\n\n' +
  'English only — even if the user adds context in Russian, write the caption in ' +
  'English. Output ONLY the caption followed by the hashtag line.';

/**
 * Vision prompt for a photo caption. The image is passed separately (base64) to
 * generateText({ images }). `contextText` is optional free text the user
 * attached with the photo (may be in Russian).
 */
function buildCaptionPrompt(contextText) {
  const ctx = String(contextText || '').trim();
  return {
    system: CAPTION_SYSTEM,
    user: ctx
      ? `Optional context from the user about this photo (may be in Russian): ${ctx}\n\nWrite the English Instagram caption now.`
      : 'Write the English Instagram caption for this photo now.',
    maxTokens: 600,
    model: 'claude-opus-4-8',
  };
}

/** Graceful tagged fallback caption when vision is unavailable. */
function fallbackCaption() {
  return `${OFFLINE_TAG}\n\nThere's so much joy in watching children grow through ` +
    `movement — building confidence, balance and big smiles, one playful step at a ` +
    `time. That's the heart of AcroGym. Opening this September in The Pearl, Doha — ` +
    `we'd love to welcome your family.\n\n` +
    `#AcroGym #DohaKids #KidsGymnastics #DohaFamily #ThePearlQatar #QatarKids #GymnasticsForKids #ActiveKids`;
}

module.exports = {
  FORMATS, isFormat, formatLabel, buildContentPrompt, fallbackContent,
  buildCaptionPrompt, fallbackCaption, CAPTION_SYSTEM,
  BRAND_CONTEXT, VOICE, HASHTAG_POOL,
};

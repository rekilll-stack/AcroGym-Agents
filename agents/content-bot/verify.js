'use strict';

/**
 * Self-verification — the "проверяй по 2 раза" safety net, heavily expanded.
 *
 * Nothing is shown for approval or auto-published until it passes. Layers:
 *  1) STRUCTURE  — decodes, IG portrait 4:5, ≥1080px, sane file size.
 *  2) INTEGRITY  — not blank/near-uniform; NOT a split/stitched image (top vs
 *     bottom half saturation+brightness mismatch — catches the agent filling the
 *     wrong layer so the page shows two different photos); duplicate-photo check.
 *  3) VISION (AI, Sonnet) — a big rubric: single photo, upright, faces uncropped,
 *     text legibility/completeness/fit, CTA correct, NO leftover template text,
 *     on-brand, brand colours, asterisk, child-safe, spelling/grammar, sharpness,
 *     contrast, duotone consistency, etc.
 *  4) CAROUSEL  — count, size consistency, duplicate photos, style consistency.
 *  5) CAPTION   — length, hashtags, language, placeholders, spacing.
 *
 * Returns { ok, issues[] }. Callers MUST NOT publish/show anything that fails.
 */

const { createCanvas, loadImage } = require('canvas');
const { generateText } = require('../../shared/claude');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('content-bot');

const TARGET_RATIO = 1080 / 1350;
const RATIO_TOL = 0.03;
const MIN_WIDTH = 1080;
const MIN_BYTES = 20 * 1024;
const MAX_BYTES = 25 * 1024 * 1024;
const MIN_SLIDES = 1;
const MAX_SLIDES = 10;
// Vision QA on Haiku (cheap) — quality is now driven by smart photo selection
// (photos.js, Sonnet) + deterministic checks; keeps per-post cost in budget.
// Full model ID required — this goes through the Anthropic SDK (shared/claude),
// which does NOT accept CLI aliases like "haiku" (→ 404 not_found_error).
const VISION_MODEL = process.env.CONTENT_VERIFY_MODEL || 'claude-haiku-4-5-20251001';
const PLACEHOLDER_RE = /\b(lorem ipsum|paste_|your text here|headline here|body here|meet the coach|building skills together|xxxx+)\b/i;

// ── layer 1: structure ───────────────────────────────────────────
async function checkStructure(buffer) {
  const issues = [];
  if (!Buffer.isBuffer(buffer) || buffer.length < MIN_BYTES) issues.push(`image too small (${buffer ? buffer.length : 0} bytes) — likely broken export`);
  if (buffer && buffer.length > MAX_BYTES) issues.push(`image suspiciously large (${(buffer.length / 1e6).toFixed(1)} MB)`);
  let img;
  try { img = await loadImage(buffer); }
  catch (err) { return { ok: false, issues: [`undecodable image: ${err.message}`], width: 0, height: 0, img: null }; }
  const ratio = img.width / img.height;
  if (Math.abs(ratio - TARGET_RATIO) > RATIO_TOL) issues.push(`aspect ratio ${ratio.toFixed(3)} ≠ 4:5`);
  if (img.width < MIN_WIDTH) issues.push(`width ${img.width}px < IG min ${MIN_WIDTH}`);
  return { ok: issues.length === 0, issues, width: img.width, height: img.height, img };
}

// ── layer 2: integrity (blank + SPLIT/stitched + hash) ───────────
function rgbToSat(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
}

// Downscale to n×n; gather luminance variance, aHash, and per-half saturation +
// luminance to detect a stitched two-photo page.
function fingerprint(img, n = 16) {
  const c = createCanvas(n, n);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, n, n);
  const { data } = ctx.getImageData(0, 0, n, n);
  const gray = [];
  let topSat = 0, botSat = 0, topLum = 0, botLum = 0, topCnt = 0, botCnt = 0;
  for (let idx = 0, px = 0; idx < data.length; idx += 4, px++) {
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    gray.push(lum);
    const row = Math.floor(px / n);
    const sat = rgbToSat(r, g, b);
    if (row < n / 2) { topSat += sat; topLum += lum; topCnt++; }
    else { botSat += sat; botLum += lum; botCnt++; }
  }
  const mean = gray.reduce((a, b) => a + b, 0) / gray.length;
  const variance = gray.reduce((a, x) => a + (x - mean) ** 2, 0) / gray.length;
  const hash = gray.map((x) => (x >= mean ? '1' : '0')).join('');
  return {
    variance, hash,
    topSat: topSat / topCnt, botSat: botSat / botCnt,
    topLum: topLum / topCnt, botLum: botLum / botCnt,
  };
}

function checkIntegrity(img) {
  const issues = [];
  const fp = fingerprint(img);
  if (fp.variance < 25) issues.push('image looks blank / near-uniform (broken export?)');
  // SPLIT detection: one half ~grayscale while the other is clearly colour ⇒
  // two different photos stacked (the exact "wrong layer filled" bug).
  // The real "wrong layer filled" bug leaves one half ~grayscale (the old
  // template B&W photo) while the other is colour. Detect THAT. (A correct slide
  // can legitimately have a colourful photo on top and an orange-overlay bottom,
  // so a plain saturation-difference rule would false-positive — the smart vision
  // "single_photo" check is the backstop for other stitch types.)
  const grayHalf = (s) => s < 0.13;
  const colorHalf = (s) => s > 0.30;
  if ((grayHalf(fp.topSat) && colorHalf(fp.botSat)) || (grayHalf(fp.botSat) && colorHalf(fp.topSat))) {
    issues.push('looks like TWO different photos stitched (one half grayscale, one colour) — wrong layer filled');
  }
  return { ok: issues.length === 0, issues, hash: fp.hash };
}

function hamming(a, b) { let d = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) d++; return d; }

// ── layer 3: vision rubric (Sonnet) ──────────────────────────────
const VISION_SYSTEM = `You are a METICULOUS QA reviewer for AcroGym Qatar — a kids' gymnastics & acrobatics brand — checking ONE finished Instagram slide (photo + brand text overlay) before it can go live. Be strict on real quality problems; judge ONLY what you can see.
KNOW THE TEMPLATE (do NOT flag these as issues — they are intentional design):
- It is a CAROUSEL. The context says which slide ("slide 1/4" etc). Slide 1 is the COVER: short hook headline + an orange "BOOK A TRIAL" pill with a SEPARATE arrow beside it (the arrow sitting outside the pill is correct). The cover is just a hook — campaign details (dates, location like "Lagoona Mall"/"September") live on the INNER slides, so do NOT flag the cover for "missing details".
- Slides 2+ are INNER: a short headline + body text + the orange asterisk. They have NO CTA pill and NO arrow by design — do NOT flag inner slides for "missing CTA".
Reply with STRICT JSON ONLY (no prose), every field present:
{
 "single_photo": true|false,            // false if the slide shows 2+ different photos stitched/stacked/collaged
 "upright": true|false,                 // false if rotated/sideways/upside-down
 "faces_uncropped": true|false,         // false ONLY if the MAIN / foreground subject's face is cut off by the frame edge. In a WIDE establishing or action shot it is NORMAL for incidental people in the background or at the very edges to be clipped — do NOT fail for those; judge only the main subject(s) the slide is about.
 "text_not_on_face": true|false,        // false if overlay text covers a face
 "text_legible": true|false,            // false if low contrast / hard to read
 "text_complete": true|false,           // false if text is clipped or broken mid-word
 "text_fits": true|false,               // false if any text overflows its box or the CTA pill
 "cta_ok": true|false,                  // the CTA button text is a real short CTA, fits the pill (true if no CTA expected)
 "no_template_leftover": true|false,    // false if leftover template text remains (e.g. "meet the coach", "building skills together", "PASTE", lorem)
 "headline_present": true|false,
 "on_brand": true|false,                // true unless the slide is CLEARLY off-brand (totally wrong colour scheme / not the AcroGym look). Do NOT fail for subtle shade differences (e.g. cream looking slightly pale) — only obvious mismatches.
 "brand_colors_present": true|false,    // true if cream OR orange OR navy accents appear. Only false if NONE of the brand colours are present at all. Don't nitpick exact tones or a missing single colour.
 "asterisk_present": true|false,        // the orange star/asterisk mark is visible somewhere on the slide
 "child_safe": true|false,              // appropriate for a kids' brand
 "appropriate": true|false,             // nothing embarrassing/inappropriate in the photo
 "spelling_ok": true|false,             // false ONLY for a CLEAR, unmistakable misspelling actually visible IN the slide's overlay text. Read the text exactly as printed; do NOT invent errors and do NOT judge anything outside the visible text.
 "grammar_ok": true|false,              // false ONLY for a CLEAR grammatical mistake in the overlay text. Do NOT flag style, tone, formality, word choice, or capitalisation preferences — those are fine.
 "photo_sharp": true|false,             // not blurry/pixelated
 "subject_clear": true|false,           // main subject (kids/coach/action) clearly visible
 "good_contrast": true|false,           // text stands out from the background
 "duotone_consistent": true|false,      // photo treatment is uniform across the whole slide (no half-bw/half-colour)
 "issues": ["short concrete problem", ...] // [] if perfect
}`;

const VISION_FIELD_MSG = {
  single_photo: 'slide shows two different photos stitched together',
  upright: 'photo rotated/sideways',
  faces_uncropped: "the main subject's face is cropped by the frame",
  text_not_on_face: 'text covers a face',
  text_legible: 'text low-contrast / unreadable',
  text_complete: 'text clipped or broken mid-word',
  text_fits: 'text overflows its box / the CTA pill',
  cta_ok: 'CTA button text wrong or overflowing',
  no_template_leftover: 'leftover template text still on the slide',
  headline_present: 'headline missing',
  on_brand: 'off-brand look',
  brand_colors_present: 'brand colours missing',
  asterisk_present: 'brand asterisk missing',
  child_safe: 'not child-safe',
  appropriate: 'inappropriate content in photo',
  spelling_ok: 'spelling error in overlay text',
  grammar_ok: 'grammar error in overlay text',
  photo_sharp: 'photo blurry/pixelated',
  subject_clear: 'main subject not clear',
  good_contrast: 'poor text/background contrast',
  duotone_consistent: 'photo treatment inconsistent (half b/w, half colour)',
};

function parseJson(text) { try { const m = String(text).match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; } catch { return null; } }

async function checkVisual(buffer, { context = '' } = {}) {
  const base64 = Buffer.isBuffer(buffer) ? buffer.toString('base64') : buffer;
  const user = `Review this Instagram slide.${context ? ` Context: ${context}.` : ''} Return the full JSON verdict.`;
  let raw;
  try {
    raw = await generateText({ system: VISION_SYSTEM, user, images: [{ data: base64, media_type: 'image/png' }], maxTokens: 700, model: VISION_MODEL });
  } catch (err) { return { ok: false, issues: [`vision check unavailable: ${err.message}`], degraded: true }; }
  const v = parseJson(raw);
  if (!v) return { ok: false, issues: ['vision returned unparseable verdict'], degraded: true };
  const issues = [];
  for (const [field, msg] of Object.entries(VISION_FIELD_MSG)) {
    if (v[field] === false) issues.push(msg);
  }
  if (Array.isArray(v.issues)) for (const x of v.issues) if (x && !issues.some((i) => i.toLowerCase() === String(x).toLowerCase())) issues.push(x);
  return { ok: issues.length === 0, issues: [...new Set(issues)] };
}

// ── public: single slide ─────────────────────────────────────────
async function verifySlide(buffer, { context = '' } = {}) {
  const struct = await checkStructure(buffer);
  if (!struct.img) return { ok: false, issues: struct.issues, width: 0, height: 0, hash: null };
  const integ = checkIntegrity(struct.img);
  const visual = await checkVisual(buffer, { context });
  const issues = [...struct.issues, ...integ.issues, ...visual.issues];
  const ok = struct.ok && integ.ok && visual.ok;
  logger.info({ ok, issues, width: struct.width, height: struct.height }, 'slide verification');
  return { ok, issues, width: struct.width, height: struct.height, hash: integ.hash };
}

// ── public: whole carousel ───────────────────────────────────────
async function verifyCarousel(buffers, { context = '' } = {}) {
  const slides = [];
  for (let i = 0; i < buffers.length; i++) {
    slides.push(await verifySlide(buffers[i], { context: `${context} slide ${i + 1}/${buffers.length}` }));
  }
  const carousel = [];
  if (buffers.length < MIN_SLIDES) carousel.push(`too few slides (${buffers.length})`);
  if (buffers.length > MAX_SLIDES) carousel.push(`too many slides (${buffers.length} > ${MAX_SLIDES})`);
  const dims = new Set(slides.filter((s) => s.width).map((s) => `${s.width}x${s.height}`));
  if (dims.size > 1) carousel.push(`mixed slide sizes: ${[...dims].join(', ')}`);
  for (let i = 0; i < slides.length; i++) {
    for (let j = i + 1; j < slides.length; j++) {
      if (slides[i].hash && slides[j].hash && hamming(slides[i].hash, slides[j].hash) < 6) {
        carousel.push(`slides ${i + 1} & ${j + 1} look like the same photo`);
      }
    }
  }
  const ok = slides.every((s) => s.ok) && carousel.length === 0;
  return { ok, slides, carousel };
}

// ── public: caption ──────────────────────────────────────────────
function verifyCaption(caption) {
  const issues = [];
  const text = String(caption || '');
  if (!text.trim()) issues.push('empty caption');
  if (text.length > 2200) issues.push(`caption ${text.length} chars > IG limit 2200`);
  const tags = (text.match(/#[\w]+/g) || []);
  if (tags.length > 30) issues.push(`${tags.length} hashtags > IG limit 30`);
  if (PLACEHOLDER_RE.test(text)) issues.push('caption contains placeholder/template text');
  if (/[А-Яа-яЁё]/.test(text)) issues.push('caption contains Russian text (output must be English)');
  if (/ {3,}/.test(text)) issues.push('caption has odd spacing');
  return { ok: issues.length === 0, issues };
}

module.exports = {
  verifySlide, verifyCarousel, verifyCaption,
  checkStructure, checkIntegrity, checkVisual, fingerprint,
};

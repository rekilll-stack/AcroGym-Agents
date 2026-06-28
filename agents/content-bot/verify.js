'use strict';

/**
 * Self-verification (Agent 4 — autonomous posting).
 *
 * Bakes the owner's rule — "проверяй всё по 2 раза перед отправкой" — into code.
 * Nothing is shown for approval or auto-published until it passes these checks.
 *
 * LAYERS
 *  1) structure  — decodes, IG portrait 4:5, ≥1080px wide, sane file size.
 *  2) integrity  — not blank / near-uniform (catches broken/empty exports).
 *  3) visual(AI) — Claude vision rubric: upright, faces uncropped, text not on
 *                  faces, text legible/complete, on-brand, child-safe, no typos,
 *                  no leftover template placeholders.
 *  4) carousel   — consistent dimensions, 2–10 slides, no duplicate photos.
 *  5) caption    — length ≤ 2200, ≤ 30 hashtags, English, no placeholders.
 *
 * Returns { ok, issues[] }. Callers MUST NOT publish/show anything that fails.
 */

const { createCanvas, loadImage } = require('canvas');
const { generateText } = require('../../shared/claude');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('content-bot');

// Instagram portrait 1080×1350 (4:5 = 0.8).
const TARGET_RATIO = 1080 / 1350;
const RATIO_TOL = 0.03;
const MIN_WIDTH = 1080;
const MIN_BYTES = 20 * 1024;          // < 20 KB at 1080px ⇒ almost certainly broken
const MAX_BYTES = 25 * 1024 * 1024;   // 25 MB guard
const MIN_SLIDES = 1;                 // single image allowed; carousel ≥ 2
const MAX_SLIDES = 10;                // IG carousel hard limit
// Vision QA is mechanical pass/fail — run it on Haiku to keep per-post cost low.
const VISION_MODEL = process.env.CONTENT_VERIFY_MODEL || 'claude-haiku-4-5-20251001';
const PLACEHOLDER_RE = /\b(lorem ipsum|paste_|your text here|headline here|body here|xxxx+)\b/i;

// ── layer 1: structure ───────────────────────────────────────────
async function checkStructure(buffer) {
  const issues = [];
  if (!Buffer.isBuffer(buffer) || buffer.length < MIN_BYTES) {
    issues.push(`image too small (${buffer ? buffer.length : 0} bytes) — likely broken export`);
  }
  if (buffer && buffer.length > MAX_BYTES) issues.push(`image suspiciously large (${(buffer.length / 1e6).toFixed(1)} MB)`);
  let img;
  try {
    img = await loadImage(buffer);
  } catch (err) {
    return { ok: false, issues: [`undecodable image: ${err.message}`], width: 0, height: 0, img: null };
  }
  const ratio = img.width / img.height;
  if (Math.abs(ratio - TARGET_RATIO) > RATIO_TOL) issues.push(`aspect ratio ${ratio.toFixed(3)} ≠ 4:5 (${TARGET_RATIO.toFixed(3)})`);
  if (img.width < MIN_WIDTH) issues.push(`width ${img.width}px < IG min ${MIN_WIDTH}`);
  return { ok: issues.length === 0, issues, width: img.width, height: img.height, img };
}

// ── layer 2: integrity (blank / near-uniform detection) ──────────
// Downscale to N×N grayscale; compute luminance variance + average hash.
function fingerprint(img, n = 8) {
  const c = createCanvas(n, n);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, n, n);
  const { data } = ctx.getImageData(0, 0, n, n);
  const gray = [];
  for (let i = 0; i < data.length; i += 4) {
    gray.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }
  const mean = gray.reduce((a, b) => a + b, 0) / gray.length;
  const variance = gray.reduce((a, g) => a + (g - mean) ** 2, 0) / gray.length;
  const hash = gray.map((g) => (g >= mean ? '1' : '0')).join('');
  return { variance, hash };
}

function checkIntegrity(img) {
  const issues = [];
  const fp = fingerprint(img);
  if (fp.variance < 25) issues.push('image looks blank / near-uniform (broken export?)');
  return { ok: issues.length === 0, issues, hash: fp.hash };
}

function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) d++;
  return d;
}

// ── layer 3: visual (Claude vision) ──────────────────────────────
const VISION_SYSTEM = `You are a STRICT QA reviewer for AcroGym Qatar — a kids' gymnastics & acrobatics brand — checking ONE finished Instagram slide (photo + brand text overlay) before it goes live.
Judge ONLY what you can see. Reply with STRICT JSON, no prose:
{"upright":bool,"faces_ok":bool,"text_on_face":bool,"text_legible":bool,"text_complete":bool,"on_brand":bool,"child_safe":bool,"spelling_ok":bool,"has_placeholder":bool,"issues":[ "short reason", ... ]}
Definitions:
- upright=false → photo rotated/sideways/upside-down (people not vertical).
- faces_ok=false → any person's face cut off by the frame edge.
- text_on_face=true → overlay text covers someone's face.
- text_legible=false → low contrast / hard to read.
- text_complete=false → text is cut off at an edge or breaks mid-word badly.
- on_brand=false → not AcroGym look (missing the cream headline / orange accent vibe).
- child_safe=false → anything inappropriate for a kids' brand.
- spelling_ok=false → visible typo in the overlay text.
- has_placeholder=true → leftover template text like "PASTE", "headline", "Lorem".
If everything is fine: all booleans as above with no problems and "issues":[].`;

function parseJson(text) {
  try { const m = String(text).match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; } catch { return null; }
}

async function checkVisual(buffer, { context = '' } = {}) {
  const base64 = Buffer.isBuffer(buffer) ? buffer.toString('base64') : buffer;
  const user = `Review this Instagram slide.${context ? ` Context: ${context}.` : ''} Return the JSON verdict.`;
  let raw;
  try {
    raw = await generateText({ system: VISION_SYSTEM, user, images: [{ data: base64, media_type: 'image/png' }], maxTokens: 400, model: VISION_MODEL });
  } catch (err) {
    return { ok: false, issues: [`vision check unavailable: ${err.message}`], degraded: true };
  }
  const v = parseJson(raw);
  if (!v) return { ok: false, issues: ['vision returned unparseable verdict'], degraded: true };
  const issues = [];
  if (v.upright === false) issues.push('photo rotated/sideways');
  if (v.faces_ok === false) issues.push('a face is cropped by the frame');
  if (v.text_on_face === true) issues.push('text covers a face');
  if (v.text_legible === false) issues.push('text low-contrast / unreadable');
  if (v.text_complete === false) issues.push('text cut off / broken mid-word');
  if (v.on_brand === false) issues.push('off-brand look');
  if (v.child_safe === false) issues.push('not child-safe');
  if (v.spelling_ok === false) issues.push('visible typo in overlay text');
  if (v.has_placeholder === true) issues.push('leftover template placeholder text');
  if (Array.isArray(v.issues)) for (const x of v.issues) if (x && !issues.includes(x)) issues.push(x);
  return { ok: issues.length === 0, issues };
}

// ── public: single slide ─────────────────────────────────────────
async function verifySlide(buffer, { context = '' } = {}) {
  const struct = await checkStructure(buffer);
  if (!struct.img) {
    logger.warn({ issues: struct.issues }, 'slide failed to decode');
    return { ok: false, issues: struct.issues, width: 0, height: 0, hash: null };
  }
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
  // count limits
  if (buffers.length < MIN_SLIDES) carousel.push(`too few slides (${buffers.length})`);
  if (buffers.length > MAX_SLIDES) carousel.push(`too many slides (${buffers.length} > ${MAX_SLIDES})`);
  // dimension consistency
  const dims = new Set(slides.filter((s) => s.width).map((s) => `${s.width}x${s.height}`));
  if (dims.size > 1) carousel.push(`mixed slide sizes: ${[...dims].join(', ')}`);
  // duplicate-photo detection (perceptual aHash, hamming < 6 ⇒ basically same)
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
  if (PLACEHOLDER_RE.test(text)) issues.push('caption contains placeholder text');
  // brand rule: output language is English — flag Cyrillic leakage.
  if (/[А-Яа-яЁё]/.test(text)) issues.push('caption contains Russian text (output must be English)');
  return { ok: issues.length === 0, issues };
}

module.exports = {
  verifySlide, verifyCarousel, verifyCaption,
  checkStructure, checkIntegrity, checkVisual,
};

'use strict';

/**
 * Track D — branded image compositing engine (canvas).
 *
 * Layers: background PNG (Kirill's Canva export) → scrim (readability backing in
 * the text zone) → short headline text (Montserrat Black, brand color) → logo
 * overlay (logo.png, corner). Output: 1080×1080 PNG buffer.
 *
 * The image carries a SHORT hook (3-8 words), not a full post. Nothing is
 * published here — the buffer goes to the chat as a draft (Kirill posts by hand).
 */

const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage, registerFont } = require('canvas');

// Brand
const BLUE = '#28347F';
const ORANGE = '#F37021';
const WHITE = '#FFFFFF';
const CREAM = '#FBF1DF'; // off-white used for the IG-style headline + pill text
const SIZE = 1080;

const ROOT = path.join(__dirname, '../..');
const LOGO_PATH = path.join(ROOT, 'config/brand/logo.png');
const LOGO_WHITE_PATH = path.join(ROOT, 'config/brand/logo-white.png');
const FONT_BLACK = '/usr/share/fonts/truetype/montserrat/Montserrat-Black.ttf';
// Display font for the IG-style layout — Lilita One (OFL, bundled in the repo).
const FONT_LILITA = path.join(ROOT, 'config/brand/fonts/LilitaOne.ttf');

// Register the brand display fonts once.
let _fontReady = false;
function ensureFont() {
  if (_fontReady) return;
  try { registerFont(FONT_BLACK, { family: 'Montserrat Black' }); } catch { /* generic bold fallback */ }
  try { registerFont(FONT_LILITA, { family: 'Lilita One' }); } catch { /* IG style falls back to bold */ }
  _fontReady = true;
}

// ── Text helpers ──────────────────────────────────────────────

/** Word-wrap `text` to fit `maxWidth` at the current ctx.font. Returns lines. */
function wrapLines(ctx, text, maxWidth) {
  const words = String(text).trim().split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(test).width <= maxWidth || !cur) cur = test;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Pick the largest font size (within a range) at which `text` fits in maxWidth×
 * maxHeight as wrapped lines. Auto-fit so a short hook looks big, a longer one
 * shrinks rather than overflowing.
 */
function fitText(ctx, text, maxWidth, maxHeight, { max = 96, min = 40, lineGap = 1.18 } = {}) {
  for (let size = max; size >= min; size -= 2) {
    ctx.font = `${size}px "Montserrat Black"`;
    const lines = wrapLines(ctx, text, maxWidth);
    const h = lines.length * size * lineGap;
    if (h <= maxHeight) return { size, lines, lineGap };
  }
  ctx.font = `${min}px "Montserrat Black"`;
  return { size: min, lines: wrapLines(ctx, text, maxWidth), lineGap };
}

// ── Scrim variants (readability backing) ──────────────────────
// A zone object: { x, y, w, h } in px for where text sits.
function zoneFor(textZone) {
  if (textZone === 'center') return { x: 90, y: 360, w: SIZE - 180, h: 360 };
  if (textZone === 'band')   return { x: 0,  y: 430, w: SIZE,       h: 220 };
  return { x: 90, y: 660, w: SIZE - 180, h: 340 }; // bottom (default)
}

/**
 * Draw the readability scrim. Variants:
 *   'blue-gradient' — brand-blue fade from the text edge (soft, on-brand).
 *   'dark-band'     — solid dark bar behind the text (max contrast).
 *   'none'          — no scrim; rely on text contour/shadow only.
 */
function drawScrim(ctx, variant, textZone) {
  if (variant === 'none') return;
  if (variant === 'dark-band') {
    const z = zoneFor(textZone);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, z.y - 30, SIZE, z.h + 60);
    return;
  }
  // blue-gradient (default): brand blue at 55% fading up from the relevant edge.
  if (textZone === 'center') {
    ctx.fillStyle = 'rgba(40,52,127,0.55)';
    ctx.fillRect(0, 300, SIZE, 480);
    return;
  }
  const g = ctx.createLinearGradient(0, textZone === 'band' ? 380 : 560, 0, SIZE);
  g.addColorStop(0, 'rgba(40,52,127,0)');
  g.addColorStop(1, 'rgba(40,52,127,0.78)');
  ctx.fillStyle = g;
  ctx.fillRect(0, textZone === 'band' ? 380 : 520, SIZE, SIZE);
}

// Average relative luminance (0..1) of a canvas region. Used to auto-pick the
// logo variant so it never blends into the background.
function regionLuminance(ctx, x, y, w, h) {
  const sx = Math.max(0, Math.floor(x)), sy = Math.max(0, Math.floor(y));
  const sw = Math.max(1, Math.min(SIZE - sx, Math.ceil(w)));
  const sh = Math.max(1, Math.min(SIZE - sy, Math.ceil(h)));
  const data = ctx.getImageData(sx, sy, sw, sh).data;
  let sum = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    n++;
  }
  return n ? sum / n : 1;
}

// ── Logo overlay ──────────────────────────────────────────────
// Auto-picks the logo variant by sampling the brightness UNDER the logo:
//   bright corner → COLOURED logo.png (visible on light backgrounds)
//   dark corner   → logo-white.png    (visible on dark backgrounds)
async function drawLogo(ctx) {
  if (!fs.existsSync(LOGO_PATH)) return;
  const colored = await loadImage(LOGO_PATH);
  const target = 150; // px (long edge)
  const scale = target / Math.max(colored.width, colored.height);
  const w = colored.width * scale, h = colored.height * scale;
  const margin = 48;
  const x = SIZE - w - margin, y = margin; // top-right

  const lum = regionLuminance(ctx, x, y, w, h);
  let logo = colored;
  if (lum < 0.5 && fs.existsSync(LOGO_WHITE_PATH)) logo = await loadImage(LOGO_WHITE_PATH);

  ctx.globalAlpha = 1; // crisp, not faded
  ctx.drawImage(logo, x, y, w, h);
}

// ── Main composite (clean / default style) ────────────────────
/**
 * @param {object} p
 * @param {string} p.backgroundPath  absolute or repo-relative PNG path
 * @param {string} p.text            short headline (3-8 words)
 * @param {string} [p.textZone]      'bottom'|'center'|'band'
 * @param {string} [p.scrim]         'blue-gradient'|'dark-band'|'none'
 * @param {boolean} [p.logo]         overlay logo (default true)
 * @param {string} [p.style]         'clean' (default) | 'ig' (Instagram-style)
 * @returns {Promise<Buffer>} PNG
 */
async function composeBrandedImage({ backgroundPath, text, textZone = 'bottom', scrim = 'blue-gradient', logo = true, style = 'clean' } = {}) {
  if (style === 'ig') return composeIgImage({ backgroundPath, text, logo });

  ensureFont();
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');

  // 1) background (cover-fit)
  const bgAbs = path.isAbsolute(backgroundPath) ? backgroundPath : path.join(ROOT, backgroundPath);
  const bg = await loadImage(bgAbs);
  const scale = Math.max(SIZE / bg.width, SIZE / bg.height);
  const bw = bg.width * scale, bh = bg.height * scale;
  ctx.drawImage(bg, (SIZE - bw) / 2, (SIZE - bh) / 2, bw, bh);

  // 2) scrim
  drawScrim(ctx, scrim, textZone);

  // 3) logo (variant auto-selected by brightness under it)
  if (logo) await drawLogo(ctx);

  // 4) text — auto-fit + wrap, white with a soft contour/shadow for any background
  const z = zoneFor(textZone);
  const { size, lines, lineGap } = fitText(ctx, text, z.w, z.h);
  ctx.font = `${size}px "Montserrat Black"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = WHITE;
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 2;
  const totalH = lines.length * size * lineGap;
  let y = z.y + (z.h - totalH) / 2 + (size * lineGap) / 2;
  const cx = z.x + z.w / 2;
  for (const line of lines) { ctx.fillText(line, cx, y); y += size * lineGap; }
  // small orange underline accent under the block (brand touch)
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = ORANGE;
  const uw = Math.min(160, z.w * 0.4);
  ctx.fillRect(cx - uw / 2, y - size * 0.2, uw, 8);

  return canvas.toBuffer('image/png');
}

// ── IG-style composite ────────────────────────────────────────
// Funky Instagram look matching Kirill's feed: cream headline, left-aligned in
// the lower third (Lilita One), an orange asterisk accent, and an orange pill
// "Building skills together →" beneath it. Logo top-right.

/** Word-wrap at the current ctx.font, left-aligned. Returns lines. */
function wrapLinesLeft(ctx, text, maxWidth) {
  const words = String(text).trim().split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(test).width <= maxWidth || !cur) cur = test;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Auto-fit Lilita One headline into maxWidth × maxHeight. */
function fitTextLilita(ctx, text, maxWidth, maxHeight, { max = 132, min = 56, lineGap = 1.02 } = {}) {
  for (let size = max; size >= min; size -= 2) {
    ctx.font = `${size}px "Lilita One"`;
    const lines = wrapLinesLeft(ctx, text, maxWidth);
    const h = lines.length * size * lineGap;
    if (h <= maxHeight) return { size, lines, lineGap };
  }
  ctx.font = `${min}px "Lilita One"`;
  return { size: min, lines: wrapLinesLeft(ctx, text, maxWidth), lineGap };
}

/** Rounded-rectangle path helper. */
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Draw a small five-point orange asterisk/star at (cx, cy). */
function drawAsterisk(ctx, cx, cy, r, color = ORANGE) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(8, r * 0.34);
  ctx.lineCap = 'round';
  for (let i = 0; i < 5; i++) {
    const a = (Math.PI / 2) + (i * 2 * Math.PI / 5); // start at top, 5 spokes
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * r, cy - Math.sin(a) * r);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * @param {object} p
 * @param {string} p.backgroundPath  absolute or repo-relative PNG path
 * @param {string} p.text            short headline (3-8 words)
 * @param {string} [p.pill]          pill caption (default brand line)
 * @param {boolean} [p.logo]         overlay logo (default true)
 * @returns {Promise<Buffer>} PNG
 */
async function composeIgImage({ backgroundPath, text, pill = 'Building skills together', logo = true } = {}) {
  ensureFont();
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');

  // 1) background (cover-fit)
  const bgAbs = path.isAbsolute(backgroundPath) ? backgroundPath : path.join(ROOT, backgroundPath);
  const bg = await loadImage(bgAbs);
  const bgScale = Math.max(SIZE / bg.width, SIZE / bg.height);
  const bw = bg.width * bgScale, bh = bg.height * bgScale;
  ctx.drawImage(bg, (SIZE - bw) / 2, (SIZE - bh) / 2, bw, bh);

  // 2) readability scrim — soft dark fade rising from the bottom-left third
  const g = ctx.createLinearGradient(0, 470, 0, SIZE);
  g.addColorStop(0, 'rgba(20,24,55,0)');
  g.addColorStop(1, 'rgba(20,24,55,0.72)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 470, SIZE, SIZE - 470);

  // 3) logo (variant auto-selected by brightness under it)
  if (logo) await drawLogo(ctx);

  // Layout geometry
  const marginL = 72;
  const pillH = 64;
  const pillBottom = SIZE - 96;          // pill sits near the bottom
  const blockMaxW = SIZE - marginL - 96; // headline wrap width

  // 4) headline — cream, left-aligned, sitting just above the pill
  const headMaxH = 460;
  const { size, lines, lineGap } = fitTextLilita(ctx, text, blockMaxW, headMaxH);
  ctx.font = `${size}px "Lilita One"`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = CREAM;
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 16;
  ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 3;
  const lineH = size * lineGap;
  const blockH = lines.length * lineH;
  const headBaselineTop = pillBottom - pillH - 36; // gap above the pill
  let by = headBaselineTop - blockH + size;        // first baseline
  // remember the top of the headline block for the asterisk
  const blockTopY = by - size;
  for (const line of lines) { ctx.fillText(line, marginL, by); by += lineH; }
  ctx.shadowColor = 'transparent';

  // 5) orange asterisk accent — top-right of the headline block
  const astR = Math.min(46, size * 0.42);
  drawAsterisk(ctx, SIZE - 110, blockTopY + astR + 6, astR);

  // 6) orange pill with cream caption + arrow
  ctx.font = '30px "Lilita One"';
  const label = String(pill).toUpperCase();
  const labelW = ctx.measureText(label).width;
  const padX = 30;
  const arrowGap = 22;
  const arrowLen = 34;
  const pillW = padX * 2 + labelW + arrowGap + arrowLen;
  const pillY = pillBottom - pillH;
  roundRect(ctx, marginL, pillY, pillW, pillH, pillH / 2);
  ctx.fillStyle = ORANGE;
  ctx.fill();
  // caption
  ctx.fillStyle = CREAM;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, marginL + padX, pillY + pillH / 2 + 2);
  // arrow
  const ax = marginL + padX + labelW + arrowGap;
  const ayc = pillY + pillH / 2;
  ctx.strokeStyle = CREAM;
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(ax, ayc);
  ctx.lineTo(ax + arrowLen, ayc);
  ctx.moveTo(ax + arrowLen - 12, ayc - 10);
  ctx.lineTo(ax + arrowLen, ayc);
  ctx.lineTo(ax + arrowLen - 12, ayc + 10);
  ctx.stroke();

  return canvas.toBuffer('image/png');
}

// Read the backgrounds manifest (non-dev entries are user-selectable).
function loadManifest() {
  const p = path.join(ROOT, 'config/brand/backgrounds/backgrounds.json');
  try {
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(m.backgrounds) ? m.backgrounds : [];
  } catch { return []; }
}

module.exports = { composeBrandedImage, composeIgImage, loadManifest, zoneFor, wrapLines, fitText, SIZE };

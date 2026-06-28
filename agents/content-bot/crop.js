'use strict';

/**
 * Pre-crop photos to the slide's 4:5 frame BEFORE they go to Canva.
 *
 * Why: when Canva fills a 4:5 element with a wide/portrait photo it crops on
 * its own — blindly, often cutting the main subject's face. Instead we crop to
 * an exact 1080×1350 (4:5) here, CENTRED on where the people/faces are (one cheap
 * vision call per photo), so Canva receives an already-4:5 image and has nothing
 * left to cut. Result: faces stay in frame, and verify only ever sees real crops.
 *
 * Also fixes EXIF orientation (node-canvas ignores it — that was the old
 * sideways-photo bug), so phone portraits don't come out rotated.
 */

const { createCanvas, loadImage } = require('canvas');
const { generateText } = require('../../shared/claude');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('content-bot');

const CROP_MODEL = process.env.CONTENT_CROP_MODEL || 'claude-haiku-4-5-20251001';
const TARGET_W = 1080;
const TARGET_H = 1350; // 4:5
const TARGET_RATIO = TARGET_W / TARGET_H; // 0.8

const FOCUS_SYSTEM = `You position the crop for an Instagram 4:5 vertical slide. You see one photo. The slide will be a 4:5 crop CENTRED on a single point — so pick the point that keeps the most important people / faces / action inside the frame.
Reply STRICT JSON ONLY, no prose: {"focus_x":0..1,"focus_y":0..1} — fractions of the image width/height marking the centre of the key subject(s). Aim at the people and their FACES (usually slightly above the vertical middle), not empty floor or ceiling. If subjects are spread out, aim at the densest cluster of faces.`;

const clamp01 = (n) => Math.max(0, Math.min(1, n));
function parseJson(t) { try { const m = String(t).match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; } catch { return null; } }

// ── EXIF orientation (1..8) from a JPEG buffer; 1/none = upright ──
function readOrientation(buf) {
  try {
    if (buf[0] !== 0xFF || buf[1] !== 0xD8) return 1; // not JPEG
    let o = 2;
    while (o < buf.length) {
      if (buf[o] !== 0xFF) break;
      const marker = buf[o + 1];
      const len = buf.readUInt16BE(o + 2);
      if (marker === 0xE1 && buf.toString('ascii', o + 4, o + 8) === 'Exif') {
        const tiff = o + 10;
        const le = buf.toString('ascii', tiff, tiff + 2) === 'II';
        const u16 = (p) => (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p));
        const u32 = (p) => (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p));
        const ifd0 = tiff + u32(tiff + 4);
        const n = u16(ifd0);
        for (let i = 0; i < n; i++) {
          const e = ifd0 + 2 + i * 12;
          if (u16(e) === 0x0112) return u16(e + 8) || 1;
        }
        return 1;
      }
      o += 2 + len;
    }
  } catch { /* fall through */ }
  return 1;
}

// Draw an Image onto a new canvas with EXIF orientation applied; returns the
// upright canvas (usable as a drawImage source).
function uprightCanvas(img, orientation) {
  if (!orientation || orientation === 1) {
    const c = createCanvas(img.width, img.height);
    c.getContext('2d').drawImage(img, 0, 0);
    return c;
  }
  const swap = orientation >= 5;
  const cw = swap ? img.height : img.width;
  const ch = swap ? img.width : img.height;
  const c = createCanvas(cw, ch);
  const ctx = c.getContext('2d');
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0, 1, img.width, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, img.width, img.height); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, img.height); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, img.height, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, img.height, img.width); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, img.width); break;
    default: break;
  }
  ctx.drawImage(img, 0, 0);
  return c;
}

// Ask where the key subjects are (cheap: a downscaled preview). Falls back to a
// sensible point (centre, slightly high for faces) on any failure.
async function focalPoint(srcCanvas) {
  try {
    const sw = 480;
    const sh = Math.max(1, Math.round((srcCanvas.height * sw) / srcCanvas.width));
    const small = createCanvas(sw, sh);
    small.getContext('2d').drawImage(srcCanvas, 0, 0, sw, sh);
    const b64 = small.toBuffer('image/jpeg', { quality: 0.7 }).toString('base64');
    const raw = await generateText({
      system: FOCUS_SYSTEM,
      user: 'Where is the key subject? Return the JSON.',
      images: [{ data: b64, media_type: 'image/jpeg' }],
      maxTokens: 60,
      model: CROP_MODEL,
    });
    const v = parseJson(raw);
    if (v && typeof v.focus_x === 'number' && typeof v.focus_y === 'number') {
      return { x: clamp01(v.focus_x), y: clamp01(v.focus_y), from: 'vision' };
    }
  } catch (err) { logger.warn({ err: err.message }, 'crop focal point failed → centre fallback'); }
  return { x: 0.5, y: 0.42, from: 'fallback' };
}

/**
 * Crop a photo buffer to an exact 1080×1350 (4:5) image centred on the people.
 * @param {Buffer} buffer source photo
 * @returns {Promise<Buffer>} JPEG buffer, 1080×1350
 */
async function safeCrop45(buffer) {
  const orientation = readOrientation(buffer);
  const img = await loadImage(buffer);
  const src = uprightCanvas(img, orientation);
  const W = src.width, H = src.height;

  // Largest 4:5 window that fits inside the (upright) image.
  let cw, ch;
  if (W / H > TARGET_RATIO) { ch = H; cw = Math.round(ch * TARGET_RATIO); } // wide → crop sides
  else { cw = W; ch = Math.round(cw / TARGET_RATIO); }                      // tall → crop top/bottom

  const f = await focalPoint(src);
  let cx = Math.round(f.x * W - cw / 2);
  let cy = Math.round(f.y * H - ch / 2);
  cx = Math.max(0, Math.min(W - cw, cx));
  cy = Math.max(0, Math.min(H - ch, cy));

  const out = createCanvas(TARGET_W, TARGET_H);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  if ('patternQuality' in ctx) ctx.patternQuality = 'best';
  ctx.drawImage(src, cx, cy, cw, ch, 0, 0, TARGET_W, TARGET_H);
  const result = out.toBuffer('image/jpeg', { quality: 0.92 });
  logger.info({ orientation, src: `${W}x${H}`, focus: f.from, fx: f.x, fy: f.y }, 'photo pre-cropped to 4:5');
  return result;
}

module.exports = { safeCrop45, readOrientation };

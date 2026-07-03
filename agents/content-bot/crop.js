'use strict';

/**
 * Pre-crop photos to the slide's 4:5 frame BEFORE they go to Canva.
 *
 * Why: when Canva fills a 4:5 element with a wide/portrait photo it crops on its
 * own — blindly, often cutting the subject. Instead we crop to an exact 1080×1350
 * (4:5) here, FULL-BLEED, centred on the MAIN subject (one cheap vision call
 * gives the focal point), so Canva receives an already-4:5 image and has nothing
 * left to cut. The subject stays in frame; a distant bystander at the very edge
 * may be clipped (owner chose full-bleed, no letterbox bars).
 *
 * Also fixes EXIF orientation (node-canvas ignores it — that was the old
 * sideways-photo bug), so phone portraits don't come out rotated.
 */

const { createCanvas, loadImage } = require('canvas');
const { generateText } = require('./llm');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('content-bot');

const CROP_MODEL = process.env.CONTENT_CROP_MODEL || 'claude-haiku-4-5-20251001';

const FOCUS_SYSTEM = `You mark the MAIN SUBJECT for an Instagram crop. You see one photo.
The main subject is the FOREGROUND, in-focus, active person the photo is about — the child performing / training / posing / receiving a medal, together with the coach if they are physically interacting. It is NOT the blurry seated spectators or people in the background.
Return the TIGHT BOUNDING BOX around the main subject's WHOLE BODY — head to toes, including extended arms and legs (a handstand includes the feet up top; a bridge includes both hands and feet on the mat).
Reply STRICT JSON ONLY, no prose: {"x0":0..1,"y0":0..1,"x1":0..1,"y1":0..1} as fractions of image width/height (x0<x1, y0<y1).`;

const clamp01 = (n) => Math.max(0, Math.min(1, n));

// Take the first balanced {...} object (model sometimes appends a second one).
function parseJson(text) {
  const s = String(text);
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

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

// Vision bounding box of the MAIN subject's whole body (cheap: a downscaled
// preview). Falls back to a generous centre box on any failure.
async function subjectBox(srcCanvas) {
  try {
    const sw = 480;
    const sh = Math.max(1, Math.round((srcCanvas.height * sw) / srcCanvas.width));
    const small = createCanvas(sw, sh);
    small.getContext('2d').drawImage(srcCanvas, 0, 0, sw, sh);
    const b64 = small.toBuffer('image/jpeg', { quality: 0.7 }).toString('base64');
    const raw = await generateText({
      system: FOCUS_SYSTEM,
      user: 'Bounding box of the main subject? Return the JSON.',
      images: [{ data: b64, media_type: 'image/jpeg' }],
      maxTokens: 80,
      model: CROP_MODEL,
    });
    const v = parseJson(raw);
    if (v && [v.x0, v.y0, v.x1, v.y1].every((n) => typeof n === 'number') && v.x1 > v.x0 && v.y1 > v.y0) {
      return { x0: clamp01(v.x0), y0: clamp01(v.y0), x1: clamp01(v.x1), y1: clamp01(v.y1), from: 'vision' };
    }
  } catch (err) { logger.warn({ err: err.message }, 'crop subject box failed → centre fallback'); }
  return { x0: 0.2, y0: 0.1, x1: 0.8, y1: 0.9, from: 'fallback' };
}

/**
 * Crop a photo buffer to an exact targetW×targetH FULL-BLEED image that
 * CONTAINS the main subject's whole body when geometrically possible.
 * @returns {Promise<{buffer: Buffer, covered: boolean}>} covered=false means the
 * body cannot fit a window of this ratio (caller should prefer another photo).
 */
async function cropToRatio(buffer, targetW, targetH) {
  const ratio = targetW / targetH;
  const orientation = readOrientation(buffer);
  const img = await loadImage(buffer);
  // node-canvas's loadImage ALREADY applies EXIF orientation (the decoded image
  // is upright). Rotating again here double-rotated 90°/270° photos (orientation
  // 6/8) and laid them on their side. So draw the image as-is.
  const src = createCanvas(img.width, img.height);
  src.getContext('2d').drawImage(img, 0, 0);
  const W = src.width, H = src.height;

  // Largest window of the target ratio that fits the image (full height if the
  // image is wider than the target, full width if taller).
  let cw, ch;
  if (W / H > ratio) { ch = H; cw = Math.round(ch * ratio); }
  else { cw = W; ch = Math.round(cw / ratio); }

  // Position the window to CONTAIN the subject's body box (centre on the box,
  // then clamp inside the image). If the box is bigger than the window on some
  // axis, full coverage is impossible — report covered=false so the caller can
  // swap the photo instead of shipping an amputated crop.
  const b = await subjectBox(src);
  const bx0 = b.x0 * W, bx1 = b.x1 * W, by0 = b.y0 * H, by1 = b.y1 * H;
  let cx = Math.round((bx0 + bx1) / 2 - cw / 2);
  let cy = Math.round((by0 + by1) / 2 - ch / 2);
  cx = Math.max(0, Math.min(W - cw, cx));
  cy = Math.max(0, Math.min(H - ch, cy));
  // 2% tolerance: a sliver of a hand at the very edge is not an amputation.
  const tolX = 0.02 * cw, tolY = 0.02 * ch;
  const covered = b.from !== 'vision'
    || (bx0 >= cx - tolX && bx1 <= cx + cw + tolX && by0 >= cy - tolY && by1 <= cy + ch + tolY);

  const out = createCanvas(targetW, targetH);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  if ('patternQuality' in ctx) ctx.patternQuality = 'best';
  ctx.drawImage(src, cx, cy, cw, ch, 0, 0, targetW, targetH);
  logger.info({ orientation, src: `${W}x${H}`, target: `${targetW}x${targetH}`, box: b.from, covered, crop: `${cw}x${ch}@${cx},${cy}` }, 'photo pre-cropped (full-bleed)');
  return { buffer: out.toBuffer('image/jpeg', { quality: 0.92 }), covered };
}

// 4:5 carousel slide (1080×1350).
const safeCrop45 = (buffer) => cropToRatio(buffer, 1080, 1350);
// 9:16 story (1080×1920).
const safeCrop916 = (buffer) => cropToRatio(buffer, 1080, 1920);

module.exports = { safeCrop45, safeCrop916, cropToRatio, readOrientation };

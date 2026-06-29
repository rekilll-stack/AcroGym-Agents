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

const FOCUS_SYSTEM = `You place the crop for an Instagram vertical slide. You see one photo. The slide will be a vertical crop CENTRED on a single point — pick the point on the MAIN SUBJECT so it stays nicely in frame.
The main subject is the FOREGROUND, in-focus, active person the photo is about — the child performing / training / posing / receiving a medal, or the coach with them. It is NOT the blurry seated spectators or people in the background; ignore them when choosing the point.
Aim at the centre of that main subject — roughly their torso/face, usually a bit above the vertical middle.
Reply STRICT JSON ONLY, no prose: {"focus_x":0..1,"focus_y":0..1} as fractions of the image width/height.`;

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

// Vision focal point of the MAIN subject (cheap: a downscaled preview). Falls
// back to centre, slightly high (faces), on any failure.
async function focalPoint(srcCanvas) {
  try {
    const sw = 480;
    const sh = Math.max(1, Math.round((srcCanvas.height * sw) / srcCanvas.width));
    const small = createCanvas(sw, sh);
    small.getContext('2d').drawImage(srcCanvas, 0, 0, sw, sh);
    const b64 = small.toBuffer('image/jpeg', { quality: 0.7 }).toString('base64');
    const raw = await generateText({
      system: FOCUS_SYSTEM,
      user: 'Where is the main subject? Return the JSON.',
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
 * Crop a photo buffer to an exact targetW×targetH FULL-BLEED image centred on
 * the main subject. @returns {Promise<Buffer>} JPEG.
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
  // image is wider than the target, full width if taller), positioned so its
  // centre sits on the subject's focal point.
  let cw, ch;
  if (W / H > ratio) { ch = H; cw = Math.round(ch * ratio); }
  else { cw = W; ch = Math.round(cw / ratio); }
  const f = await focalPoint(src);
  let cx = Math.round(f.x * W - cw / 2);
  let cy = Math.round(f.y * H - ch / 2);
  cx = Math.max(0, Math.min(W - cw, cx));
  cy = Math.max(0, Math.min(H - ch, cy));

  const out = createCanvas(targetW, targetH);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  if ('patternQuality' in ctx) ctx.patternQuality = 'best';
  ctx.drawImage(src, cx, cy, cw, ch, 0, 0, targetW, targetH);
  logger.info({ orientation, src: `${W}x${H}`, target: `${targetW}x${targetH}`, focus: f.from, crop: `${cw}x${ch}@${cx},${cy}` }, 'photo pre-cropped (full-bleed)');
  return out.toBuffer('image/jpeg', { quality: 0.92 });
}

// 4:5 carousel slide (1080×1350).
const safeCrop45 = (buffer) => cropToRatio(buffer, 1080, 1350);
// 9:16 story (1080×1920).
const safeCrop916 = (buffer) => cropToRatio(buffer, 1080, 1920);

module.exports = { safeCrop45, safeCrop916, cropToRatio, readOrientation };

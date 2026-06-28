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

const PEOPLE_SYSTEM = `You are a person detector. Look at the photo and return a tight bounding box for EVERY person visible — children, coaches, adults, spectators — including ones only partially in frame.
Reply STRICT JSON ONLY, no prose: {"people":[{"x":0..1,"y":0..1,"w":0..1,"h":0..1}, ...]} where x,y = the box's TOP-LEFT corner and w,h = its width/height, all as fractions of the image. Mark "main":true on the box(es) that are the clear main subject(s) of the photo (closest / most prominent). If no people, return {"people":[]}.`;

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

// Detect every person's bounding box (cheap: a downscaled preview).
async function detectPeople(srcCanvas) {
  try {
    const sw = 512;
    const sh = Math.max(1, Math.round((srcCanvas.height * sw) / srcCanvas.width));
    const small = createCanvas(sw, sh);
    small.getContext('2d').drawImage(srcCanvas, 0, 0, sw, sh);
    const b64 = small.toBuffer('image/jpeg', { quality: 0.72 }).toString('base64');
    const raw = await generateText({
      system: PEOPLE_SYSTEM,
      user: 'Return bounding boxes for every person. JSON only.',
      images: [{ data: b64, media_type: 'image/jpeg' }],
      maxTokens: 500,
      model: CROP_MODEL,
    });
    const v = parseJson(raw);
    if (v && Array.isArray(v.people)) {
      return v.people
        .filter((p) => p && typeof p.x === 'number' && typeof p.w === 'number' && p.w > 0 && p.h > 0)
        .map((p) => ({ x: clamp01(p.x), y: clamp01(p.y), w: clamp01(p.w), h: clamp01(p.h), main: !!p.main }));
    }
  } catch (err) { logger.warn({ err: err.message }, 'people detection failed → centre fallback'); }
  return null;
}

/**
 * Deterministically choose a 4:5 crop window (px) that does NOT slice any person.
 * Tries a few zoom levels; for each, slides the window and scores: heavily
 * penalise people cut by an edge, reward whole people kept (esp. the main ones),
 * lightly prefer centred. Returns {x0,y0,cw,ch,sliced,from}.
 */
function chooseWindow(W, H, people) {
  const ratio = TARGET_RATIO;
  const wide = W / H > ratio;

  // candidate window sizes (full-fit first, then progressively zoomed in)
  const sizes = [];
  for (const z of [1, 0.85, 0.72, 0.6, 0.5]) {
    let cw, ch;
    if (wide) { ch = Math.round(H * z); cw = Math.round(ch * ratio); }
    else { cw = Math.round(W * z); ch = Math.round(cw / ratio); }
    if (cw >= 80 && ch >= 100 && cw <= W && ch <= H) sizes.push({ cw, ch });
  }
  if (!sizes.length) sizes.push(wide ? { cw: Math.round(H * ratio), ch: H } : { cw: W, ch: Math.round(W / ratio) });

  // Safety margin (vision boxes are imprecise) — a person near an edge counts as
  // straddling, so the window must clear people with a real gap. The main-subject
  // scoring below stops this from zooming into empty floor.
  const mx = 0.04 * W, my = 0.04 * H;
  const boxes = (people || []).map((p) => ({
    x0: p.x * W - mx, y0: p.y * H - my, x1: (p.x + p.w) * W + mx, y1: (p.y + p.h) * H + my,
    area: p.w * p.h, main: p.main,
  }));

  // MAIN = the foreground subjects that MUST be kept whole. Use the detector's
  // flag; if it marked none, treat the biggest boxes (closest/foreground) as main.
  let mains = boxes.filter((b) => b.main);
  if (!mains.length && boxes.length) {
    const sorted = [...boxes].sort((a, b) => b.area - a.area);
    mains = sorted.slice(0, Math.max(1, Math.round(sorted.length * 0.34)));
  }
  const isMain = new Set(mains);

  let best = null;
  for (const { cw, ch } of sizes) {
    const stepsX = 72, stepsY = 36;
    const xMax = W - cw, yMax = H - ch;
    for (let i = 0; i <= stepsX; i++) {
      const x0 = Math.round((xMax * i) / stepsX);
      const x1 = x0 + cw;
      for (let j = 0; j <= stepsY; j++) {
        const y0 = Math.round((yMax * j) / stepsY);
        const y1 = y0 + ch;
        let mainKept = 0, mainSliced = 0, mainOut = 0, bgSliced = 0, kept = 0;
        for (const b of boxes) {
          const fullyIn = b.x0 >= x0 && b.x1 <= x1 && b.y0 >= y0 && b.y1 <= y1;
          const fullyOut = b.x1 <= x0 || b.x0 >= x1 || b.y1 <= y0 || b.y0 >= y1;
          const main = isMain.has(b);
          if (fullyIn) { kept += b.area; if (main) mainKept += b.area; }
          else if (!fullyOut) { bgSliced++; if (main) { mainSliced++; } }
          else if (main) { mainOut++; }
        }
        const sizeFrac = (cw * ch) / (W * H);
        const centerPenalty = Math.abs((x0 + cw / 2) - W / 2) / W + Math.abs((y0 + ch / 2) - H / 2) / H;
        // Priorities: keep MAIN subjects whole & present > don't slice mains >
        // don't drop mains > keep more people > avoid bg slices > wider > centred.
        const score = mainKept * 1000
          - mainSliced * 6000
          - mainOut * 2500
          + kept * 150
          - bgSliced * 250
          + sizeFrac * 140
          - centerPenalty * 8;
        if (!best || score > best.score) best = { score, x0, y0, cw, ch, sliced: mainSliced + bgSliced, slicedMain: mainSliced };
      }
    }
  }
  return best;
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

  // Detect people, then pick a 4:5 window whose edges don't slice anyone.
  const people = await detectPeople(src);
  let cx, cy, cw, ch, from;
  const win = chooseWindow(W, H, people);
  if (people && win) {
    ({ x0: cx, y0: cy, cw, ch } = win);
    from = `boxes(${people.length},sliced=${win.sliced})`;
  } else {
    // Fallback: widest 4:5 keeping full height (or width), centred.
    if (W / H > TARGET_RATIO) { ch = H; cw = Math.round(ch * TARGET_RATIO); }
    else { cw = W; ch = Math.round(cw / TARGET_RATIO); }
    cx = Math.round((W - cw) / 2);
    cy = Math.round((H - ch) * 0.35); // bias up a touch for faces
    from = 'fallback-centre';
  }

  const out = createCanvas(TARGET_W, TARGET_H);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  if ('patternQuality' in ctx) ctx.patternQuality = 'best';
  ctx.drawImage(src, cx, cy, cw, ch, 0, 0, TARGET_W, TARGET_H);
  const result = out.toBuffer('image/jpeg', { quality: 0.92 });
  logger.info({ orientation, src: `${W}x${H}`, from, crop: `${cw}x${ch}@${cx},${cy}` }, 'photo pre-cropped to 4:5');
  return result;
}

module.exports = { safeCrop45, readOrientation };

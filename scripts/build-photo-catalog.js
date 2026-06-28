'use strict';

/**
 * Build a photo catalog for the content-bot's autonomous posting.
 *
 * Analyses EVERY real photo in the AcroGym Marketing library ONCE (cheap Haiku
 * vision on the small preview) and records, per photo: what it shows, whether it
 * is one clear subject vs a crowd, how well it crops to a vertical 4:5, quality,
 * whether the face reads well, joyfulness, a short caption, the aspect ratio, and
 * a perceptual hash (to dedupe near-identical burst frames later).
 *
 * Selection (photos.js) then picks from PRE-VETTED good photos by topic instead
 * of sampling random thumbnails — the fix for "random/crowded/cut" photos.
 *
 * Run:  node scripts/build-photo-catalog.js
 * Output: data/photo-catalog.json  (incremental — safe to re-run / resume)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');
const yandex = require('../agents/content-bot/yandex');
const { generateText } = require('../shared/claude');

const MODEL = process.env.CONTENT_CATALOG_MODEL || 'claude-haiku-4-5-20251001';
const OUT = path.join(__dirname, '..', 'data', 'photo-catalog.json');
const FOLDERS = [
  '/AcroGym/Marketing/Photos/Competitions May 2025',
  '/AcroGym/Marketing/AcroGym Competiton 2026',
];
const CONCURRENCY = 6;

const SYSTEM = `You catalogue ONE photo for an AcroGym (kids' gymnastics & acrobatics, Doha) Instagram photo library. The photo may later become a FULL-BLEED vertical 4:5 slide with brand text over the bottom third.
Return STRICT JSON ONLY, no prose, all fields present:
{
 "subject": "single_child" | "two_children" | "small_group" | "crowd" | "coach_with_child" | "coach" | "object" | "facility" | "other",
 "tags": ["up to 6 short snake_case keywords of what is shown, e.g. medal, podium, balance_beam, air_track, stretching, handstand, cartwheel, running, gym_hall, balloons, certificate, trophy, group_warmup, parent"],
 "vertical_crop": 0.0-1.0,  // how well it crops to a TALL 4:5 keeping the MAIN subject whole and filling the frame. HIGH ~1 = ONE clear subject (or tight pair) with space around them, or a naturally tall composition. LOW ~0 = people spread across the FULL WIDTH, or the key content only reads as a wide shot.
 "quality": 0.0-1.0,        // sharpness + lighting + composition — is it a genuinely nice photo
 "faces_ok": true|false,    // the main subject's face is clearly visible and pleasant (not blurry, not turned fully away, not mid-blink)
 "joyful": true|false,      // positive, energetic, warm, smiling vibe
 "caption": "one short factual sentence describing the photo"
}
Be HONEST and strict: give crowded/messy/blurry/dark shots low quality and low vertical_crop.`;

function parseJson(text) {
  const s = String(text); const a = s.indexOf('{');
  if (a < 0) return null;
  let d = 0;
  for (let i = a; i < s.length; i++) {
    if (s[i] === '{') d++;
    else if (s[i] === '}') { d--; if (d === 0) { try { return JSON.parse(s.slice(a, i + 1)); } catch { return null; } } }
  }
  return null;
}

// 8x8 average perceptual hash from an image buffer (hex string).
async function aHash(buf) {
  try {
    const img = await loadImage(buf);
    const c = createCanvas(8, 8); const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, 8, 8);
    const d = ctx.getImageData(0, 0, 8, 8).data;
    const g = [];
    for (let i = 0; i < 64; i++) g.push((d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3);
    const avg = g.reduce((a, b) => a + b, 0) / 64;
    let bits = '';
    for (const v of g) bits += v >= avg ? '1' : '0';
    let hex = '';
    for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return { hash: hex, ratio: img.width / img.height };
  } catch { return { hash: null, ratio: null }; }
}

async function analyse(item) {
  const buf = await yandex.fetchPreview(item.preview);
  const { hash, ratio } = await aHash(buf);
  const raw = await generateText({
    system: SYSTEM,
    user: 'Catalogue this photo. JSON only.',
    images: [{ data: buf.toString('base64'), media_type: 'image/jpeg' }],
    maxTokens: 300,
    model: MODEL,
  });
  const v = parseJson(raw) || {};
  return {
    path: item.path,
    name: item.name,
    folder: item.path.split('/').slice(-2, -1)[0],
    ratio: ratio ? Number(ratio.toFixed(3)) : null,
    phash: hash,
    subject: v.subject || 'other',
    tags: Array.isArray(v.tags) ? v.tags.slice(0, 6) : [],
    vertical_crop: typeof v.vertical_crop === 'number' ? v.vertical_crop : 0,
    quality: typeof v.quality === 'number' ? v.quality : 0,
    faces_ok: !!v.faces_ok,
    joyful: !!v.joyful,
    caption: String(v.caption || '').slice(0, 200),
  };
}

async function pool(items, n, worker, onProgress) {
  const out = new Array(items.length);
  let idx = 0, done = 0;
  async function run() {
    while (idx < items.length) {
      const i = idx++;
      try { out[i] = await worker(items[i], i); }
      catch (err) { out[i] = { path: items[i].path, name: items[i].name, error: err.message }; }
      done++;
      if (onProgress && done % 10 === 0) onProgress(done, items.length, out.filter(Boolean));
    }
  }
  await Promise.all(Array.from({ length: n }, run));
  return out;
}

(async () => {
  // resume support: keep already-catalogued paths
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(OUT, 'utf8')).photos || []; } catch {}
  const havePaths = new Set(existing.map((p) => p.path));

  let all = [];
  for (const f of FOLDERS) {
    try {
      const imgs = await yandex.listImages(f, { limit: 500, previewSize: 'M' });
      all.push(...imgs.filter((i) => i.preview));
    } catch (err) { console.error('list fail', f, err.message); }
  }
  const todo = all.filter((i) => !havePaths.has(i.path));
  console.log(`library=${all.length} already=${existing.length} todo=${todo.length}`);

  const save = (photos) => fs.writeFileSync(OUT, JSON.stringify({ built: new Date().toISOString(), count: photos.length, photos }, null, 2));

  const fresh = await pool(todo, CONCURRENCY, analyse, (d, t, partial) => {
    console.log(`  ${d}/${t}`);
    save([...existing, ...partial.filter((x) => x && !x.error)]);
  });

  const photos = [...existing, ...fresh.filter((x) => x && !x.error)];
  save(photos);
  const errs = fresh.filter((x) => x && x.error).length;
  const good = photos.filter((p) => p.quality >= 0.6 && p.vertical_crop >= 0.55).length;
  console.log(`DONE: catalogued=${photos.length} errors=${errs} | crop-friendly&good=${good}`);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });

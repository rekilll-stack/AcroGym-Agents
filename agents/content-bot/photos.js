'use strict';

/**
 * Smart photo selection (Agent 4 — autonomous posting).
 *
 * Random picking gave junk shots and faces cropped by the 4:5 frame. Instead:
 *  1) list many candidates with Yandex PREVIEW thumbnails (cheap — no 7 MB pulls);
 *  2) one vision call ranks them for an IG carousel where each photo becomes a
 *     full-bleed 4:5 slide with text overlaid at the BOTTOM — so we want sharp,
 *     joyful kids/coaches, faces fully visible and roughly centred (NOT at the
 *     edges, or the crop/text will cut them);
 *  3) download FULL-RES only for the chosen ones (+ a couple of backups).
 *
 * Selection runs on a smarter model (it's the main quality lever); building +
 * verify stay cheap so the whole post fits the owner's $0.5 budget.
 */

const yandex = require('./yandex');
const { generateText } = require('../../shared/claude');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('content-bot');

const SELECT_MODEL = process.env.CONTENT_SELECT_MODEL || 'claude-sonnet-4-6';
const CANDIDATE_FOLDERS = [
  '/AcroGym/Marketing/AcroGym Competiton 2026',
  yandex.MARKETING,
];

// Spread a sample across a big list so we don't always see the same first shots.
function sample(arr, n) {
  if (arr.length <= n) return arr.slice();
  const step = arr.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

const SELECT_SYSTEM = `You curate photos for AcroGym Qatar (kids' gymnastics) Instagram carousels. Each chosen photo becomes a FULL-BLEED 4:5 slide with brand TEXT overlaid across the BOTTOM third.
You are shown numbered candidate thumbnails. Pick and RANK the best ones.
Prefer: sharp/in-focus; joyful, lively kids or coaches; clear faces that are fully visible and roughly CENTRED (not touching the top/bottom/left/right edges — the crop and bottom text must not cut a face); good lighting; on-brand (gym, training, competition, smiles).
Avoid: blurry, dark, backs of heads, faces at the very edges, empty/cluttered frames, adults-only, near-duplicates.
Reply STRICT JSON ONLY: {"order":[best index, next, ...]} listing the indices (0-based) of GOOD photos, best first. Omit bad ones.`;

function parseJson(text) { try { const m = String(text).match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; } catch { return null; } }

/**
 * Select the best `count` photos (download full-res). Returns
 * { photos:[{buffer,name,path}], backups:[...], ranked:[paths] }.
 * On any failure, falls back to a spread sample (still downloads full-res).
 */
async function selectBest(count, { folder, exclude = [] } = {}) {
  const folders = [folder, ...CANDIDATE_FOLDERS].filter(Boolean);
  let candidates = [];
  for (const f of folders) {
    try {
      const imgs = await yandex.listImages(f, { limit: 300, previewSize: 'M' });
      if (imgs.length) { candidates = imgs; break; }
    } catch (err) { logger.warn({ folder: f, err: err.message }, 'selectBest: folder skip'); }
  }
  candidates = candidates.filter((c) => !exclude.includes(c.path));
  if (!candidates.length) throw new Error('no candidate images under /AcroGym/Marketing');

  const shortlist = sample(candidates, 14).filter((c) => c.preview);
  let order = null;
  if (shortlist.length) {
    try {
      const images = [];
      for (const c of shortlist) {
        try { images.push({ data: (await yandex.fetchPreview(c.preview)).toString('base64'), media_type: 'image/jpeg' }); }
        catch { images.push(null); }
      }
      const valid = shortlist.filter((_, i) => images[i]);
      const validImgs = images.filter(Boolean);
      const user = `Here are ${validImgs.length} candidate photos (index 0..${validImgs.length - 1}). Rank the best for the carousel.`;
      const raw = await generateText({ system: SELECT_SYSTEM, user, images: validImgs, maxTokens: 300, model: SELECT_MODEL });
      const parsed = parseJson(raw);
      if (parsed && Array.isArray(parsed.order)) {
        order = parsed.order.map((i) => valid[i]).filter(Boolean);
      }
    } catch (err) { logger.warn({ err: err.message }, 'selectBest: vision ranking failed → fallback sample'); }
  }

  const ranked = order && order.length ? order : sample(candidates, count + 3);
  const chosen = ranked.slice(0, count);
  const backups = ranked.slice(count, count + 3);
  if (!chosen.length) throw new Error('photo selection produced nothing');

  const photos = [];
  for (const c of chosen) photos.push({ buffer: await yandex.downloadBuffer(c.path), name: c.name, path: c.path });
  logger.info({ chosen: chosen.length, fromVision: !!order }, 'smart photo selection done');
  return { photos, backups, ranked: ranked.map((c) => c.path) };
}

module.exports = { selectBest };

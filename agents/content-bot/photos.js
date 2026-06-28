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

const SELECT_SYSTEM = `You curate photos for AcroGym Qatar (kids' gymnastics & acrobatics, Doha) Instagram carousels. Each chosen photo becomes a FULL-BLEED 4:5 slide with brand TEXT overlaid across the BOTTOM third.
You are shown a POST TOPIC and numbered candidate thumbnails. Pick and RANK the photos that best fit THIS topic.

Ranking priority:
1. RELEVANCE to the topic FIRST. Whatever the topic is about IS the subject to look for — e.g. a topic about the gym/facility → wide shots of the hall, equipment, mats, the space; about competition → competition/medals/podium moments; about a coach → the coach; about a class/kids → children training. Don't force faces/kids into a topic that isn't about them.
2. Then 4:5-FRIENDLY COMPOSITION (very important — the photo will be cropped to a TALL vertical 4:5). STRONGLY PREFER photos with ONE clear main subject (or a tight small group) that has breathing room / empty space around them — these crop cleanly to vertical without cutting anyone. STRONGLY AVOID busy candid shots where people are spread ACROSS THE WHOLE WIDTH or scattered to the left/right edges — a vertical crop can't keep them all and someone gets cut. A calmer photo with one child mid-pose beats a chaotic one with 6 kids edge-to-edge, even on the same topic.
3. Then QUALITY: sharp/in-focus, well-lit, on-brand, lively, joyful.
4. For a room/equipment topic, faces don't matter — judge the space; still prefer a composition that reads well tall.

Avoid: off-topic shots, blurry, dark, cluttered/empty, near-duplicates, and crowds spanning the full frame width.
Reply with ONLY a raw JSON object, exactly ONCE — NO analysis, NO commentary, NO markdown, no second attempt, nothing before or after it. Your entire response must start with { and be exactly: {"order":[best index, next, ...]} listing the indices (0-based) of GOOD on-topic photos, best first, omitting the rest. Output it once and STOP.`;

// Extract the FIRST balanced {...} object. The model sometimes emits a valid
// JSON, then second-guesses and prints a second one + prose; a greedy match would
// swallow both and fail to parse. Scan braces to take just the first object.
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

/**
 * Select the best `count` photos (download full-res). Returns
 * { photos:[{buffer,name,path}], backups:[...], ranked:[paths] }.
 * On any failure, falls back to a spread sample (still downloads full-res).
 */
async function selectBest(count, { folder, exclude = [], topic = '' } = {}) {
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
      const user = `POST TOPIC: ${topic || 'general AcroGym life'}\n\nHere are ${validImgs.length} candidate photos (index 0..${validImgs.length - 1}). Rank the ones that best fit this topic, best first.`;
      const raw = await generateText({ system: SELECT_SYSTEM, user, images: validImgs, maxTokens: 400, model: SELECT_MODEL });
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

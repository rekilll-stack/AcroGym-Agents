'use strict';

/**
 * Smart photo selection (Agent 4 — autonomous posting).
 *
 * PRIMARY path = the PHOTO CATALOG (data/photo-catalog.json, built once by
 * scripts/build-photo-catalog.js). Every library photo is pre-vetted for what it
 * shows, whether it is one clear subject vs a crowd, how well it crops to a
 * vertical 4:5, quality, faces and joyfulness. Selection then picks from the
 * GOOD, crop-friendly photos by topic — no more sampling random thumbnails and
 * hoping. This is the fix for "random / crowded / cut" photos.
 *
 * Cover = the single best hero (clear face + joyful). Inner = the next most
 * relevant, distinct (near-duplicate burst frames removed by perceptual hash).
 *
 * Fallback (catalog missing) = the older live vision-sample ranking.
 */

const fs = require('fs');
const path = require('path');
const yandex = require('./yandex');
const { generateText } = require('./llm');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('content-bot');

const CATALOG_PATH = path.join(__dirname, '../../data/photo-catalog.json');
const RANK_MODEL = process.env.CONTENT_RANK_MODEL || 'claude-haiku-4-5-20251001'; // text-only topic rank (cheap)
const SELECT_MODEL = process.env.CONTENT_SELECT_MODEL || 'claude-sonnet-5';     // fallback vision rank
const CANDIDATE_FOLDERS = [
  '/AcroGym/Marketing/Photos/Competitions May 2025',
];

// Take the FIRST balanced {...} object (models sometimes append a second one).
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

function loadCatalog() {
  try { return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8')).photos || []; } catch { return []; }
}

// Recently-PUBLISHED photos — excluded next time so consecutive posts don't
// repeat the same shots. 🔴 Recorded at PUBLISH time (publish.js), NOT at
// selection: unpublished drafts/rebuilds must not burn the best shots
// (2026-07-03 — two dead drafts burned the top DSC set and the next build
// fell back to weak phone photos).
const RECENT_PATH = path.join(__dirname, '../../data/recent-photos.json');
const RECENT_KEEP = 24;
function recentExclude() {
  try { return JSON.parse(fs.readFileSync(RECENT_PATH, 'utf8')).paths || []; } catch { return []; }
}
function recordUsed(paths) {
  try {
    const merged = [...paths, ...recentExclude()].filter((p, i, a) => a.indexOf(p) === i).slice(0, RECENT_KEEP);
    fs.writeFileSync(RECENT_PATH, JSON.stringify({ updated: new Date().toISOString(), paths: merged }, null, 2));
  } catch (err) { logger.warn({ err: err.message }, 'recordUsed failed'); }
}

// Hamming distance between two 16-hex aHashes (0 = identical, ~>10 = different).
function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = (parseInt(a[i], 16) ^ parseInt(b[i], 16)) & 0xf;
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

function sample(arr, n) {
  if (arr.length <= n) return arr.slice();
  const step = arr.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

const RANK_SYSTEM = `You choose photos for an AcroGym (kids' gymnastics & acrobatics, Doha) Instagram carousel about a given TOPIC.
You are given the topic and a numbered list of available photos (each: subject type + caption + tags). All listed photos are already good quality and crop well to vertical — your job is RELEVANCE to the topic AND set COHESION.
Return the indices of the photos that best fit the topic, MOST relevant first. A joyful child training, posing or competing fits almost any positive topic, so still return plenty even if the match isn't literal. Put the strongest single "hero" shot first.
COHESION (owner rule): the top picks must read as ONE consistent carousel — same setting/session/styling (e.g. if the theme is medals, EVERY top pick shows medals; don't mix a training-hall shot into a competition set). Vary poses and framing, never the visual style.
Reply STRICT JSON ONLY, exactly once: {"order":[idx, idx, ...]}. No prose. Output once and STOP.`;

const HERO_SUBJECTS = new Set(['single_child', 'two_children', 'coach_with_child']);

// Owner rule (2026-07-03): the cover must be a STRIKING, photogenic child — the
// cover sells the post. One vision pass over cheap M-size previews of the top
// hero candidates picks it; the old heuristic stays as the fallback.
const COVER_SYSTEM = `You pick the COVER photo for a kids' gymnastics Instagram carousel. You see several numbered candidate photos (0-based, in the order given).
Choose the single most EYE-CATCHING one: a photogenic, joyful child at a flattering angle, face clearly visible, sharp and well lit, a pose that reads instantly, background not messy. AVOID: unflattering mid-motion grimaces, awkward or unattractive angles, faces obscured or turned away, cluttered frames.
Reply STRICT JSON ONLY, exactly once: {"cover": <index>}. No prose.`;

async function pickCoverVision(cands) {
  if (!cands || cands.length < 2) return null;
  try {
    const folders = [...new Set(cands.map((c) => c.path.slice(0, c.path.lastIndexOf('/')).replace(/^disk:/, '')))];
    const previewByPath = new Map();
    for (const f of folders) {
      const items = await yandex.listImages(f, { limit: 200, previewSize: 'M' });
      for (const it of items) if (it.preview) previewByPath.set(String(it.path).replace(/^disk:/, ''), it.preview);
    }
    const imgs = []; const idx = [];
    for (let i = 0; i < cands.length; i++) {
      const u = previewByPath.get(String(cands[i].path).replace(/^disk:/, ''));
      if (!u) continue;
      try {
        const b = await yandex.fetchPreview(u);
        imgs.push({ data: b.toString('base64'), media_type: 'image/jpeg' });
        idx.push(i);
      } catch { /* skip candidate without a fetchable preview */ }
    }
    if (imgs.length < 2) return null;
    const raw = await generateText({
      system: COVER_SYSTEM,
      user: `You see ${imgs.length} numbered photos in the given order. Return the JSON.`,
      images: imgs, maxTokens: 60, model: SELECT_MODEL,
    });
    const v = parseJson(raw);
    if (v && Number.isInteger(v.cover) && v.cover >= 0 && v.cover < idx.length) {
      logger.info({ cover: cands[idx[v.cover]].name, considered: idx.length }, 'cover picked by vision (photogenic rule)');
      return cands[idx[v.cover]];
    }
  } catch (err) { logger.warn({ err: err.message }, 'cover vision pick failed → heuristic'); }
  return null;
}

/**
 * Select the best `count` photos (download full-res). Returns
 * { photos:[{buffer,name,path}], backups:[...], ranked:[paths] }.
 */
async function selectBest(count, { folder, exclude = [], topic = '', story = false } = {}) {
  exclude = [...new Set([...exclude, ...recentExclude()])]; // avoid repeating recent shots
  const cat = loadCatalog().filter((p) => p && p.phash && !exclude.includes(p.path));
  if (cat.length < Math.max(count + 2, 8)) {
    logger.warn({ catalog: cat.length }, 'catalog too small → vision fallback');
    return selectBestVision(count, { folder, exclude, topic });
  }

  // Usability tiers — relax only if too few crop-friendly good photos. A 9:16
  // STORY crop is far more aggressive than 4:5 (it keeps only ~37% of a landscape
  // photo's width), so for stories demand a HIGH vertical_crop score and prefer a
  // SINGLE subject — a second person spread across a wide frame gets sliced.
  const tiers = story ? [
    (p) => p.quality >= 0.6 && p.vertical_crop >= 0.75 && p.subject === 'single_child',
    (p) => p.quality >= 0.55 && p.vertical_crop >= 0.7 && p.subject === 'single_child',
    (p) => p.quality >= 0.55 && p.vertical_crop >= 0.65 && p.subject !== 'crowd' && p.subject !== 'small_group' && p.subject !== 'two_children',
    (p) => p.quality >= 0.5 && p.vertical_crop >= 0.55 && p.subject !== 'crowd',
    () => true,
  ] : [
    (p) => p.quality >= 0.6 && p.vertical_crop >= 0.6 && p.subject !== 'crowd',
    (p) => p.quality >= 0.55 && p.vertical_crop >= 0.5 && p.subject !== 'crowd',
    (p) => p.quality >= 0.5 && p.vertical_crop >= 0.45,
    () => true,
  ];
  let usable = [];
  for (const t of tiers) { usable = cat.filter(t); if (usable.length >= Math.max(count * 4, 14)) break; }

  // Cap the text-rank payload: keep the top ~70 by quality+crop score.
  usable.sort((a, b) => (b.quality + b.vertical_crop) - (a.quality + a.vertical_crop));
  const pool = usable.slice(0, 70);

  // Topic relevance ranking — text only (no images), cheap.
  let ordered = null;
  try {
    const list = pool.map((p, i) => `${i}. [${p.subject}] ${p.caption} {${(p.tags || []).join(',')}}`).join('\n');
    const raw = await generateText({
      system: RANK_SYSTEM,
      user: `TOPIC: ${topic || 'general AcroGym life'}\n\nPHOTOS:\n${list}\n\nReturn {"order":[...]}.`,
      maxTokens: 500,
      model: RANK_MODEL,
    });
    const v = parseJson(raw);
    if (v && Array.isArray(v.order)) ordered = v.order.map((i) => pool[i]).filter(Boolean);
  } catch (err) { logger.warn({ err: err.message }, 'catalog topic-rank failed → quality order'); }
  if (!ordered || !ordered.length) ordered = pool; // already quality-sorted

  // Cover = best hero (clear face + joyful single/pair) near the top; else first.
  // For a story, force a SINGLE-subject hero so the aggressive 9:16 crop can't
  // slice a second person.
  const topRel = ordered.slice(0, Math.max(count * 3, 10));
  const heroOk = (p) => (story ? p.subject === 'single_child' : HERO_SUBJECTS.has(p.subject));
  const heuristicCover = topRel.find((p) => p.faces_ok && p.joyful && heroOk(p))
    || topRel.find((p) => p.faces_ok && heroOk(p))
    || topRel.find((p) => p.faces_ok && p.joyful)
    || topRel.find((p) => p.faces_ok)
    || ordered[0];
  const heroCands = topRel.filter((p) => p.faces_ok && heroOk(p)).slice(0, 6);
  const cover = (await pickCoverVision(heroCands)) || heuristicCover;

  // Build the set: vary POSES, never the STYLE. Owner rule (2026-07-03, after a
  // medals carousel got one medal-less slide): the set must read as one coherent
  // session/styling — the LLM rank already orders for cohesion, so the greedy
  // pass must NOT veto same-style picks. Tag similarity blocks only near-clones.
  const tagSet = (p) => new Set((p.tags || []).map((t) => String(t).toLowerCase()));
  const jaccard = (a, b) => {
    const A = tagSet(a), B = tagSet(b);
    if (!A.size || !B.size) return 0;
    let inter = 0; for (const t of A) if (B.has(t)) inter += 1;
    return inter / (A.size + B.size - inter);
  };
  const chosen = [];
  const subjCount = {};
  const tryPush = (p, diverse) => {
    if (!p || chosen.includes(p)) return false;
    if (chosen.some((c) => hamming(c.phash, p.phash) <= 8)) return false; // never a near-dupe frame
    if (diverse) {
      if ((subjCount[p.subject] || 0) >= 2) return false;            // ≤2 of the same subject type
      if (chosen.some((c) => jaccard(c, p) >= 0.85)) return false;   // only near-identical tag sets
    }
    chosen.push(p); subjCount[p.subject] = (subjCount[p.subject] || 0) + 1; return true;
  };
  tryPush(cover, false);
  for (const p of ordered) { if (chosen.length >= count) break; tryPush(p, true); }   // variety pass
  for (const p of ordered) { if (chosen.length >= count) break; tryPush(p, false); }  // fill pass (dedupe still on)

  const final = chosen.slice(0, count);
  if (!final.length) throw new Error('catalog selection produced nothing');

  const photos = [];
  for (const p of final) photos.push({ buffer: await yandex.downloadBuffer(p.path), name: p.name, path: p.path });
  logger.info({
    chosen: final.length, fromCatalog: true, cover: final[0] && final[0].name,
    picks: final.map((p) => `${p.subject}:${p.name}`),
  }, 'catalog photo selection done');
  return {
    photos,
    // Wider backup pool WITH quality flags: targeted slide fixes and crop swaps
    // must be able to skip no-face shots (faces sell — owner rule 2026-07-03).
    backups: ordered.slice(count, count + 8).map((p) => ({ path: p.path, name: p.name, faces_ok: p.faces_ok, joyful: p.joyful, subject: p.subject })),
    ranked: final.map((p) => p.path),
  };
}

// ── Fallback: live vision-sample ranking (used only if the catalog is absent) ──
const SELECT_SYSTEM = `You curate photos for AcroGym Qatar (kids' gymnastics, Doha) Instagram carousels. Each becomes a FULL-BLEED vertical 4:5 slide with brand text over the bottom third.
Rank the numbered candidate thumbnails for the POST TOPIC. Priority: (1) relevance to the topic; (2) ONE clear subject with breathing room that crops cleanly to vertical (AVOID crowds spanning the full width); (3) sharp, well-lit, joyful.
Reply with ONLY {"order":[best,next,...]} (0-based indices, best first), once, no prose.`;

async function selectBestVision(count, { folder, exclude = [], topic = '' } = {}) {
  const folders = [folder, ...CANDIDATE_FOLDERS].filter(Boolean);
  const perFolder = [];
  let candidates = [];
  for (const f of folders) {
    try { const imgs = await yandex.listImages(f, { limit: 200, previewSize: 'M' }); perFolder.push(imgs); candidates.push(...imgs); }
    catch (err) { logger.warn({ folder: f, err: err.message }, 'selectBestVision: folder skip'); }
  }
  const seen = new Set();
  candidates = candidates.filter((c) => !exclude.includes(c.path) && !seen.has(c.path) && seen.add(c.path));
  if (!candidates.length) throw new Error('no candidate images under /AcroGym/Marketing');

  const perN = Math.max(4, Math.ceil(16 / Math.max(1, perFolder.length)));
  const seen2 = new Set();
  let shortlist = perFolder
    .flatMap((imgs) => sample(imgs.filter((c) => c.preview && !exclude.includes(c.path)), perN))
    .filter((c) => c && !seen2.has(c.path) && seen2.add(c.path))
    .slice(0, 18);
  if (!shortlist.length) shortlist = sample(candidates, 14).filter((c) => c.preview);

  let order = null;
  try {
    const images = [];
    for (const c of shortlist) {
      try { images.push({ data: (await yandex.fetchPreview(c.preview)).toString('base64'), media_type: 'image/jpeg' }); }
      catch { images.push(null); }
    }
    const valid = shortlist.filter((_, i) => images[i]);
    const validImgs = images.filter(Boolean);
    const user = `POST TOPIC: ${topic || 'general AcroGym life'}\n\nHere are ${validImgs.length} candidate photos (index 0..${validImgs.length - 1}). Rank the best, best first.`;
    const raw = await generateText({ system: SELECT_SYSTEM, user, images: validImgs, maxTokens: 400, model: SELECT_MODEL });
    const parsed = parseJson(raw);
    if (parsed && Array.isArray(parsed.order)) order = parsed.order.map((i) => valid[i]).filter(Boolean);
  } catch (err) { logger.warn({ err: err.message }, 'selectBestVision: vision ranking failed → sample' ); }

  const ranked = order && order.length ? order : sample(candidates, count + 3);
  const chosen = ranked.slice(0, count);
  if (!chosen.length) throw new Error('photo selection produced nothing');
  const photos = [];
  for (const c of chosen) photos.push({ buffer: await yandex.downloadBuffer(c.path), name: c.name, path: c.path });
  logger.info({ chosen: chosen.length, fromVision: !!order, fromCatalog: false }, 'vision photo selection done');
  return { photos, backups: ranked.slice(count, count + 3), ranked: ranked.map((c) => c.path) };
}

module.exports = { selectBest, selectBestVision, loadCatalog, recordUsed };

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
  '/AcroGym/Marketing/AcroGym Competiton 2026',
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

// Fetch M-size previews for candidate catalog entries → [{i, img}] aligned to
// the input indices. Shared by the cover pick and the pre-build set review.
async function fetchPreviews(cands, size = 'M') {
  const folders = [...new Set(cands.map((c) => c.path.slice(0, c.path.lastIndexOf('/')).replace(/^disk:/, '')))];
  const previewByPath = new Map();
  for (const f of folders) {
    const items = await yandex.listImages(f, { limit: 2000, previewSize: size });
    for (const it of items) if (it.preview) previewByPath.set(String(it.path).replace(/^disk:/, ''), it.preview);
  }
  const out = [];
  for (let i = 0; i < cands.length; i++) {
    const u = previewByPath.get(String(cands[i].path).replace(/^disk:/, ''));
    if (!u) continue;
    try {
      const b = await yandex.fetchPreview(u);
      out.push({ i, img: { data: b.toString('base64'), media_type: 'image/jpeg' } });
    } catch { /* skip candidate without a fetchable preview */ }
  }
  return out;
}

async function pickCoverVision(cands) {
  if (!cands || cands.length < 2) return null;
  try {
    const prevs = await fetchPreviews(cands);
    const imgs = prevs.map((p) => p.img); const idx = prevs.map((p) => p.i);
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

// Vision SET SELECTION (2026-07-03, after repeated owner feedback on machine
// taste): ONE vision pass over the top candidates' previews picks the final set
// directly — the way a human SMM would. The old heuristic chain (cover pick +
// greedy variety + set review) stays as the fallback.
// AVOID-PEOPLE references (owner feedback 2026-07-03): photos in
// data/avoid-people/ show children the owner does not want featured. The set
// picker sees them first and must not pick candidates starring the same child.
// File-level blacklisting can't do this — the same kids appear in hundreds of
// frames; this bans the PERSON, not the file.
const AVOID_DIR = path.join(__dirname, '../../data/avoid-people');
function loadAvoidRefs() {
  try {
    return fs.readdirSync(AVOID_DIR).filter((f) => /\.(jpe?g|png)$/i.test(f)).slice(0, 4)
      .map((f) => ({ data: fs.readFileSync(path.join(AVOID_DIR, f)).toString('base64'), media_type: 'image/jpeg' }));
  } catch { return []; }
}

const SET_PICK_SYSTEM = `You are the SMM photo editor for AcroGym Qatar — a kids' gymnastics & acrobatics brand in Doha. You choose the photos for ONE Instagram carousel on the given TOPIC.
If AVOID references are present (they come FIRST, before the candidates), they show children the owner does not want featured: do NOT pick any candidate where one of those same children is the main subject.
What a great pick looks like, in priority order:
1. SOUL — a genuine moment: a real smile, pride after a landed element, focus, grace mid-move. A parent should look at it and feel "I want this for my child".
2. The child looks GREAT: face clearly visible and flattering, elegant pose (never butt-first / diaper-like poses, grimaces, visible skin irritation or bruises — nothing the child could be embarrassed by later).
3. LACONIC composition: ONE clear hero, calm uncluttered background, no third-party sponsor banners/logos dominating the frame, breathing room below (the slide adds a text overlay over the bottom third).
4. Complete framing: the photo's own edges do not slice the subject's head/feet/hands; the subject is sharp.
5. The set reads as ONE session (cohesive light/setting), poses varied, no near-duplicate frames. The FIRST pick is the cover — the single most striking shot.
Reply STRICT JSON ONLY, exactly once: {"picks":[candidate indices]} with EXACTLY the requested number, cover first. No prose.`;

async function pickSetVision(cands, count, topic) {
  if (!cands || cands.length < count + 2) return null;
  try {
    const prevs = await fetchPreviews(cands.slice(0, 12), 'L');
    if (prevs.length < count + 2) return null;
    const refs = loadAvoidRefs();
    const user = (refs.length
      ? `The FIRST ${refs.length} image(s) are AVOID references (children NOT to feature). After them come ${prevs.length} CANDIDATE photos, numbered 0..${prevs.length - 1} in the given order.`
      : `You see ${prevs.length} candidate photos, numbered 0..${prevs.length - 1} in the given order.`)
      + `\nTOPIC: ${topic || 'general AcroGym life'}\nChoose EXACTLY ${count} candidates. Return the JSON.`;
    const raw = await generateText({
      system: SET_PICK_SYSTEM,
      user,
      images: [...refs, ...prevs.map((x) => x.img)], maxTokens: 80, model: SELECT_MODEL,
    });
    const v = parseJson(raw);
    if (!v || !Array.isArray(v.picks)) return null;
    const seen = new Set();
    const picked = v.picks
      .filter((n) => Number.isInteger(n) && n >= 0 && n < prevs.length && !seen.has(n) && seen.add(n))
      .map((n) => cands[prevs[n].i]);
    // phash dedupe safety net, then top-up from the remaining candidates
    const out = [];
    for (const p of picked) if (!out.some((c) => hamming(c.phash, p.phash) <= 8)) out.push(p);
    for (const c of cands) { if (out.length >= count) break; if (!out.includes(c) && !out.some((x) => hamming(x.phash, c.phash) <= 8)) out.push(c); }
    if (out.length < count) return null;
    logger.info({ picks: out.slice(0, count).map((p) => p.name) }, 'set picked by vision (SMM rule)');
    return out.slice(0, count);
  } catch (err) { logger.warn({ err: err.message }, 'vision set pick failed → heuristic chain'); return null; }
}

// Pre-build SET REVIEW (owner rule 2026-07-03: «выбирать красивых детей», no
// awkward source-cropped shots). ONE vision pass over the chosen set's previews
// rejects unpostable photos BEFORE money is spent on crops/design.
const SET_REVIEW_SYSTEM = `You QA candidate photos for a kids' gymnastics Instagram carousel BEFORE it is built. You see several numbered photos (0-based, in the given order).
For EACH photo decide if it is POSTABLE: photogenic joyful child, flattering moment (not an unflattering mid-motion grimace or butt-first pose), face meaningfully visible, the photo's own framing does not slice off the subject's head/feet/hands, sharp enough, background acceptable.
Be picky — these go on a brand account to attract parents. Reply STRICT JSON ONLY, exactly once: {"reject":[indices]} — empty array if all are postable. No prose.`;

async function reviewSetVision(cands) {
  try {
    const prevs = await fetchPreviews(cands);
    if (!prevs.length) return new Set();
    const raw = await generateText({
      system: SET_REVIEW_SYSTEM,
      user: `You see ${prevs.length} numbered photos in the given order. Return the JSON.`,
      images: prevs.map((p) => p.img), maxTokens: 80, model: SELECT_MODEL,
    });
    const v = parseJson(raw);
    if (v && Array.isArray(v.reject)) {
      return new Set(v.reject.filter((n) => Number.isInteger(n) && n >= 0 && n < prevs.length).map((n) => prevs[n].i));
    }
  } catch (err) { logger.warn({ err: err.message }, 'set review failed → keeping picks'); }
  return new Set();
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

  // Primary path: vision picks the whole set from the top candidates' previews.
  const visCands = ordered.filter((p) => p.faces_ok !== false).slice(0, 16);
  const visSet = await pickSetVision(visCands, count, topic);
  if (visSet) {
    const photos = [];
    for (const p of visSet) photos.push({ buffer: await yandex.downloadBuffer(p.path), name: p.name, path: p.path, caption: p.caption, subject: p.subject });
    const rest = ordered.filter((p) => p.faces_ok !== false && !visSet.includes(p));
    return { photos, backups: rest.slice(0, 8).map((p) => ({ path: p.path, name: p.name, faces_ok: p.faces_ok, joyful: p.joyful, subject: p.subject })), ranked: visSet.map((p) => p.path) };
  }

  // Fallback: cover = best hero (clear face + joyful single/pair) near the top.
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

  let final = chosen.slice(0, count);
  if (!final.length) throw new Error('catalog selection produced nothing');

  // Vision set review: reject unphotogenic / source-cropped shots and refill
  // from the ranked pool (one bounded pass — the slide verifier stays the net).
  const rejected = await reviewSetVision(final);
  if (rejected.size) {
    logger.info({ rejected: final.filter((_, i) => rejected.has(i)).map((p) => p.name) }, 'set review rejected photos');
    const keep = final.filter((_, i) => !rejected.has(i));
    const rejectedPaths = new Set(final.filter((_, i) => rejected.has(i)).map((p) => p.path));
    const refill = ordered.filter((p) => p.faces_ok !== false && !rejectedPaths.has(p.path) && !keep.includes(p)
      && !keep.some((c) => hamming(c.phash, p.phash) <= 8));
    final = [...keep, ...refill.slice(0, count - keep.length)];
    if (final.length < count) logger.warn({ have: final.length, want: count }, 'set review: pool too small to refill fully');
  }

  const photos = [];
  for (const p of final) photos.push({ buffer: await yandex.downloadBuffer(p.path), name: p.name, path: p.path, caption: p.caption, subject: p.subject });
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

// ── 🔍 СКАУТ: строгий подбор под КОНКРЕТНЫЙ запрос владельца (смотрит на кадры и
//    берёт только те, что РЕАЛЬНО показывают запрошенное; если нет — возвращает мало/ничего).
const SCOUT_MATCH_SYSTEM = `You are a photo scout for AcroGym Qatar (kids' gymnastics & acrobatics, Doha). The owner asked for photos matching a SPECIFIC request. You are shown numbered candidate photos. Return ONLY the ones that GENUINELY match the request — the actual action/subject described. Examples: if they ask for "jumping / mid-air", pick ONLY photos where a child is clearly airborne or leaping — NOT handstands, headstands, poses, splits, or standing shots; if they ask for "handstand", pick only handstands. Be strict: a photo that is merely gymnastics-related but does NOT show the requested thing is a WRONG pick. Order best match first. If FEWER photos match than requested, return only the genuine matches. If NONE match, return an empty list. Never pad with unrelated photos. Reply STRICT JSON only, once: {"picks":[indices]}.`;

async function scoutCandidates(theme, count = 6) {
  const cat = loadCatalog().filter((p) => p && p.phash && p.faces_ok !== false
    && p.subject !== 'crowd' && p.subject !== 'facility' && p.subject !== 'object' && p.subject !== 'coach');
  if (!cat.length) return { photos: [], weak: true };
  // Грубая текстовая релевантность → сузить пул под превью (теги неточные, поэтому дальше — зрение).
  cat.sort((a, b) => ((b.quality || 0) + (b.vertical_crop || 0)) - ((a.quality || 0) + (a.vertical_crop || 0)));
  let pool = cat;
  try {
    const list = cat.slice(0, 80).map((p, i) => `${i}. [${p.subject}] ${p.caption} {${(p.tags || []).join(',')}}`).join('\n');
    const raw = await generateText({ system: RANK_SYSTEM, user: `TOPIC: ${theme}\n\nPHOTOS:\n${list}\n\nReturn {"order":[...]}.`, maxTokens: 500, model: RANK_MODEL });
    const v = parseJson(raw);
    if (v && Array.isArray(v.order)) pool = v.order.map((i) => cat[i]).filter(Boolean);
  } catch (err) { logger.warn({ err: err.message }, 'scout text-rank failed → quality order'); }
  const cand = pool.slice(0, 18);
  const prevs = await fetchPreviews(cand, 'L');
  if (!prevs.length) return { photos: [], weak: true };
  let picks = [];
  try {
    const raw = await generateText({
      system: SCOUT_MATCH_SYSTEM,
      user: `The owner wants photos of: "${theme}". You see ${prevs.length} candidates numbered 0..${prevs.length - 1}. Pick up to ${count} that GENUINELY show that, best first. If fewer truly match, return fewer. Return {"picks":[...]}.`,
      images: prevs.map((x) => x.img), maxTokens: 120, model: SELECT_MODEL,
    });
    const v = parseJson(raw);
    if (v && Array.isArray(v.picks)) picks = v.picks.filter((n) => Number.isInteger(n) && n >= 0 && n < prevs.length);
  } catch (err) { logger.warn({ err: err.message }, 'scout vision match failed'); }
  const seen = new Set();
  const chosen = picks.map((n) => cand[prevs[n].i]).filter((p) => p && !seen.has(p.path) && seen.add(p.path)).slice(0, count);
  const photos = [];
  for (const p of chosen) { try { photos.push({ buffer: await yandex.downloadBuffer(p.path), name: p.name, path: p.path }); } catch (e) { logger.warn({ e: e.message }, 'scout candidate download'); } }
  logger.info({ theme, matched: photos.length }, 'scout candidates picked (strict vision match)');
  return { photos, weak: photos.length < 3 };
}

module.exports = { selectBest, selectBestVision, scoutCandidates, loadCatalog, recordUsed };

'use strict';
// Прямая публикация в Instagram через Graph API Content Publishing
// (право instagram_content_publish, постоянный System User токен). Детерминированно,
// без посредников — альтернатива/замена Metricool для НЕМЕДЛЕННОЙ публикации.
// Требует ПУБЛИЧНЫЕ URL медиа (у нас уже есть: yandex.uploadPublic / Canva export).
// Расписание («в лучшее время») Graph API НЕ умеет — это остаётся на Metricool-пути.

const { createLogger } = require('../../shared/logger');
const logger = createLogger('content-bot');

const V = process.env.META_GRAPH_API_VERSION || 'v21.0';
const IG = () => process.env.IG_BUSINESS_ID;

function isConfigured() { return !!(process.env.META_GRAPH_TOKEN && process.env.IG_BUSINESS_ID); }

async function gpost(path, params) {
  const body = new URLSearchParams({ ...params, access_token: process.env.META_GRAPH_TOKEN });
  const res = await fetch(`https://graph.facebook.com/${V}/${path}`, { method: 'POST', body });
  const j = await res.json();
  if (j.error) throw new Error(`ig-publish ${path}: ${j.error.message}`);
  return j;
}
async function gget(path) {
  const res = await fetch(`https://graph.facebook.com/${V}/${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(process.env.META_GRAPH_TOKEN)}`);
  const j = await res.json();
  if (j.error) throw new Error(`ig-publish ${path}: ${j.error.message}`);
  return j;
}

// Дождаться готовности контейнера (видео/reel обрабатываются асинхронно).
async function waitReady(containerId, { tries = 30, delayMs = 4000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const s = await gget(`${containerId}?fields=status_code,status`);
    if (s.status_code === 'FINISHED') return true;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`контейнер ${s.status_code}: ${s.status || ''}`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error('контейнер не готов (таймаут обработки медиа)');
}

async function publishContainer(creationId) {
  const r = await gpost(`${IG()}/media_publish`, { creation_id: creationId });
  return r.id; // id опубликованного медиа
}

async function publishImage({ imageUrl, caption }) {
  const c = await gpost(`${IG()}/media`, { image_url: imageUrl, caption: caption || '' });
  await waitReady(c.id, { tries: 12 });
  return { id: await publishContainer(c.id), type: 'IMAGE' };
}

async function publishCarousel({ imageUrls, caption }) {
  const children = [];
  for (const u of imageUrls.slice(0, 10)) {
    const c = await gpost(`${IG()}/media`, { image_url: u, is_carousel_item: 'true' });
    children.push(c.id);
  }
  for (const cid of children) await waitReady(cid, { tries: 12 });
  const carousel = await gpost(`${IG()}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: caption || '' });
  await waitReady(carousel.id, { tries: 15 });
  return { id: await publishContainer(carousel.id), type: 'CAROUSEL' };
}

async function publishReel({ videoUrl, caption }) {
  const c = await gpost(`${IG()}/media`, { media_type: 'REELS', video_url: videoUrl, caption: caption || '' });
  await waitReady(c.id, { tries: 60, delayMs: 5000 }); // видео обрабатывается дольше (до ~5 мин)
  return { id: await publishContainer(c.id), type: 'REELS' };
}

async function publishStory({ imageUrl, videoUrl }) {
  const params = videoUrl ? { media_type: 'STORIES', video_url: videoUrl } : { media_type: 'STORIES', image_url: imageUrl };
  const c = await gpost(`${IG()}/media`, params);
  await waitReady(c.id, { tries: videoUrl ? 60 : 12, delayMs: 5000 });
  return { id: await publishContainer(c.id), type: 'STORIES' };
}

/**
 * Опубликовать draft напрямую (кнопка «Опубликовать сейчас»).
 * draft.slides[].url — публичные URL; draft.slides[0].isVideo — для reel/видео-сторис.
 * @returns {Promise<{ok, mediaId, type, permalink}>}
 */
async function publishDraftDirect(draft) {
  if (!isConfigured()) throw new Error('META_GRAPH_TOKEN/IG_BUSINESS_ID не заданы');
  const slides = (draft.slides || []).filter((s) => s && s.url);
  const urls = slides.map((s) => s.url);
  if (!urls.length) throw new Error('нет публичных URL медиа для прямой публикации');
  const caption = draft.caption || '';
  const igType = draft.igType || 'POST';
  logger.info({ igType, media: urls.length }, 'IG direct publish: creating container');

  let out;
  if (igType === 'STORY') {
    out = slides[0].isVideo ? await publishStory({ videoUrl: urls[0] }) : await publishStory({ imageUrl: urls[0] });
  } else if (igType === 'REEL') {
    out = await publishReel({ videoUrl: urls[0], caption });
  } else {
    out = urls.length > 1 ? await publishCarousel({ imageUrls: urls, caption }) : await publishImage({ imageUrl: urls[0], caption });
  }
  let permalink = '';
  try { permalink = (await gget(`${out.id}?fields=permalink`)).permalink || ''; } catch { /* необязательно */ }
  logger.info({ mediaId: out.id, type: out.type }, 'IG direct publish: PUBLISHED');
  return { ok: true, mediaId: out.id, type: out.type, permalink };
}

module.exports = { isConfigured, publishDraftDirect, publishImage, publishCarousel, publishReel, publishStory };

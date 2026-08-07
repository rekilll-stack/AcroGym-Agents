'use strict';
// Instagram Graph API — тянет последние посты @acrogymqatar + их insights и мапит
// в формат, который ждёт analyze.js ({date,type,reach,interactions,saved,likes,
// shares,caption,url}). Токен и IG_BUSINESS_ID берутся из .env. Бесплатно (Meta),
// в обход платного Metricool API.

const V = process.env.META_GRAPH_API_VERSION || 'v21.0';

async function gget(path) {
  const token = process.env.META_GRAPH_TOKEN;
  if (!token) throw new Error('META_GRAPH_TOKEN не задан');
  const url = `https://graph.facebook.com/${V}/${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  const j = await res.json();
  if (j.error) throw new Error(`graph ${path.split('?')[0]}: ${j.error.message}`);
  return j;
}

// Инсайты одного медиа. Метрики немного разнятся по типу и возрасту поста, поэтому
// мягко деградируем: если полный набор не отдаётся — падаем к базовому reach.
async function mediaInsights(mediaId) {
  let data = [];
  try { data = (await gget(`${mediaId}/insights?metric=reach,likes,comments,saved,shares,total_interactions`)).data || []; }
  catch (e) {
    try { data = (await gget(`${mediaId}/insights?metric=reach`)).data || []; }
    catch { data = []; }
  }
  const val = (name) => { const m = data.find((x) => x.name === name); return (m && m.values && m.values[0] != null) ? Number(m.values[0].value) || 0 : 0; };
  const reach = val('reach'), saved = val('saved'), shares = val('shares'), likes = val('likes'), comments = val('comments');
  let interactions = val('total_interactions');
  if (!interactions) interactions = likes + comments + saved + shares;
  return { reach, saved, shares, likes, comments, interactions };
}

/**
 * Последние N постов IG_BUSINESS_ID в формате analyze.js.
 * @param {object} [opts] { limit }
 * @returns {Promise<Array<{date,type,reach,interactions,saved,likes,shares,caption,url}>>}
 */
async function fetchPosts({ limit = 12 } = {}) {
  const id = process.env.IG_BUSINESS_ID;
  if (!id) throw new Error('IG_BUSINESS_ID не задан');
  const media = await gget(`${id}/media?fields=id,caption,media_type,timestamp,permalink,like_count,comments_count&limit=${limit}`);
  const out = [];
  for (const m of (media.data || [])) {
    const ins = await mediaInsights(m.id);
    out.push({
      date: m.timestamp,
      type: m.media_type,
      reach: ins.reach,
      interactions: ins.interactions,
      saved: ins.saved,
      likes: ins.likes || m.like_count || 0,
      shares: ins.shares,
      caption: m.caption || '',
      url: m.permalink || '',
    });
  }
  return out;
}

/** Базовые данные аккаунта (для шапки отчёта). */
async function account() {
  const id = process.env.IG_BUSINESS_ID;
  const a = await gget(`${id}?fields=username,followers_count,media_count`);
  return { username: a.username, followers: a.followers_count, mediaCount: a.media_count };
}

function isConfigured() { return !!(process.env.META_GRAPH_TOKEN && process.env.IG_BUSINESS_ID); }

module.exports = { fetchPosts, account, isConfigured };

'use strict';

/**
 * Metricool API client (Agent 4 — autonomous posting, Phase 1).
 *
 * Schedules / publishes Instagram content (post, carousel, story, reel) through
 * Metricool, which owns the Instagram Graph connection. We never touch the
 * Instagram API directly — Metricool does, exactly like the manual flow.
 *
 * 🔴 SAFETY: this module only TALKS to Metricool. The decision to publish (vs
 *    draft) is made by publish.js / the approval gate — never here.
 * 🔴 Secrets live in .env, never in chat/logs.
 *
 * Config (in ../../.env):
 *   METRICOOL_USER_TOKEN   — API user token (Metricool → Settings → API access)
 *   METRICOOL_USER_ID      — numeric Metricool user id that owns the token
 *   METRICOOL_BLOG_ID      — brand/blog id (AcroGym = 6469959)
 *
 * The scheduled-post payload mirrors the structure proven to work via the
 * Metricool MCP (providers / instagramData / publicationDate / media /
 * autoPublish / draft). Endpoint paths follow Metricool's documented v2
 * scheduler API; VERIFY on the first live run (written before REST keys exist).
 */

const { createLogger } = require('../../shared/logger');

const logger = createLogger('content-bot');

const BASE = 'https://app.metricool.com/api';
const TZ = process.env.TIMEZONE || 'Asia/Qatar';

const USER_TOKEN = () => (process.env.METRICOOL_USER_TOKEN || '').trim();
const USER_ID = () => (process.env.METRICOOL_USER_ID || '').trim();
const BLOG_ID = () => (process.env.METRICOOL_BLOG_ID || '6469959').trim();

function isConfigured() {
  return !!(USER_TOKEN() && USER_ID() && BLOG_ID());
}

// Build the auth query string Metricool expects on every call.
function authQuery(extra = {}) {
  const p = new URLSearchParams({
    userId: USER_ID(),
    userToken: USER_TOKEN(),
    blogId: BLOG_ID(),
    ...extra,
  });
  return p.toString();
}

async function call(method, pathname, { query = {}, json } = {}) {
  if (!isConfigured()) {
    throw new Error('metricool not configured — set METRICOOL_USER_TOKEN / METRICOOL_USER_ID / METRICOOL_BLOG_ID in .env');
  }
  const url = `${BASE}${pathname}?${authQuery(query)}`;
  const res = await fetch(url, {
    method,
    headers: json ? { 'Content-Type': 'application/json' } : {},
    body: json ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    // Never log the token; log only path + status + a short body slice.
    logger.error({ method, pathname, status: res.status, body: String(text).slice(0, 300) }, 'metricool API error');
    throw new Error(`metricool ${method} ${pathname} ${res.status}: ${String(text).slice(0, 200)}`);
  }
  return data;
}

/**
 * Build a Metricool scheduled-post `info` object for an Instagram post.
 * @param {object} p
 * @param {string} p.text          caption (incl. hashtags)
 * @param {string[]} p.media       PUBLIC image/video URLs in slide order
 * @param {string[]} [p.altTexts]  alt text per media item
 * @param {'POST'|'STORY'|'REEL'} [p.igType]
 * @param {boolean} [p.autoPublish]
 * @param {boolean} [p.draft]
 * @param {{dateTime:string,timezone:string}} p.publicationDate
 */
function buildInstagramInfo({ text, media, altTexts = [], igType = 'POST', autoPublish = false, draft = true, publicationDate }) {
  return {
    text,
    media,
    mediaAltText: altTexts,
    autoPublish,
    draft,
    providers: [{ network: 'instagram' }],
    instagramData: { type: igType, showReelOnFeed: true },
    publicationDate,
    firstCommentText: '',
    shortener: false,
    descendants: [],
    smartLinkData: { ids: [] },
    hasNotReadNotes: false,
  };
}

// ISO-ish datetime (no offset) that Metricool's publicationDate wants.
function localDateTime(date = new Date()) {
  // en-CA gives YYYY-MM-DD; combine with HH:mm:ss in the brand timezone.
  const d = new Date(date.toLocaleString('en-US', { timeZone: TZ }));
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Schedule (or publish) a post. `when` is a JS Date; if autoPublish is true and
 * `when` is near-now, Metricool publishes it. Returns the created post object.
 */
async function schedulePost({ text, media, altTexts, igType = 'POST', autoPublish = false, draft = true, when = new Date() }) {
  const publicationDate = { dateTime: localDateTime(when), timezone: TZ };
  const info = buildInstagramInfo({ text, media, altTexts, igType, autoPublish, draft, publicationDate });
  // Some Metricool deployments take the post body directly; date is also passed.
  const data = await call('POST', '/v2/scheduler/posts', {
    query: { timezone: TZ },
    json: info,
  });
  logger.info({ igType, autoPublish, draft, media: (media || []).length }, 'metricool post scheduled');
  return data && (data.data || data);
}

// Best posting time for Instagram over a window (returns Metricool's heatmap).
async function getBestTime({ fromDate, toDate }) {
  return call('GET', '/v2/scheduler/besttimes', {
    query: { provider: 'instagram', start: fromDate, end: toDate, timezone: TZ },
  });
}

// List scheduled (not-yet-published) posts in a date window.
async function listScheduled({ fromDate, toDate }) {
  return call('GET', '/v2/scheduler/posts', { query: { start: fromDate, end: toDate, timezone: TZ } });
}

module.exports = {
  isConfigured,
  schedulePost,
  buildInstagramInfo,
  getBestTime,
  listScheduled,
  localDateTime,
  BLOG_ID,
  TZ,
};

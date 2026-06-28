'use strict';

/**
 * Yandex.Disk client (Agent 4 — autonomous posting, Phase 2).
 *
 * Sources REAL AcroGym photos for visuals. Read-only here, and scoped: we only
 * ever read under /AcroGym (uploads, if ever added, go ONLY to /AcroGym/Marketing).
 * Mirrors the standalone MCP server (mcp-servers/yandex-disk) but in-process so
 * the bot can pull image buffers straight into the Canva pipeline.
 *
 * Config (in ../../.env):
 *   YANDEX_DISK_TOKEN — OAuth token (cloud_api:disk.read is enough for sourcing)
 */

const { createLogger } = require('../../shared/logger');

const logger = createLogger('content-bot');

const API = 'https://cloud-api.yandex.net/v1/disk';
const TOKEN = () => (process.env.YANDEX_DISK_TOKEN || '').trim();

// Hard scope guard: never read outside /AcroGym.
const ROOT = '/AcroGym';
const MARKETING = '/AcroGym/Marketing';

function isConfigured() {
  return !!TOKEN();
}

function assertScoped(diskPath) {
  const p = String(diskPath || '');
  const norm = p.startsWith('disk:') ? p.slice(5) : p;
  if (!norm.startsWith(ROOT)) {
    throw new Error(`yandex: refusing to access outside ${ROOT}: ${diskPath}`);
  }
}

async function apiGet(pathname, params) {
  if (!isConfigured()) throw new Error('yandex not configured — set YANDEX_DISK_TOKEN in .env');
  const url = `${API}${pathname}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url, { headers: { Authorization: `OAuth ${TOKEN()}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`yandex GET ${pathname} ${res.status}: ${(data && data.message) || ''}`);
  return data;
}

function slim(item) {
  return {
    name: item.name,
    path: item.path,
    type: item.type,
    size: item.size,
    mime_type: item.mime_type,
    media_type: item.media_type,
    modified: item.modified,
    preview: item.preview, // small thumbnail URL (needs auth to fetch)
  };
}

/** List items in a folder (scoped to /AcroGym). */
async function list(path = MARKETING, { limit = 200, sort = 'name', previewSize } = {}) {
  assertScoped(path);
  const params = { path, limit, sort };
  if (previewSize) { params.preview_size = previewSize; params.preview_crop = 'false'; }
  const d = await apiGet('/resources', params);
  const items = ((d._embedded && d._embedded.items) || []).map(slim);
  return { path: d.path, total: d._embedded && d._embedded.total, items };
}

/** List only image files in a folder. */
async function listImages(path = MARKETING, opts = {}) {
  const { items } = await list(path, opts);
  return items.filter((i) => i.type === 'file' && i.media_type === 'image');
}

/** Fetch a (small) preview thumbnail URL into a Buffer (needs the OAuth token). */
async function fetchPreview(url) {
  if (!isConfigured()) throw new Error('yandex not configured');
  const res = await fetch(url, { headers: { Authorization: `OAuth ${TOKEN()}` } });
  if (!res.ok) throw new Error(`yandex preview ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Download a file from the Disk into a Buffer (scoped). */
async function downloadBuffer(diskPath) {
  assertScoped(diskPath);
  const meta = await apiGet('/resources/download', { path: diskPath });
  const res = await fetch(meta.href);
  if (!res.ok) throw new Error(`yandex download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  logger.info({ diskPath, bytes: buf.length }, 'yandex photo downloaded');
  return buf;
}

module.exports = {
  isConfigured,
  list,
  listImages,
  downloadBuffer,
  fetchPreview,
  ROOT,
  MARKETING,
};

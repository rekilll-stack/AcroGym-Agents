'use strict';

/**
 * Canva Connect API client (Track D — Autofill pipeline).
 *
 * Generates branded images from AcroGym's REAL Canva brand templates, so the
 * font / asterisk / pill / tones match exactly (no on-server font matching).
 * Flow: upload photo asset → autofill template (text + image) → export PNG.
 *
 * 🔴 Draft only — the exported PNG goes to the chat; Kirill posts by hand.
 * 🔴 Secrets (client secret, refresh token) live in env / a 0600 token file —
 *    never in chat or logs.
 *
 * Config (in ../../.env):
 *   CANVA_CLIENT_ID, CANVA_CLIENT_SECRET, CANVA_REDIRECT_URL
 * Tokens (written by scripts/canva-auth.js after the one-time OAuth):
 *   data/canva-tokens.json  { refresh_token, ... }   (chmod 600)
 *
 * NOTE: endpoint/field details follow Canva's Connect API docs; verify on the
 * first live run (this is written before the account exists).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('content-bot');

const API = 'https://api.canva.com/rest/v1';
const AUTHORIZE_URL = 'https://www.canva.com/api/oauth/authorize';
const TOKEN_URL = `${API}/oauth/token`;
// Canva's actual scope names (verified against the portal's generated URL).
const SCOPES = [
  'asset:read', 'asset:write',
  'design:meta:read', 'design:content:read', 'design:content:write',
  'brandtemplate:meta:read', 'brandtemplate:content:read',
];

const TOKENS_PATH = path.join(__dirname, '../../data/canva-tokens.json');
const PKCE_PATH = path.join(__dirname, '../../data/canva-pkce.json');

const CLIENT_ID = () => process.env.CANVA_CLIENT_ID || '';
const CLIENT_SECRET = () => process.env.CANVA_CLIENT_SECRET || '';
const REDIRECT_URL = () => process.env.CANVA_REDIRECT_URL || '';

function isConfigured() {
  return !!(CLIENT_ID() && CLIENT_SECRET() && fs.existsSync(TOKENS_PATH));
}

// ── PKCE + OAuth (one-time, via scripts/canva-auth.js) ───────────
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function newPkce() {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function buildAuthUrl({ challenge, state }) {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID(),
    redirect_uri: REDIRECT_URL(),
    scope: SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return `${AUTHORIZE_URL}?${p.toString()}`;
}

function basicAuthHeader() {
  return 'Basic ' + Buffer.from(`${CLIENT_ID()}:${CLIENT_SECRET()}`).toString('base64');
}

async function tokenRequest(form) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Authorization': basicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`canva token ${res.status}: ${data.error || JSON.stringify(data).slice(0, 200)}`);
  return data;
}

// Exchange the one-time auth code → tokens; persist refresh_token (0600).
async function exchangeCode(code, verifier) {
  const data = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URL(),
  });
  saveTokens(data);
  return data;
}

function saveTokens(data) {
  const cur = readTokens();
  const merged = { ...cur, ...data, saved_at: Date.now() };
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}
function readTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8')); } catch { return {}; }
}

// In-memory access-token cache (Canva access tokens last ~4h).
let _access = { token: null, exp: 0 };
async function getAccessToken() {
  if (_access.token && Date.now() < _access.exp - 60_000) return _access.token;
  const t = readTokens();
  if (!t.refresh_token) throw new Error('canva not authorized — run scripts/canva-auth.js');
  const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
  if (data.refresh_token) saveTokens(data); // Canva rotates refresh tokens
  _access = { token: data.access_token, exp: Date.now() + (data.expires_in || 14400) * 1000 };
  return _access.token;
}

// ── authenticated API helpers ────────────────────────────────────
async function api(method, pathname, { json, headers = {}, body } = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: json ? JSON.stringify(json) : body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`canva ${method} ${pathname} ${res.status}: ${data.message || data.error || ''}`);
  return data;
}

// Poll a job-returning GET endpoint until success/failed (with timeout).
async function poll(pathname, pick, { tries = 30, delayMs = 1500 } = {}) {
  for (let i = 0; i < tries; i++) {
    const data = await api('GET', pathname);
    const job = pick(data);
    const status = job && job.status;
    if (status === 'success') return job;
    if (status === 'failed') throw new Error(`canva job failed: ${JSON.stringify(job.error || job).slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`canva job timeout: ${pathname}`);
}

// ── pipeline ──────────────────────────────────────────────────────

// Upload an image buffer → returns asset id.
async function uploadAsset(buffer, name = 'photo.jpg') {
  const token = await getAccessToken();
  // Canva wants the metadata as a JSON string header (name_base64 = base64 of
  // the asset name) — NOT base64 of the whole object. Verified live 2026-06-28.
  const meta = JSON.stringify({ name_base64: Buffer.from(name).toString('base64') });
  const res = await fetch(`${API}/asset-uploads`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Asset-Upload-Metadata': meta,
    },
    body: buffer,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`canva asset-upload ${res.status}: ${data.message || ''}`);
  const job = data.job || data;
  if (job.status === 'success' && job.asset) return job.asset.id;
  const done = await poll(`/asset-uploads/${job.id}`, (d) => d.job || d);
  return done.asset.id;
}

// List a template's autofill fields (for setup / field-name discovery).
async function getTemplateDataset(templateId) {
  const data = await api('GET', `/brand-templates/${templateId}/dataset`);
  return data.dataset || data;
}

// Autofill a template with { fieldName: {type:'text'|'image', ...} } → design.
async function autofill(templateId, data, title) {
  const created = await api('POST', '/autofills', {
    json: { brand_template_id: templateId, data, title },
  });
  const job = created.job || created;
  if (job.status === 'success' && job.result) return job.result;
  const done = await poll(`/autofills/${job.id}`, (d) => d.job || d);
  return done.result;
}

// Export a design to PNG → returns the downloadable file URL(s).
async function exportDesign(designId, format = 'png') {
  const created = await api('POST', '/exports', {
    json: { design_id: designId, format: { type: format } },
  });
  const job = created.job || created;
  const done = (job.status === 'success') ? job : await poll(`/exports/${job.id}`, (d) => d.job || d);
  return done.urls || (done.url ? [done.url] : []);
}

async function downloadBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`canva export download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * High-level: build a branded image from a template.
 * @param {object} p
 * @param {string} p.templateId
 * @param {object} p.data        autofill data keyed by the template's field names
 * @param {string} [p.title]
 * @returns {Promise<Buffer>} PNG
 */
async function generateFromTemplate({ templateId, data, title = `acrogym-${Date.now()}` }) {
  const result = await autofill(templateId, data, title);
  const designId = result.design && (result.design.id || result.design.design_id);
  if (!designId) throw new Error('canva autofill: no design id in result');
  const urls = await exportDesign(designId, 'png');
  if (!urls.length) throw new Error('canva export: no file url');
  return downloadBuffer(urls[0]);
}

module.exports = {
  isConfigured, newPkce, buildAuthUrl, exchangeCode, getAccessToken,
  uploadAsset, getTemplateDataset, autofill, exportDesign, generateFromTemplate,
  TOKENS_PATH, PKCE_PATH, SCOPES, REDIRECT_URL,
};

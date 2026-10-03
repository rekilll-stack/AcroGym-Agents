'use strict';
/* Gmail-клиенты: rekilll@ (credentials.json — общий с gmail-MCP) и info@acrogym.org
   (credentials-info.json, появляется после auth.py). Фабрика mk() — один код на оба ящика. */
const fs = require('fs');
const DIR = '/home/admin/mcp-servers/gmail/';

const dec = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
function part(payload, mime) {
  if (!payload) return '';
  if (payload.mimeType === mime && payload.body && payload.body.data) return dec(payload.body.data);
  for (const p of payload.parts || []) { const t = part(p, mime); if (t) return t; }
  return '';
}
function plain(payload) {
  const t = part(payload, 'text/plain'), h = part(payload, 'text/html');
  /* 03.10: Seesaw (сообщения учителей) кладёт в text/plain заглушку «This email is best viewed in HTML» — тогда берём HTML, иначе письмо разбиралось пустым */
  if (t && !(t.length < 200 && /viewed in html|view (it |this email )?in (your |a )?browser/i.test(t))) return t;
  return h ? h.replace(/<(style|head)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim() : t;
}
function attachments(payload, acc = []) {
  if (!payload) return acc;
  if (payload.filename && payload.body && payload.body.attachmentId) acc.push(payload.filename);
  for (const p of payload.parts || []) attachments(p, acc);
  return acc;
}

function mk(credFile) {
  const CRED = DIR + credFile;
  let _tok = { v: null, exp: 0 };
  async function token() {
    if (_tok.v && Date.now() < _tok.exp) return _tok.v;
    const c = JSON.parse(fs.readFileSync(CRED, 'utf8'));
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token, grant_type: 'refresh_token' }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error('gmail token(' + credFile + '): ' + r.status + ' ' + (await r.text()).slice(0, 120));
    const t = await r.json();
    _tok = { v: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 };
    return _tok.v;
  }
  async function api(path) {
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, { headers: { Authorization: 'Bearer ' + (await token()) }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error('gmail api ' + r.status + ': ' + (await r.text()).slice(0, 120));
    return r.json();
  }
  async function list(query, max = 60) {
    const out = []; let page = null;
    while (out.length < max) {
      const d = await api('messages?q=' + encodeURIComponent(query) + '&maxResults=100' + (page ? '&pageToken=' + page : ''));
      out.push(...(d.messages || []).map((m) => m.id));
      page = d.nextPageToken; if (!page) break;
    }
    return out.slice(0, max);
  }
  async function get(id, bodyChars = 4000) {
    const m = await api('messages/' + id + '?format=full');
    const h = Object.fromEntries((m.payload.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
    return {
      id, from: h.from || '', subject: h.subject || '(без темы)', date: h.date || '',
      ts: +m.internalDate, snippet: m.snippet || '', body: plain(m.payload).slice(0, bodyChars),
      files: attachments(m.payload), threadIdRaw: m.threadId,
      labels: m.labelIds || [],
    };
  }
  async function attachment(msgId, filename) {
    const m = await api('messages/' + msgId + '?format=full');
    let att = null;
    (function walk(p) { if (!p) return; if (p.filename === filename && p.body && p.body.attachmentId) att = p.body.attachmentId; (p.parts || []).forEach(walk); })(m.payload);
    if (!att) return null;
    const d = await api('messages/' + msgId + '/attachments/' + att);
    return Buffer.from(String(d.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }
  async function getHeaders(id) {
    const m = await api('messages/' + id + '?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Message-Id');
    return Object.fromEntries((m.payload.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
  }
  async function send(raw64, threadId) {
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', headers: { Authorization: 'Bearer ' + (await token()), 'Content-Type': 'application/json' },
      body: JSON.stringify(threadId ? { raw: raw64, threadId } : { raw: raw64 }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error('gmail send ' + r.status + ': ' + (await r.text()).slice(0, 160));
    return r.json();
  }
  return { list, get, attachment, getHeaders, send };
}

const rekilll = mk('credentials.json');
module.exports = { ...rekilll, /* обратная совместимость: дефолт — rekilll@ */
  accounts: { rekilll, info: mk('credentials-info.json') },
  /** Клиент по имени ящика из mail.acc; неизвестное → rekilll */
  forAcc: (a) => (a === 'info' ? module.exports.accounts.info : rekilll),
  hasInfo: () => fs.existsSync(DIR + 'credentials-info.json'),
};

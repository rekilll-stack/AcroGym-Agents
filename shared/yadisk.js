'use strict';
/* Яндекс.Диск для бэкапов (27.09, владелец: «в Telegram больше не кидай, кидай на Яндекс»).
   Токен берётся из конфигурации MCP-сервера yandex-disk (~/.claude.json) или env YANDEX_DISK_TOKEN.
   Бэкапы лежат в /AcroGym/Backups/<вид>/ — папку владелец разрешил 27.09. */
const fs = require('fs'), os = require('os'), path = require('path'), https = require('https');
const API = 'https://cloud-api.yandex.net/v1/disk', ROOT = '/AcroGym/Backups';
function token() {
  if (process.env.YANDEX_DISK_TOKEN) return process.env.YANDEX_DISK_TOKEN.trim();
  const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
  const t = j.mcpServers && j.mcpServers['yandex-disk'] && j.mcpServers['yandex-disk'].env && j.mcpServers['yandex-disk'].env.YANDEX_DISK_TOKEN;
  if (!t) throw new Error('нет токена Яндекс.Диска'); return t.trim();
}
function req(method, url, { body, headers = {}, auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const h = { ...headers }; if (auth) h.Authorization = 'OAuth ' + token();
    const r = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: h, timeout: 600000 }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => { const txt = Buffer.concat(ch).toString(); let js = null; try { js = txt ? JSON.parse(txt) : null; } catch (_) {} resolve({ status: res.statusCode, js, txt }); });
    });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('таймаут Яндекс.Диска')));
    if (body && typeof body.pipe === 'function') body.pipe(r); else { if (body) r.write(body); r.end(); }
  });
}
const q = (o) => Object.entries(o).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
async function mkdirp(dir) {
  let cur = ''; for (const part of dir.split('/').filter(Boolean)) { cur += '/' + part;
    const r = await req('PUT', `${API}/resources?${q({ path: cur })}`); if (![201, 409].includes(r.status)) throw new Error(`mkdir ${cur}: ${r.status} ${r.txt.slice(0, 150)}`); }
}
/* загрузка файла; возвращает путь на Диске; размер сверяется после загрузки */
async function upload1(localFile, kind, name) {
  const dir = `${ROOT}/${kind}`, dest = `${dir}/${name || path.basename(localFile)}`, size = fs.statSync(localFile).size;
  await mkdirp(dir);
  const h = await req('GET', `${API}/resources/upload?${q({ path: dest, overwrite: 'true' })}`); if (h.status !== 200 || !h.js || !h.js.href) throw new Error(`upload url: ${h.status} ${h.txt.slice(0, 150)}`);
  const put = await req(h.js.method || 'PUT', h.js.href, { body: fs.createReadStream(localFile), headers: { 'Content-Length': size }, auth: false });
  if (![200, 201, 202].includes(put.status)) throw new Error(`upload: ${put.status} ${put.txt.slice(0, 150)}`);
  for (let i = 0; i < 20; i++) { const m = await req('GET', `${API}/resources?${q({ path: dest, fields: 'size' })}`); if (m.status === 200 && m.js && m.js.size === size) return dest; await new Promise((r) => setTimeout(r, 3000)); }
  throw new Error('на Диске размер не совпал с локальным: ' + dest);
}
/* 03.10: одна сетевая икота (read ECONNRESET в 03:34) роняла ночной бэкап сайта — до 3 попыток; повтор безопасен (overwrite + сверка размера) */
const NET = /ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|socket hang up|таймаут|: 5\d\d /;
async function upload(localFile, kind, name, wait = 30000) {
  for (let i = 1; ; i++) {
    try { return await upload1(localFile, kind, name); }
    catch (e) { if (i >= 3 || !NET.test((e.code || '') + ' ' + e.message)) throw e; await new Promise((r) => setTimeout(r, wait * i)); }
  }
}
/* оставить на Диске последние keep файлов вида kind (по имени — в именах дата) */
async function rotate(kind, keep) {
  const r = await req('GET', `${API}/resources?${q({ path: `${ROOT}/${kind}`, limit: 500, fields: '_embedded.items.name,_embedded.items.path,_embedded.items.type' })}`);
  if (r.status !== 200) return 0; const files = ((r.js._embedded || {}).items || []).filter((x) => x.type === 'file').sort((a, b) => b.name.localeCompare(a.name));
  let n = 0; for (const f of files.slice(keep)) { const d = await req('DELETE', `${API}/resources?${q({ path: f.path, permanently: 'true' })}`); if ([202, 204].includes(d.status)) n++; } return n;
}
module.exports = { upload, rotate, mkdirp, ROOT };

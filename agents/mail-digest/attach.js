'use strict';
/* Извлечение текста из вложений: PDF → pypdf (venv моста); jpeg/png — пропускаем (vision дорого, по запросу). */
const { execFileSync } = require('child_process');
const fs = require('fs');
const gmail = require('./gmail.js');
const PY = '/home/admin/mcp-servers/jarvis-bridge/.tts-venv/bin/python';

async function pdfText(msgId, filename, gm = gmail, maxChars = 2500) {
  try {
    const buf = await gm.attachment(msgId, filename);
    if (!buf || buf.length > 5e6) return null;
    const tmp = '/tmp/claude-1000/att-' + Date.now() + '.pdf';
    fs.writeFileSync(tmp, buf);
    const out = execFileSync(PY, ['-c', `
import sys
from pypdf import PdfReader
r = PdfReader(sys.argv[1])
t = "\\n".join((p.extract_text() or "") for p in r.pages[:6])
print(t[:${maxChars}])`, tmp], { timeout: 60000 }).toString();
    fs.unlinkSync(tmp);
    return out.replace(/\s+/g, ' ').trim() || null;
  } catch (_) { return null; }
}
/** Скан или картинка → PNG-страницы для vision (pdf.js+chromium; poppler на сервере нет). */
async function pdfImages(msgId, filename, gm = gmail, pages = 2) {
  const buf = await gm.attachment(msgId, filename);
  if (!buf || buf.length > 8e6) return [];
  const stamp = '/tmp/claude-1000/att-' + process.pid + '-' + msgId.slice(0, 8);
  const src = stamp + '.pdf';
  fs.writeFileSync(src, buf);
  const out = [];
  for (let p = 1; p <= pages; p++) {
    const png = `${stamp}-${p}.png`;
    try {
      execFileSync('node', [__dirname + '/pdfshot.js', src, String(p), png], { timeout: 90000, stdio: 'pipe' });
      out.push({ data: fs.readFileSync(png).toString('base64'), media_type: 'image/png' });
      fs.unlinkSync(png);
    } catch (_) { break; } /* страницы кончились */
  }
  fs.unlinkSync(src);
  return out;
}
/** Вложение-картинка (jpeg/png) → блок для vision. */
async function imageBlock(msgId, filename, gm = gmail) {
  const buf = await gm.attachment(msgId, filename);
  if (!buf || buf.length > 5e6) return null;
  const ext = (filename.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  return { data: buf.toString('base64'), media_type: ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg' };
}
module.exports = { pdfText, pdfImages, imageBlock };

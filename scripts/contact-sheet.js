'use strict';
// Dev: tile catalog photo previews into contact sheets to eyeball variety.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');
const yandex = require('../agents/content-bot/yandex');

const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'photo-catalog.json'), 'utf8')).photos;
const OUT = '/tmp/claude-1000/-home-admin/a3a49594-2131-486a-9c16-0a30f6f138c8/scratchpad/sheets/';
const FOLDERS = ['/AcroGym/Marketing/Photos/Competitions May 2025', '/AcroGym/Marketing/AcroGym Competiton 2026'];

const mode = process.argv[2] || 'good'; // good | all
const COLS = 6, ROWS = 8, CELL = 200, LBL = 26;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const prev = new Map();
  for (const f of FOLDERS) {
    const imgs = await yandex.listImages(f, { limit: 500, previewSize: 'M' });
    for (const i of imgs) prev.set(i.path, i.preview);
  }
  let pool = cat.filter((p) => prev.get(p.path));
  if (mode === 'good') pool = pool.filter((p) => p.quality >= 0.6 && p.vertical_crop >= 0.55 && p.subject !== 'crowd');
  pool.sort((a, b) => (b.quality + b.vertical_crop) - (a.quality + a.vertical_crop));
  pool = pool.slice(0, COLS * ROWS * 3); // up to 3 sheets

  const per = COLS * ROWS;
  const sheets = Math.ceil(pool.length / per);
  for (let s = 0; s < sheets; s++) {
    const W = COLS * CELL, H = ROWS * (CELL + LBL);
    const c = createCanvas(W, H); const ctx = c.getContext('2d');
    ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H);
    for (let k = 0; k < per; k++) {
      const gi = s * per + k; if (gi >= pool.length) break;
      const p = pool[gi];
      const col = k % COLS, row = Math.floor(k / COLS);
      const x = col * CELL, y = row * (CELL + LBL);
      try {
        const img = await loadImage(await yandex.fetchPreview(prev.get(p.path)));
        const sc = Math.min(CELL / img.width, CELL / img.height);
        const w = img.width * sc, h = img.height * sc;
        ctx.drawImage(img, x + (CELL - w) / 2, y + (CELL - h) / 2, w, h);
      } catch { /* skip */ }
      ctx.fillStyle = '#fff'; ctx.font = '12px sans';
      ctx.fillText(`#${gi} ${p.subject.slice(0, 10)} q${p.quality} v${p.vertical_crop}`, x + 3, y + CELL + 15);
    }
    fs.writeFileSync(`${OUT}${mode}_sheet${s + 1}.jpg`, c.toBuffer('image/jpeg', { quality: 0.82 }));
  }
  console.log('mode', mode, 'pool', pool.length, 'sheets', sheets, '→', OUT);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });

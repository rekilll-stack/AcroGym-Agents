'use strict';

/**
 * Track D (D.1/D.2) — branded image engine. No Telegram, no network.
 *   node scripts/test-content-image.js
 */

const { composeBrandedImage, loadManifest, wrapLines, fitText, SIZE } = require('../agents/content-bot/image');
const { createCanvas } = require('canvas');

let pass = 0, fail = 0;
const T = (n, c) => { console.log((c ? '  ✅ ' : '  ❌ ') + n); c ? pass++ : fail++; };
const isPng = (buf) => Buffer.isBuffer(buf) && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

(async () => {
  console.log('=== manifest ===');
  const m = loadManifest();
  T('manifest loads as array', Array.isArray(m));
  T('test bg present + flagged dev (hidden from menu)', m.some(b => b.file === '_test.png' && b.dev === true));
  T('entries carry file + bilingual label + textZone', m.every(b => b.file && b.label && b.label.en && b.label.ru && b.textZone));

  console.log('\n=== text fit / wrap (auto-size, auto-wrap) ===');
  const ctx = createCanvas(SIZE, SIZE).getContext('2d');
  const long = 'Grow through movement, confidence, and joy at AcroGym this September';
  const fit = fitText(ctx, long, SIZE - 180, 340);
  T('fit returns size within range', fit.size >= 40 && fit.size <= 96);
  T('long text wraps to multiple lines', fit.lines.length >= 2);
  const shortFit = fitText(ctx, 'Big joy', SIZE - 180, 340);
  T('short text → larger font than long', shortFit.size >= fit.size);
  ctx.font = '60px sans-serif';
  T('wrapLines never drops words', wrapLines(ctx, 'one two three four', 50).join(' ').split(/\s+/).length === 4);

  console.log('\n=== compose: valid 1080×1080 PNG for each scrim + zone ===');
  for (const scrim of ['blue-gradient', 'dark-band', 'none']) {
    const buf = await composeBrandedImage({ backgroundPath: 'config/brand/backgrounds/_test.png', text: 'Grow through movement and joy', scrim, textZone: 'bottom', logo: true });
    T(`scrim '${scrim}' → valid PNG`, isPng(buf) && buf.length > 1000);
  }
  for (const zone of ['bottom', 'center', 'band']) {
    const buf = await composeBrandedImage({ backgroundPath: 'config/brand/backgrounds/_test.png', text: 'Every child a small victory', textZone: zone });
    T(`zone '${zone}' → valid PNG`, isPng(buf));
  }
  const noLogo = await composeBrandedImage({ backgroundPath: 'config/brand/backgrounds/_test.png', text: 'No logo variant', logo: false });
  T('logo:false still renders', isPng(noLogo));

  console.log('\n🔴 boundary: engine returns a buffer, no publish/upload anywhere');
  const src = require('fs').readFileSync(require('path').join(__dirname, '../agents/content-bot/image.js'), 'utf8');
  T('no instagram/graph/upload/http in image engine', !/instagram|graph\.facebook|upload|axios|node-fetch|https?\.request/i.test(src));

  console.log(`\n═══ Results: ${pass} passed, ${fail} failed ═══`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.stack); process.exit(1); });

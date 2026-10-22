const fs = require('fs');
const { chromium } = require('/home/admin/acrogym-design-system/.ds-sync/node_modules/playwright');
const D = '/tmp/claude-1000/sticker/';
const b64 = (p, m) => `data:${m};base64,` + fs.readFileSync(p).toString('base64');
const LOGO_W = b64(D + 'logo-white-trim.png', 'image/png');
const GERHAUS = b64('/home/admin/acrogym/config/brand/fonts/Gerhaus-Regular.otf', 'font/otf');
const QR = b64(D + 'qr-ig.png', 'image/png');

// Ø200 мм стикер + 3 мм вылет по кругу => холст 206 мм
const page = (inner, bodyBg) => `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:Gerhaus;src:url(${GERHAUS})}
@page{size:206mm 206mm;margin:0}
*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{width:206mm;height:206mm;background:${bodyBg};font-family:Montserrat,sans-serif;
     display:flex;align-items:center;justify-content:center}
.badge{width:206mm;height:206mm;border-radius:50%;position:relative;overflow:hidden}
.in{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
    justify-content:center;text-align:center;padding:24mm 16mm}
.logo{width:82mm;display:block}
.kicker{font-size:13pt;font-weight:600;letter-spacing:.40em;text-transform:uppercase}
.hand{font-size:42pt;font-weight:700;line-height:1;letter-spacing:-.005em;
      display:flex;align-items:center;gap:4.5mm}
.ig{width:15mm;height:15mm;flex:none}
.rule{width:56mm;height:1mm;border-radius:1mm;background:#F37021}
.qrbox{background:#fff;border-radius:5mm;padding:3.2mm;display:block}
.qrbox img{width:30mm;display:block}
.scan{font-size:9.5pt;font-weight:500;letter-spacing:.26em;text-transform:uppercase}
</style>${inner}`;

// ── Вариант A: печать на плёнке, глубокий бренд-синий
const A = page(`<div class="badge" style="background:radial-gradient(120% 120% at 32% 8%,#3A49A8 0%,#28347F 52%,#1B2358 100%)">
  <div style="position:absolute;inset:-4mm;background:radial-gradient(38mm 38mm at 84% 10%,rgba(243,112,33,.30),transparent 70%),radial-gradient(44mm 44mm at 10% 92%,rgba(120,150,255,.28),transparent 70%)"></div>
  <div style="position:absolute;inset:8mm;border:1.3mm solid #F37021;border-radius:50%"></div>
  <div style="position:absolute;inset:11.5mm;border:.4mm solid rgba(255,255,255,.22);border-radius:50%"></div>
  <div class="in">
    <img class="logo" src="${LOGO_W}">
    <div class="kicker" style="color:#F9BE93;margin-top:8mm">Tag us in your story</div>
    <div class="hand" style="color:#fff;margin-top:7mm"><svg class="ig" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="2" width="20" height="20" rx="5.6"/><circle cx="12" cy="12" r="5"/><circle cx="17.7" cy="6.3" r="1.35" fill="currentColor" stroke="none"/></svg><span>@acrogymqatar</span></div>
    <div class="rule" style="margin:7mm 0 6mm"></div>
    <div class="qrbox"><img src="${QR}"></div>
    <div class="scan" style="color:rgba(255,255,255,.78);margin-top:4mm">Scan to follow</div>
  </div></div>`, '#ffffff');

// ── Вариант B: вырезка/печать белым по прозрачной плёнке (видно зеркало)
const B = page(`<div class="badge">
  <div style="position:absolute;inset:8mm;border:1.3mm solid #F37021;border-radius:50%"></div>
  <div style="position:absolute;inset:11.5mm;border:.4mm solid rgba(255,255,255,.55);border-radius:50%"></div>
  <div class="in">
    <img class="logo" src="${LOGO_W}">
    <div class="kicker" style="color:#fff;margin-top:8mm">Tag us in your story</div>
    <div class="hand" style="color:#fff;margin-top:7mm"><svg class="ig" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="2" width="20" height="20" rx="5.6"/><circle cx="12" cy="12" r="5"/><circle cx="17.7" cy="6.3" r="1.35" fill="currentColor" stroke="none"/></svg><span>@acrogymqatar</span></div>
    <div class="rule" style="margin:7mm 0 6mm"></div>
    <div class="qrbox" style="background:#fff"><img src="${QR}"></div>
    <div class="scan" style="color:#fff;margin-top:4mm">Scan to follow</div>
  </div></div>`, 'transparent');

(async () => {
  const br = await chromium.launch({ args: ['--no-sandbox'] });
  const shots = [];
  for (const [name, html, shotBg] of [
    ['AcroGym-Mirror-Sticker-Blue', A, null],
    ['AcroGym-Mirror-Sticker-Cut', B, '#8d9199'],   // серый фон превью = зеркало
  ]) {
    const p = await br.newPage({ viewport: { width: 820, height: 820 } });
    await p.setContent(html, { waitUntil: 'load' });
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(900);
    if (shotBg) await p.evaluate((c) => (document.body.style.background = c), shotBg);
    await p.screenshot({ path: D + name + '.png' });
    if (shotBg) await p.evaluate(() => (document.body.style.background = 'transparent'));
    const pdf = await p.pdf({ width: '206mm', height: '206mm', printBackground: true,
                             margin: { top: 0, bottom: 0, left: 0, right: 0 } });
    fs.writeFileSync(D + name + '.pdf', pdf);
    shots.push([name, pdf.length]);
    await p.close();
  }
  await br.close();
  console.log(shots.map(([n, s]) => `${n}.pdf ${(s / 1024).toFixed(0)} КБ`).join('\n'));
})();

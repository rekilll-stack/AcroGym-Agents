const fs = require('fs');
const { chromium } = require('/home/admin/acrogym-design-system/.ds-sync/node_modules/playwright');
const D = '/tmp/claude-1000/sign/';
const b64 = (p, m) => `data:${m};base64,` + fs.readFileSync(p).toString('base64');
const LOGO = b64('/tmp/claude-1000/sticker/logo-white-trim.png', 'image/png');

const NAVY = '#28347F', ORANGE = '#F37021', GROUND = '#EEF1F7', INK = '#1B2358';

/* Знак «нельзя»: кроссовок в перечёркнутом оранжевом кольце */
const shoeIcon = `
<svg viewBox="0 0 200 200" class="ic">
  <circle cx="100" cy="100" r="86" fill="none" stroke="${ORANGE}" stroke-width="14"/>
  <g transform="translate(100,100) scale(.80) translate(-93,-95.5)">
    <path fill="${INK}" d="M28 122 C23 122 20 118 22 113 C25 103 31 95 41 91
                           L98 70 C108 66 116 61 124 56 C130 52 138 52 143 57
                           L152 65 C158 71 161 78 161 86 L161 114
                           C161 119 157 122 152 122 Z"/>
    <rect x="18" y="126" width="150" height="13" rx="6.5" fill="${INK}"/>
    <g stroke="${GROUND}" stroke-width="5" stroke-linecap="round">
      <line x1="60" y1="86" x2="66" y2="101"/>
      <line x1="76" y1="80" x2="82" y2="95"/>
      <line x1="92" y1="74" x2="98" y2="89"/>
    </g>
  </g>
  <line x1="40" y1="160" x2="160" y2="40" stroke="${ORANGE}" stroke-width="14" stroke-linecap="round"/>
</svg>`;

/* Знак «можно»: след босой ноги в сплошном кольце + галочка */
const footIcon = `
<svg viewBox="0 0 200 200" class="ic">
  <circle cx="100" cy="100" r="86" fill="none" stroke="${NAVY}" stroke-width="14"/>
  <g fill="${NAVY}" transform="translate(100,100) scale(.86) translate(-104,-101.5)">
    <ellipse cx="100" cy="128" rx="27" ry="34"/>
    <ellipse cx="102" cy="86"  rx="34" ry="26"/>
    <circle cx="74"  cy="62" r="11"/>
    <circle cx="93"  cy="53" r="10"/>
    <circle cx="110" cy="51" r="9"/>
    <circle cx="125" cy="55" r="8"/>
    <circle cx="138" cy="63" r="7"/>
  </g>
  <g transform="translate(152,152)">
    <circle r="27" fill="${ORANGE}"/>
    <path d="M-11 1 L-3 10 L12 -9" fill="none" stroke="#fff" stroke-width="7.5"
          stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;

const page = (W, H, k) => `<!doctype html><meta charset="utf-8"><style>
@page{size:${W}mm ${H}mm;margin:0}
*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{width:${W}mm;height:${H}mm;background:${GROUND};font-family:Montserrat,sans-serif;color:${INK};
     display:flex;flex-direction:column;text-align:center}

.band{background:${NAVY};color:#fff;flex:none;display:flex;align-items:center;justify-content:center}
.top{height:${42*k}mm;border-bottom:${2.4*k}mm solid ${ORANGE}}
.top img{width:${58*k}mm}
.bot{height:${26*k}mm;border-top:${2.4*k}mm solid ${ORANGE};flex-direction:column;gap:${1.5*k}mm;
     font-size:${9.5*k}pt;font-weight:600;letter-spacing:.14em;text-transform:uppercase}
.bot .ar{color:#fff;font-family:'Noto Kufi Arabic',sans-serif;direction:rtl;font-size:${8.4*k}pt;
         letter-spacing:0;text-transform:none;font-weight:600}

main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;
     gap:${8*k}mm;padding:${10*k}mm ${12*k}mm}
.icons{display:flex;align-items:center;justify-content:center;gap:${11*k}mm}
.ic{width:${60*k}mm;height:${60*k}mm}

h1{font-size:${40*k}pt;font-weight:800;letter-spacing:${-0.5*k}pt;line-height:.95;color:${NAVY}}
.sub{font-size:${15*k}pt;font-weight:600;line-height:1.35;max-width:${152*k}mm}
.rule{width:${58*k}mm;height:${1.2*k}mm;background:${ORANGE};border-radius:${1*k}mm}
.ar{font-family:'Noto Kufi Arabic',sans-serif;direction:rtl;color:${NAVY};
    font-size:${33*k}pt;font-weight:800;line-height:1.25}
.ar-sub{font-family:'Noto Kufi Arabic',sans-serif;direction:rtl;font-size:${13*k}pt;
        font-weight:600;line-height:1.6;max-width:${152*k}mm}
</style>

<div class="band top"><img src="${LOGO}"></div>

<main>
  <div class="icons">${shoeIcon}${footIcon}</div>
  <h1>SHOES OFF</h1>
  <div class="sub">Please remove your shoes<br>before stepping onto the mat</div>
  <div class="rule"></div>
  <div class="ar">الرجاء خلع الأحذية</div>
  <div class="ar-sub">قبل الدخول إلى منطقة البساط</div>
</main>

<div class="band bot">
  <div>Socks on, please · non-slip grip socks work best</div>
  <div class="ar">يُفضّل ارتداء جوارب مانعة للانزلاق · شكراً لتعاونكم</div>
</div>`;

(async () => {
  const br = await chromium.launch({ args: ['--no-sandbox'] });
  for (const [name, W, H, k, vw] of [
    ['AcroGym-Sign-ShoesOff-A4', 210, 297, 1,    794],
    ['AcroGym-Sign-ShoesOff-A3', 297, 420, 1.41, 1123],
  ]) {
    const p = await br.newPage({ viewport: { width: vw, height: Math.round(vw * H / W) } });
    await p.setContent(page(W, H, k), { waitUntil: 'load' });
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(900);
    await p.screenshot({ path: D + name + '.png' });
    const pdf = await p.pdf({ width: W + 'mm', height: H + 'mm', printBackground: true,
                             margin: { top: 0, bottom: 0, left: 0, right: 0 } });
    fs.writeFileSync(D + name + '.pdf', pdf);
    console.log(name + '.pdf', (pdf.length / 1024).toFixed(0) + ' КБ');
    await p.close();
  }
  await br.close();
})();

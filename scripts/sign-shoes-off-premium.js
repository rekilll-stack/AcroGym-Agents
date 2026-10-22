const fs = require('fs');
const { chromium } = require('/home/admin/acrogym-design-system/.ds-sync/node_modules/playwright');
const D = '/tmp/claude-1000/sign/';
const b64 = (p, m) => `data:${m};base64,` + fs.readFileSync(p).toString('base64');
const LOGO = b64('/tmp/claude-1000/sticker/logo-white-trim.png', 'image/png');

/* Премиум-вариант: каменное поле, глубокий индиго, тонкие линии, контурная иконка.
   Ни заливок-плашек, ни бликов — «воздух» вместо декора. */
const INK = '#161D45', IVORY = '#F6F3EC', IVORY2 = '#EDE9F5', ORANGE = '#F8802E', STONE = '#E9E7E2';

const icon = `
<svg viewBox="0 0 220 220" class="ic">
  <circle cx="110" cy="110" r="96" fill="none" stroke="${ORANGE}" stroke-width="7"/>
  <g fill="none" stroke="${IVORY}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"
     transform="translate(110,112) scale(.86) translate(-93,-96)">
    <path d="M28 122 C23 122 20 118 22 113 C25 103 31 95 41 91
             L98 70 C108 66 116 61 124 56 C130 52 138 52 143 57
             L152 65 C158 71 161 78 161 86 L161 122 C161 126 158 129 154 130"/>
    <path d="M22 130 L164 130"/>
    <path d="M60 86 L66 101 M76 80 L82 95 M92 74 L98 89"/>
  </g>
  <line x1="42" y1="178" x2="178" y2="42" stroke="${ORANGE}" stroke-width="7" stroke-linecap="round"/>
</svg>`;

const page = (W, H, k) => `<!doctype html><meta charset="utf-8"><style>
@page{size:${W}mm ${H}mm;margin:0}
*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{width:${W}mm;height:${H}mm;background:${STONE};color:${IVORY};font-family:Montserrat,sans-serif;
     text-align:center;padding:${9*k}mm}
.frame{width:100%;height:100%;background:${INK};padding:${11*k}mm ${10*k}mm;
       display:flex;flex-direction:column;align-items:center;justify-content:space-between;position:relative}
.frame::before{content:'';position:absolute;inset:${4*k}mm;border:${0.45*k}mm solid ${ORANGE};opacity:.75}

.head{display:flex;flex-direction:column;align-items:center;gap:${6*k}mm;z-index:1}
.head img{width:${50*k}mm}
.eyebrow{font-size:${8.5*k}pt;font-weight:700;letter-spacing:.42em;text-transform:uppercase;color:${ORANGE}}

.mid{display:flex;flex-direction:column;align-items:center;gap:${7*k}mm;z-index:1}
.ic{width:${64*k}mm;height:${64*k}mm}
h1{font-size:${40*k}pt;font-weight:800;letter-spacing:.04em;line-height:1}
.sub{font-size:${14*k}pt;font-weight:600;line-height:1.45;color:${IVORY};max-width:${148*k}mm}
.hair{width:${50*k}mm;height:${1*k}mm;background:${ORANGE};border-radius:${1*k}mm}
.ar{font-family:'Noto Kufi Arabic',sans-serif;direction:rtl;font-size:${33*k}pt;
    font-weight:800;line-height:1.3}
.ar-sub{font-family:'Noto Kufi Arabic',sans-serif;direction:rtl;font-size:${11.5*k}pt;
        font-weight:600;line-height:1.7;color:${IVORY};max-width:${148*k}mm}

.foot{display:flex;flex-direction:column;align-items:center;gap:${1.8*k}mm;z-index:1;
      font-size:${8.6*k}pt;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:${IVORY2}}
.foot .ar-f{color:${IVORY2};font-family:'Noto Kufi Arabic',sans-serif;direction:rtl;font-size:${8*k}pt;
            letter-spacing:0;text-transform:none;font-weight:500}
</style>

<div class="frame">
  <div class="head">
    <img src="${LOGO}">
    <div class="eyebrow">Lagoona Mall · Doha</div>
  </div>

  <div class="mid">
    ${icon}
    <h1>SHOES OFF</h1>
    <div class="sub">Please remove your shoes before stepping onto the mat</div>
    <div class="hair"></div>
    <div class="ar">الرجاء خلع الأحذية</div>
    <div class="ar-sub">قبل الدخول إلى منطقة البساط</div>
  </div>

  <div class="foot">
    <div>Socks on, please · non-slip grip socks work best</div>
    <div class="ar-f">يُفضّل ارتداء جوارب مانعة للانزلاق · شكراً لتعاونكم</div>
  </div>
</div>`;

(async () => {
  const br = await chromium.launch({ args: ['--no-sandbox'] });
  for (const [name, W, H, k, vw] of [
    ['AcroGym-Sign-ShoesOff-Premium-A4', 210, 297, 1,    794],
    ['AcroGym-Sign-ShoesOff-Premium-A3', 297, 420, 1.41, 1123],
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

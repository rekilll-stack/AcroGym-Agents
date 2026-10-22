/* Табличка «Только по записи» (владелец 15.09: «мы не детская игровая, вход по предварительному бронированию;
   без брони можем не взять ребёнка в группу»). Тот же конвейер, что у SHOES OFF: HTML → Chromium → PDF A4/A3.
   Правило владельца: английский и арабский равного веса, ни один не мельче (см. память reference «SHOES OFF»).
   node sign-booking.js → /tmp/claude-1000/sign/AcroGym-Sign-BookingOnly-A4.pdf + A3 (+ PNG для просмотра) */
const fs = require('fs');
const { chromium } = require('/home/admin/acrogym-design-system/.ds-sync/node_modules/playwright');
const D = '/tmp/claude-1000/sign/';
const b64 = (p, m) => `data:${m};base64,` + fs.readFileSync(p).toString('base64');
const LOGO = b64('/tmp/claude-1000/sticker/logo-white-trim.png', 'image/png');

const NAVY = '#28347F', ORANGE = '#F37021', GROUND = '#EEF1F7', INK = '#1B2358';

/* Знак «можно»: календарь с галочкой — занятие забронировано */
const bookIcon = `
<svg viewBox="0 0 200 200" class="ic">
  <circle cx="100" cy="100" r="86" fill="none" stroke="${NAVY}" stroke-width="14"/>
  <g transform="translate(100,98)">
    <rect x="-48" y="-44" width="96" height="88" rx="12" fill="none" stroke="${NAVY}" stroke-width="10"/>
    <line x1="-48" y1="-18" x2="48" y2="-18" stroke="${NAVY}" stroke-width="10"/>
    <line x1="-26" y1="-60" x2="-26" y2="-32" stroke="${NAVY}" stroke-width="11" stroke-linecap="round"/>
    <line x1="26" y1="-60" x2="26" y2="-32" stroke="${NAVY}" stroke-width="11" stroke-linecap="round"/>
  </g>
  <g transform="translate(150,150)">
    <circle r="30" fill="${ORANGE}"/>
    <path d="M-12 1 L-3 11 L13 -10" fill="none" stroke="#fff" stroke-width="8"
          stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;

/* Знак «нельзя»: мячик и кубик игровой комнаты в перечёркнутом кольце */
const playIcon = `
<svg viewBox="0 0 200 200" class="ic">
  <circle cx="100" cy="100" r="86" fill="none" stroke="${ORANGE}" stroke-width="14"/>
  <g transform="translate(100,104)">
    <rect x="-52" y="2" width="48" height="40" rx="9" fill="none" stroke="${INK}" stroke-width="9"/>
    <rect x="2" y="2" width="48" height="40" rx="9" fill="none" stroke="${INK}" stroke-width="9"/>
    <rect x="-25" y="-42" width="48" height="40" rx="9" fill="none" stroke="${INK}" stroke-width="9"/>
    <g fill="${INK}"><circle cx="-38" cy="-6" r="5"/><circle cx="-18" cy="-6" r="5"/><circle cx="16" cy="-6" r="5"/><circle cx="36" cy="-6" r="5"/><circle cx="-11" cy="-50" r="5"/><circle cx="9" cy="-50" r="5"/></g>
  </g>
  <line x1="40" y1="160" x2="160" y2="40" stroke="${ORANGE}" stroke-width="14" stroke-linecap="round"/>
</svg>`;

const page = (W, H, k) => `<!doctype html><meta charset="utf-8"><style>
@page{size:${W}mm ${H}mm;margin:0}
*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{width:${W}mm;height:${H}mm;background:${GROUND};font-family:Montserrat,sans-serif;color:${INK};
     display:flex;flex-direction:column;text-align:center}

.band{background:${NAVY};color:#fff;flex:none;display:flex;align-items:center;justify-content:center}
.top{height:${40*k}mm;border-bottom:${2.4*k}mm solid ${ORANGE}}
.top img{width:${56*k}mm}
.bot{height:${28*k}mm;border-top:${2.4*k}mm solid ${ORANGE};flex-direction:column;gap:${1.6*k}mm;
     font-size:${9.5*k}pt;font-weight:600;letter-spacing:.12em;text-transform:uppercase}
.bot .ar{color:#fff;font-family:'Noto Kufi Arabic',sans-serif;direction:rtl;font-size:${9*k}pt;
         letter-spacing:0;text-transform:none;font-weight:600}

main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;
     gap:${6.5*k}mm;padding:${8*k}mm ${11*k}mm}
.icons{display:flex;align-items:center;justify-content:center;gap:${10*k}mm}
.ic{width:${52*k}mm;height:${52*k}mm}

h1{font-size:${37*k}pt;font-weight:800;letter-spacing:${-0.5*k}pt;line-height:.95;color:${NAVY}}
.sub{font-size:${14*k}pt;font-weight:600;line-height:1.35;max-width:${150*k}mm}
.warn{font-size:${12.5*k}pt;font-weight:700;line-height:1.35;color:${ORANGE};max-width:${168*k}mm}
.rule{width:${56*k}mm;height:${1.2*k}mm;background:${ORANGE};border-radius:${1*k}mm}
.ar{font-family:'Noto Kufi Arabic',sans-serif;direction:rtl;color:${NAVY};
    font-size:${30*k}pt;font-weight:800;line-height:1.3}
.ar-sub{font-family:'Noto Kufi Arabic',sans-serif;direction:rtl;font-size:${12.2*k}pt;
        font-weight:600;line-height:1.65;max-width:${150*k}mm}
.ar-warn{font-family:'Noto Kufi Arabic',sans-serif;direction:rtl;font-size:${10.5*k}pt;
         font-weight:700;line-height:1.6;color:${ORANGE};max-width:${150*k}mm}
</style>

<div class="band top"><img src="${LOGO}"></div>

<main>
  <div class="icons">${bookIcon}${playIcon}</div>
  <h1>BOOKING<br>REQUIRED</h1>
  <div class="sub">Classes run to a schedule and places in each group are limited.</div>
  <div class="warn">Without a booking we may not be able to take your child into the group.</div>
  <div class="rule"></div>
  <div class="ar">الحجز المسبق مطلوب</div>
  <div class="ar-sub">الحصص وفق جدول محدّد والأماكن في كل مجموعة محدودة.</div>
  <div class="ar-warn">بدون حجز مسبق قد لا نتمكّن من ضمّ طفلكم إلى المجموعة.</div>
</main>

<div class="band bot">
  <div>Book ahead · reception · +974 7085 9382 · acrogym.org</div>
  <div class="ar">للحجز يُرجى التواصل مع الاستقبال</div>
</div>`;

(async () => {
  const br = await chromium.launch({ args: ['--no-sandbox'] });
  for (const [name, W, H, k, vw] of [
    ['AcroGym-Sign-BookingOnly-A4', 210, 297, 1, 794],
    ['AcroGym-Sign-BookingOnly-A3', 297, 420, 1.41, 1123],
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

const fs = require('fs');
const { chromium } = require('/home/admin/acrogym-design-system/.ds-sync/node_modules/playwright');
const b64 = (p, m) => `data:${m};base64,` + fs.readFileSync(p).toString('base64');
const LOGO = b64('/tmp/claude-1000/sticker/logo-white-trim.png', 'image/png');
const QR = b64('/tmp/claude-1000/price/qr-hi.png', 'image/png');

const NAVY = '#161D45', BLUE = '#28347F', ORANGE = '#F37021', IVORY = '#F6F3EC', INK = '#1B2350', STONE = '#EEF1F7';

const html = `<!doctype html><meta charset="utf-8"><style>
@page{size:210mm 297mm;margin:0}
*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{width:210mm;height:297mm;overflow:hidden;background:${STONE};font-family:Montserrat,sans-serif;color:${INK};display:flex;flex-direction:column}

.head{background:${NAVY};color:#fff;padding:6.5mm 14mm 6mm;display:flex;align-items:center;justify-content:space-between;border-bottom:2mm solid ${ORANGE}}
.head img{width:38mm}
.head .r{text-align:right}
.head h1{font-size:23pt;font-weight:800;letter-spacing:.04em}
.head .sub{font-size:9pt;font-weight:600;letter-spacing:.24em;text-transform:uppercase;color:#F7B98A;margin-top:1.5mm}

main{flex:1;padding:7mm 14mm 0;display:flex;flex-direction:column}
.plans{display:flex;gap:5mm}
.plan{flex:1;background:#fff;border:0.4mm solid #DDD9E8;border-radius:5mm;padding:5.5mm 5mm;position:relative}
.plan.hot{background:${NAVY};color:#fff;border:0.6mm solid ${ORANGE}}
.tag{position:absolute;top:-3.2mm;left:50%;transform:translateX(-50%);background:${ORANGE};color:#fff;
     font-size:7pt;font-weight:700;letter-spacing:.14em;padding:1.2mm 4mm;border-radius:4mm;text-transform:uppercase;white-space:nowrap}
.pname{font-size:8.5pt;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:${ORANGE}}
.price{font-size:21pt;font-weight:800;margin:1.5mm 0 0.5mm}
.price span{font-size:9pt;font-weight:600;opacity:.65}
.per{font-size:8pt;font-weight:600;opacity:.6;margin-bottom:3.5mm}
.f{font-size:8.8pt;line-height:1.45;padding:1.3mm 0;border-top:0.25mm solid rgba(128,128,160,.25);display:flex;justify-content:space-between;gap:2mm}
.plan.hot .f{border-top-color:rgba(255,255,255,.16)}
.f b{font-variant-numeric:tabular-nums;white-space:nowrap}
.note{font-size:7.6pt;line-height:1.45;opacity:.72;margin-top:3mm}

h2{font-size:9.5pt;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:${BLUE};margin:5.5mm 0 2.5mm}
.grid2{display:flex;gap:5mm}
.box{flex:1;background:#fff;border:0.4mm solid #DDD9E8;border-radius:5mm;padding:5mm 5.5mm}
.box .f{font-size:9.3pt}
.box .f:first-of-type{border-top:0}

.good{display:flex;gap:5mm;margin:5.5mm 0 5mm}
.chip{flex:1;background:${BLUE};color:#fff;border-radius:5mm;padding:4mm 4.5mm;font-size:8.6pt;line-height:1.45;font-weight:600}
.chip .ic{display:block;font-size:10.5pt;font-weight:800;color:#F7B98A;margin-bottom:1mm;letter-spacing:.06em}
.steps{display:flex;gap:5mm}
.step{flex:1;background:#fff;border:0.4mm solid #DDD9E8;border-radius:5mm;padding:4mm 4.5mm;font-size:8.6pt;line-height:1.45}
.step .n{width:7mm;height:7mm;border-radius:50%;background:${ORANGE};color:#fff;font-weight:800;font-size:11pt;
        display:flex;align-items:center;justify-content:center;margin-bottom:2.5mm}
.step b{color:${BLUE}}
.chip b{color:#F7B98A}

/* скидка за продление в день окончания — купон с перфорацией */
.renew{margin-top:5mm;display:flex;background:#fff;border:0.6mm solid ${ORANGE};border-radius:5mm;position:relative}
.renew .pct{background:${ORANGE};color:#fff;font-weight:800;font-size:25pt;letter-spacing:.01em;width:34mm;display:flex;align-items:center;justify-content:center;border-radius:4.4mm 0 0 4.4mm}
.renew .txt{flex:1;padding:3.6mm 6mm 3.6mm 7mm;border-left:0.5mm dashed ${ORANGE};display:flex;flex-direction:column;justify-content:center}
.renew .lb{font-size:7pt;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:${ORANGE}}
.renew .t{font-size:11.5pt;font-weight:800;color:${NAVY};margin-top:0.8mm}
.renew .d{font-size:8.4pt;line-height:1.45;opacity:.75;margin-top:0.8mm}
.renew .notch{position:absolute;left:31.75mm;width:5mm;height:5mm;border-radius:50%;background:${STONE};border:0.6mm solid ${ORANGE}}
.renew .notch.t1{top:-3.1mm;clip-path:inset(50% 0 0 0)}
.renew .notch.b1{bottom:-3.1mm;clip-path:inset(0 0 50% 0)}

.foot{margin-top:auto;background:${NAVY};color:#fff;padding:4.5mm 14mm;display:flex;align-items:center;justify-content:space-between;border-top:2mm solid ${ORANGE}}
.foot .c{font-size:9pt;line-height:1.7;font-weight:600}
.foot .c span{color:#F7B98A}
.foot img{width:20mm;background:#fff;border-radius:2.5mm;padding:1.5mm}
</style>

<div class="head">
  <img src="${LOGO}">
  <div class="r"><h1>PRICE LIST</h1><div class="sub">Season 2026/27 · Lagoona Mall</div></div>
</div>

<main>
  <div class="plans">
    <div class="plan hot">
      <div class="pname">Monthly</div>
      <div class="price" style="color:#fff">550 <span>QAR / month</span></div>
      <div class="per" style="opacity:.75">fixed price every month</div>
      <div class="f">1×/week <b>550</b></div>
      <div class="f">2×/week <b>1,100</b></div>
      <div class="f">3×/week <b>1,500</b></div>
      <div class="note" style="opacity:.85">Freeze up to 1 week per month. Starting mid-month? You only pay for the classes remaining.</div>
    </div>
    <div class="plan">
      <div class="pname">Getting Started</div>
      <div class="price">100 <span>QAR</span></div>
      <div class="per">first class — credited to your first package</div>
      <div class="f">Single class <b>250</b></div>
      <div class="f">Trial (first) class <b>100</b></div>
      <div class="note">A full 50-minute class in the group matched to your child's age. If you continue — the 100 QAR counts toward your package.</div>
    </div>
  </div>

  <div class="renew">
    <div class="pct">−5%</div>
    <span class="notch t1"></span><span class="notch b1"></span>
    <div class="txt">
      <div class="lb">Renewal bonus · Monthly plans</div>
      <div class="t">Renew your monthly plan on the day it ends — save 5%</div>
      <div class="d">Extend your monthly plan on its last day and get <b style="color:${ORANGE}">5% off</b> the next month.</div>
    </div>
  </div>

  <h2>Personal Training</h2>
  <div class="grid2">
    <div class="box">
      <div class="f">1-on-1 session <b>300 QAR</b></div>
      <div class="f">Pack of 10 <b>2,700 QAR</b></div>
    </div>
    <div class="box">
      <div class="f">1-on-2 session (two children) <b>400 QAR</b></div>
      <div class="f">Pack of 10 <b>3,600 QAR</b></div>
    </div>
  </div>

  <h2>How to get started</h2>
  <div class="steps">
    <div class="step"><div class="n">1</div><b>Register online</b> — acrogym.org/register, takes about 3 minutes</div>
    <div class="step"><div class="n">2</div><b>Come to your first class</b> — 100 QAR, credited toward your package</div>
    <div class="step"><div class="n">3</div><b>Pick your plan</b> — we'll help choose the best one for your schedule</div>
  </div>

  <div class="good">
    <div class="chip"><span class="ic">−15%</span><b>3rd child</b> from the same family — discount on any plan</div>
    <div class="chip"><span class="ic">FREEZE</span>Missed a class? Tell us <b>24h ahead</b> — nothing is lost</div>
    <div class="chip"><span class="ic">AGES 2–16</span>Small groups matched by age · adult classes <b>18+</b> too</div>
  </div>
</main>

<div class="foot">
  <div class="c">
    AcroGym Sport Center · <span>Lagoona Mall, 1st Floor, Doha</span><br>
    +974 7085 9382 · info@acrogym.org · acrogym.org · <span>@acrogymqatar</span><br>
    All prices in QAR · payment at the gym
  </div>
  <img src="${QR}">
</div>`;

(async () => {
  const br = await chromium.launch({ args: ['--no-sandbox'] });
  const p = await br.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 2 });
  await p.setContent(html, { waitUntil: 'load' });
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(700);
  await p.screenshot({ path: '/tmp/claude-1000/price/preview.png', fullPage: true });
  const pdf = await p.pdf({ width: '210mm', height: '297mm', printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } });
  fs.writeFileSync('/tmp/claude-1000/price/AcroGym-Price-List.pdf', pdf);
  await br.close(); console.log('PDF', (pdf.length / 1024).toFixed(0), 'КБ');
})();

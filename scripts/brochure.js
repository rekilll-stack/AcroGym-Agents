const fs = require('fs');
const B64 = (p, m) => `data:${m};base64,` + fs.readFileSync(p).toString('base64');
const S = process.env.S;
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Gerhaus;src:url(${B64('/home/admin/jarvis-mobile/app/src/main/assets/www/gerhaus.otf','font/otf')})}
@page{size:A4;margin:0}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Montserrat,'Segoe UI',sans-serif;color:#1b2350;-webkit-print-color-adjust:exact}
.page{width:210mm;height:296.9mm;padding:0 12mm 10mm;position:relative;overflow:hidden;background:#fff}
.banner{position:absolute;top:0;left:0;right:0;height:55mm}
.banner svg{position:absolute;top:0;left:0;width:100%;height:100%}
.head{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;height:47mm;text-align:center;gap:3mm}
.head img{height:28.5mm;filter:drop-shadow(0 2px 6px rgba(0,0,0,.18))}
.head .t b{font-family:Gerhaus;font-size:20px;letter-spacing:.14em;display:block;color:#fff}
.head .t span{font-size:10.5px;letter-spacing:.32em;color:#F7B98A;text-transform:uppercase;display:block;margin-top:1.6mm}
.body{position:relative;padding-top:8mm}
h1{font-family:Gerhaus;font-size:23px;text-align:center;color:#28347F;letter-spacing:.02em;margin-top:1mm;line-height:1.12}
h1 em{color:#F37021;font-style:normal}
.sub{text-align:center;font-size:10.5px;color:#5a6288;margin-top:2mm;line-height:1.4}
.qrbox{margin:2.5mm auto 0;width:72mm;border:2.5px solid #28347F;border-radius:6mm;padding:3mm 4mm 2.5mm;text-align:center;box-shadow:0 6px 18px rgba(40,52,127,.12)}
.qrbox img{width:37mm;display:block;margin:0 auto}
.qrbox .url{font-family:Gerhaus;font-size:17px;color:#28347F;letter-spacing:.03em;margin-top:2.5mm}
.qrbox .cap{font-size:11.5px;color:#F37021;font-weight:700;letter-spacing:.06em;margin-top:1.5mm;text-transform:uppercase}
h2{font-family:Gerhaus;font-size:13.5px;color:#28347F;letter-spacing:.09em;margin:3mm 0 2mm;text-align:center}
h2::before,h2::after{content:'';display:inline-block;width:14mm;height:2px;background:#F37021;vertical-align:middle;margin:0 4mm}
.rules{display:grid;grid-template-columns:1fr 1fr;gap:2.5mm}
.rule{display:flex;gap:2.5mm;background:#f6f7fc;border-left:3px solid #28347F;border-radius:0 3mm 3mm 0;padding:2.5mm 3mm}
.rule.hot{border-left-color:#F37021;background:#fff5ef}
.rule .ic{font-size:16px;line-height:1}
.rule b{display:block;font-size:11.5px;margin-bottom:.7mm;color:#28347F}
.rule span{font-size:9.3px;line-height:1.32;color:#4a5478}
.pay{display:grid;grid-template-columns:1fr 1fr;gap:3mm}
.paycol{background:#f6f7fc;border:1.5px solid #d9def0;border-radius:3.5mm;padding:2.5mm 3.5mm}
.pt{font-family:Gerhaus;font-size:12.5px;color:#28347F;letter-spacing:.04em;margin-bottom:1.8mm}
.pl{font-size:9.5px;color:#4a5478;line-height:1.5}
.pl b{color:#28347F}
h2 .pref{font-family:Montserrat;font-size:10.5px;color:#F37021;letter-spacing:.02em;text-transform:none}
.note{margin-top:2.5mm;background:#28347F;color:#fff;border-radius:4mm;padding:3mm 4.5mm;display:flex;gap:4mm;align-items:center}
.note .ic{font-size:21px}
.note b{font-size:11.5px;display:block;margin-bottom:.5mm}
.note span{font-size:10px;opacity:.92;line-height:1.4}
.foot{position:absolute;left:12mm;right:12mm;bottom:6mm;text-align:center;font-size:9.5px;color:#8a91b4;border-top:1px solid #e6e8f2;padding-top:2.5mm;line-height:1.5}
.foot b{color:#28347F}
</style></head><body><div class="page">
  <div class="banner">
    <svg viewBox="0 0 210 46" preserveAspectRatio="none">
      <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#2A3690"/><stop offset="1" stop-color="#1B2350"/></linearGradient></defs>
      <path d="M0 0 H210 V33 C158 45 105 45 52 39 C34 37 16 37 0 41 Z" fill="url(#bg)"/>
      <path d="M0 41 C16 37 34 37 52 39 C105 45 158 45 210 33 V36 C158 48 105 48 52 42 C34 40 16 40 0 44 Z" fill="#F37021"/>
    </svg>
  </div>
  <div class="head"><img src="${B64('/home/admin/acrogym/config/brand/logo-white.png','image/png')}">
    <div class="t"><b>ACROGYM</b><span>Lagoona Mall · Doha · Season 2026/27</span></div></div>

  <div class="body">
  <h1>Welcome! Please <em>register</em><br>before your first class</h1>
  <div class="sub">Registration takes 2 minutes and is required for every child —<br><b>before the first class and before any payment.</b></div>

  <div class="qrbox">
    <img src="${B64(S + '/qr-register.png','image/png')}">
    <div class="url">acrogym.org/register</div>
    <div class="cap">Scan with your phone camera</div>
  </div>

  <h2>PAYMENT &amp; ATTENDANCE RULES</h2>
  <div class="rules">
    <div class="rule"><div class="ic">📅</div><div><b>Pay in advance, days are reserved</b><span>Payment for the month or term books your specific weekday slots. Classes on other days are not available.</span></div></div>
    <div class="rule hot"><div class="ic">⏰</div><div><b>24-hour cancellation</b><span>Let us know at least 24 hours before. A later cancellation counts as a used class.</span></div></div>
    <div class="rule hot"><div class="ic">🗓</div><div><b>Term plans — first month only</b><span>A full term can be purchased only during the first month of that term. After that, monthly plans remain available.</span></div></div>
    <div class="rule"><div class="ic">🎁</div><div><b>First class 100 QAR — credited</b><span>Buy a package right after your first class and the 100 QAR is deducted. If you leave and come back later, the credit no longer applies.</span></div></div>
    <div class="rule"><div class="ic">❄️</div><div><b>Freeze instead of losing classes</b><span>Up to 1 week per month or 2 weeks per term — tell the admin in advance and the period is extended.</span></div></div>
    <div class="rule"><div class="ic">👨‍👩‍👧‍👦</div><div><b>Family discount</b><span>15% off for the 3rd child from the same family. Joining mid-period? You pay only for remaining classes.</span></div></div>
  </div>

  <h2>HOW TO PAY <span class="pref">— bank transfer or Fawran preferred</span></h2>
  <div class="pay">
    <div class="paycol"><div class="pt">🏦 Bank transfer</div>
      <div class="pl"><b>AcroGym Sport Center</b></div>
      <div class="pl">The Commercial Bank (P.S.Q.C.)</div>
      <div class="pl">Account <b>498009300025001</b></div>
      <div class="pl">IBAN <b>QA40CBQA000000498009300025001</b></div>
      <div class="pl">CR <b>207623</b></div></div>
    <div class="paycol"><div class="pt">⚡ Fawran (instant)</div>
      <div class="pl">1. Choose <b>Transfer to Business</b></div>
      <div class="pl">2. Select <b>Beneficiary Company Registration</b></div>
      <div class="pl">3. Enter CR <b>207623</b></div>
      <div class="pl">4. Enter the amount and confirm</div></div>
  </div>
  <div class="note"><div class="ic">📸</div><div><b>Always send us the payment screenshot</b><span>Without a confirmation we may not be able to match your payment. Questions or cancellations — WhatsApp the front desk.</span></div></div>

  </div>
  <div class="foot">Please arrive <b>10 minutes early</b> · sportswear, hair tied, non-slip (grip) socks, water bottle · children are handed over to a parent or listed guardian only<br>
  <b>ACROGYM SPORT CENTER W.L.L</b> · Lagoona Mall, Doha · info@acrogym.org · acrogym.org</div>
</div></body></html>`;
(async () => {
  const { chromium } = require('/home/admin/acrogym-design-system/.ds-sync/node_modules/playwright');
  const br = await chromium.launch({ args: ['--no-sandbox'] });
  const p = await br.newPage({ viewport: { width: 794, height: 1123 } });
  await p.setContent(html, { waitUntil: 'load' });
  await p.screenshot({ path: S + '/brochure.png', fullPage: true });
  const pdf = await p.pdf({ format: 'A4', printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } });
  fs.writeFileSync(S + '/AcroGym-Reception-A4.pdf', pdf);
  await br.close();
  console.log('PDF', pdf.length, 'bytes');
})();

const fs = require('fs');
const B64 = (p, m) => `data:${m};base64,` + fs.readFileSync(p).toString('base64');
const S = process.env.S;
const html = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><style>
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
body,h1,h2,.sub,.rule,.pl,.pt,.note,.foot,.qrbox .cap,.head .t span,h2 .pref{font-family:'Noto Kufi Arabic',sans-serif!important;letter-spacing:0!important;text-transform:none!important}
.rule{border-left:0;border-right:3px solid #28347F;border-radius:3mm 0 0 3mm}.rule.hot{border-right-color:#F37021}
h1{font-size:20px;line-height:1.35} .sub{font-size:9.6px;line-height:1.45} .body{padding-top:9.5mm}
.qrbox{width:62mm;padding:2.2mm 3mm 2mm;margin-top:2mm} .qrbox img{width:27mm} .qrbox .url{font-size:15px;margin-top:1.5mm} .qrbox .cap{font-size:10.5px;margin-top:1mm}
h2{margin:2.2mm 0 1.6mm} .rules{gap:2mm} .rule{padding:2mm 2.8mm} .rule b{font-size:10.5px} .rule span{font-size:8.5px;line-height:1.45}
.pl{font-size:8.8px;line-height:1.45} .pt{font-size:11.5px;margin-bottom:1mm} .paycol{padding:2mm 3mm}
.note{margin-top:2mm;padding:2.4mm 4mm} .note b{font-size:10.5px} .note span{font-size:9px;line-height:1.4} .foot{font-size:9px}
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
    <div class="t"><b>ACROGYM</b><span>لاجونا مول · الدوحة · موسم 2026/27</span></div></div>

  <div class="body">
  <h1>أهلاً بكم! يرجى <em>التسجيل</em><br>قبل الحصة الأولى</h1>
  <div class="sub">يستغرق التسجيل دقيقتين وهو إلزامي لكل طفل —<br><b>قبل الحصة الأولى وقبل أي دفع.</b></div>

  <div class="qrbox">
    <img src="${B64(S + '/qr-register.png','image/png')}">
    <div class="url" dir="ltr">acrogym.org/register</div>
    <div class="cap">امسح الرمز بكاميرا هاتفك</div>
  </div>

  <h2>قواعد الدفع والحضور</h2>
  <div class="rules">
    <div class="rule"><div class="ic">📅</div><div><b>الدفع مقدماً وحجز الأيام</b><span>الدفع للشهر يحجز لك أيام الحصص المحددة في الأسبوع. لا يمكن الحضور في أيام أخرى.</span></div></div>
    <div class="rule hot"><div class="ic">⏰</div><div><b>الإلغاء قبل 24 ساعة</b><span>أبلغنا قبل 24 ساعة على الأقل. الإلغاء المتأخر يُحتسب حصةً مستخدمة.</span></div></div>
    <div class="rule hot"><div class="ic">🎁</div><div><b>الحصة الأولى 100 ر.ق — تُخصم</b><span>اشترِ باقة مباشرة بعد حصتك الأولى وتُخصم الـ 100 ر.ق من قيمتها. إذا غادرت وعدت لاحقاً لا يُطبَّق الخصم.</span></div></div>
    <div class="rule"><div class="ic">❄️</div><div><b>التجميد بدلاً من خسارة الحصص</b><span>حتى أسبوع واحد في الشهر — أبلغ الإدارة مسبقاً وتُمدَّد مدة الاشتراك.</span></div></div>
    <div class="rule"><div class="ic">👨‍👩‍👧‍👦</div><div><b>خصم العائلة</b><span>خصم 15% للطفل الثالث من نفس العائلة. الانضمام في منتصف الشهر؟ تدفع فقط مقابل الحصص المتبقية.</span></div></div>
    <div class="rule"><div class="ic">👟</div><div><b>الحضور قبل 10 دقائق</b><span>ملابس رياضية، شعر مربوط، جوارب مانعة للانزلاق، وزجاجة ماء.</span></div></div>
  </div>

  <h2>طريقة الدفع <span class="pref">— يُفضَّل التحويل البنكي أو فوران</span></h2>
  <div class="pay">
    <div class="paycol"><div class="pt">🏦 تحويل بنكي</div>
      <div class="pl"><b dir="ltr">AcroGym Sport Center</b></div>
      <div class="pl">البنك التجاري (ش.م.ع.ق)</div>
      <div class="pl">رقم الحساب <b dir="ltr">498009300025001</b></div>
      <div class="pl">IBAN <b dir="ltr">QA40CBQA000000498009300025001</b></div>
      <div class="pl">السجل التجاري <b dir="ltr">207623</b></div></div>
    <div class="paycol"><div class="pt">⚡ فوران (تحويل فوري)</div>
      <div class="pl">1. اختر <b>التحويل إلى شركة</b></div>
      <div class="pl">2. اختر <b>السجل التجاري للمستفيد</b></div>
      <div class="pl">3. أدخل السجل التجاري <b dir="ltr">207623</b></div>
      <div class="pl">4. أدخل المبلغ وأكّد العملية</div></div>
  </div>
  <div class="note"><div class="ic">📸</div><div><b>أرسل لنا دائماً صورة إيصال الدفع</b><span>بدون التأكيد قد لا نتمكن من مطابقة دفعتك. للأسئلة أو الإلغاء — راسل الاستقبال عبر واتساب.</span></div></div>

  </div>
  <div class="foot">يُسلَّم الأطفال لأحد الوالدين أو الوصي المسجَّل فقط<br>
  <b dir="ltr">ACROGYM SPORT CENTER W.L.L</b> · لاجونا مول، الدوحة · <span dir="ltr">info@acrogym.org · acrogym.org</span></div>
</div></body></html>`;
(async () => {
  const { chromium } = require('/home/admin/acrogym-design-system/.ds-sync/node_modules/playwright');
  const br = await chromium.launch({ args: ['--no-sandbox'] });
  const p = await br.newPage({ viewport: { width: 794, height: 1123 } });
  await p.setContent(html, { waitUntil: 'load' });
  await p.screenshot({ path: S + '/brochure-ar.png', fullPage: true });
  const pdf = await p.pdf({ format: 'A4', printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } });
  fs.writeFileSync(S + '/AcroGym-Reception-A4-AR.pdf', pdf);
  await br.close();
  console.log('PDF', pdf.length, 'bytes');
})();

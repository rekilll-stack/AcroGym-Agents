const fs = require('fs');
const { chromium } = require('/home/admin/acrogym-design-system/.ds-sync/node_modules/playwright');
const b64 = (p, m) => `data:${m};base64,` + fs.readFileSync(p).toString('base64');
const LOGO = b64('/tmp/claude-1000/sticker/logo-white-trim.png', 'image/png');
const QR = b64('/tmp/claude-1000/price/qr-hi.png', 'image/png');

const NAVY = '#161D45', BLUE = '#28347F', ORANGE = '#F37021', IVORY = '#F6F3EC', INK = '#1B2350', STONE = '#EEF1F7';

const html = `<!doctype html><html dir="rtl" lang="ar"><meta charset="utf-8"><style>
@page{size:210mm 297mm;margin:0}
html,body,*{font-family:'Noto Kufi Arabic',sans-serif!important;letter-spacing:0!important;text-transform:none!important}
.head .r{text-align:left!important}
.f b{direction:ltr;unicode-bidi:isolate}
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

/* скидка за продление в день окончания — купон с перфорацией (RTL: логические свойства) */
.renew{margin-top:4mm;display:flex;background:#fff;border:0.6mm solid ${ORANGE};border-radius:5mm;position:relative}
.renew .pct{background:${ORANGE};color:#fff;font-weight:800;font-size:25pt;width:34mm;display:flex;align-items:center;justify-content:center;border-start-start-radius:4.4mm;border-end-start-radius:4.4mm}
.renew .txt{flex:1;padding:2.4mm 7mm 2.4mm 6mm;border-inline-start:0.5mm dashed ${ORANGE};display:flex;flex-direction:column;justify-content:center}
.renew .lb{font-size:7.5pt;font-weight:700;color:${ORANGE}}
.renew .t{font-size:11pt;font-weight:800;color:${NAVY};line-height:1.45}
.renew .d{font-size:8.4pt;line-height:1.4;opacity:.75}
.renew .notch{position:absolute;inset-inline-start:31.75mm;width:5mm;height:5mm;border-radius:50%;background:${STONE};border:0.6mm solid ${ORANGE}}
.renew .notch.t1{top:-3.1mm;clip-path:inset(50% 0 0 0)}
.renew .notch.b1{bottom:-3.1mm;clip-path:inset(0 0 50% 0)}

.foot{margin-top:auto;background:${NAVY};color:#fff;padding:4.5mm 14mm;display:flex;align-items:center;justify-content:space-between;border-top:2mm solid ${ORANGE}}
.foot .c{font-size:9pt;line-height:1.7;font-weight:600}
.foot .c span{color:#F7B98A}
.foot img{width:20mm;background:#fff;border-radius:2.5mm;padding:1.5mm}
</style>

<div class="head">
  <img src="${LOGO}">
  <div class="r"><h1>قائمة الأسعار</h1><div class="sub">موسم 2026/27 · لاجونا مول</div></div>
</div>

<main>
  <div class="plans">
    <div class="plan hot">
      <div class="pname">الاشتراك الشهري</div>
      <div class="price" style="color:#fff">550 <span>ر.ق / شهرياً</span></div>
      <div class="per" style="opacity:.75">سعر ثابت كل شهر</div>
      <div class="f">مرة واحدة أسبوعياً <b>550</b></div>
      <div class="f">مرتان أسبوعياً <b>1,100</b></div>
      <div class="f">3 مرات أسبوعياً <b>1,500</b></div>
      <div class="note" style="opacity:.85">تجميد حتى أسبوع واحد في الشهر. تبدأ في منتصف الشهر؟ تدفع فقط مقابل الحصص المتبقية.</div>
    </div>
    <div class="plan">
      <div class="pname">للبدء</div>
      <div class="price">100 <span>ر.ق</span></div>
      <div class="per">الحصة الأولى — تُخصم من أول باقة</div>
      <div class="f">حصة واحدة <b>250</b></div>
      <div class="f">حصة تجريبية (الأولى) <b>100</b></div>
      <div class="note">حصة كاملة مدتها 50 دقيقة ضمن المجموعة المناسبة لعمر طفلك. إذا استمررتم، تُحتسب الـ 100 ر.ق من قيمة الباقة.</div>
    </div>
  </div>

  <div class="renew">
    <div class="pct"><span dir="ltr">−5%</span></div>
    <span class="notch t1"></span><span class="notch b1"></span>
    <div class="txt">
      <div class="lb">مكافأة التجديد · الاشتراك الشهري</div>
      <div class="t">جدّد اشتراكك الشهري في يوم انتهائه — ووفّر <span dir="ltr">5%</span></div>
      <div class="d">جدّد اشتراكك الشهري في آخر يوم له واحصل على <b style="color:${ORANGE}">خصم <span dir="ltr">5%</span></b> على الشهر التالي.</div>
    </div>
  </div>

  <h2>التدريب الخاص</h2>
  <div class="grid2">
    <div class="box">
      <div class="f">حصة فردية (مدرب وطفل واحد) <b>300 ر.ق</b></div>
      <div class="f">باقة 10 حصص <b>2,700 ر.ق</b></div>
    </div>
    <div class="box">
      <div class="f">حصة لطفلين مع مدرب واحد <b>400 ر.ق</b></div>
      <div class="f">باقة 10 حصص <b>3,600 ر.ق</b></div>
    </div>
  </div>

  <h2>كيف تبدأ</h2>
  <div class="steps">
    <div class="step"><div class="n">1</div><b>سجّل عبر الإنترنت</b> — acrogym.org/register، يستغرق التسجيل حوالي 3 دقائق</div>
    <div class="step"><div class="n">2</div><b>احضر حصتك الأولى</b> — 100 ر.ق تُخصم من قيمة الباقة</div>
    <div class="step"><div class="n">3</div><b>اختر باقتك</b> — نساعدك في اختيار الأنسب لجدولك</div>
  </div>

  <div class="good">
    <div class="chip"><span class="ic" dir="ltr" style="text-align:right">−15%</span><b>للطفل الثالث</b> من نفس العائلة — خصم على أي باقة</div>
    <div class="chip"><span class="ic">تجميد</span>فاتتك حصة؟ أبلغنا <b>قبل 24 ساعة</b> — لن تخسر شيئاً</div>
    <div class="chip"><span class="ic">الأعمار <span dir="ltr">2–16</span></span>مجموعات صغيرة حسب العمر · وحصص للكبار <b>18+</b> أيضاً</div>
  </div>
</main>

<div class="foot">
  <div class="c">
    أكروجيم سبورت سنتر · <span>لاجونا مول، الطابق الأول، الدوحة</span><br>
    <span dir="ltr">+974 7085 9382 · info@acrogym.org · acrogym.org · @acrogymqatar</span><br>
    جميع الأسعار بالريال القطري · الدفع في الصالة
  </div>
  <img src="${QR}">
</div>`;

(async () => {
  const br = await chromium.launch({ args: ['--no-sandbox'] });
  const p = await br.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 2 });
  await p.setContent(html, { waitUntil: 'load' });
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(700);
  await p.screenshot({ path: '/tmp/claude-1000/price/preview-ar.png', fullPage: true });
  const pdf = await p.pdf({ width: '210mm', height: '297mm', printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } });
  fs.writeFileSync('/tmp/claude-1000/price/AcroGym-Price-List-AR.pdf', pdf);
  await br.close(); console.log('PDF', (pdf.length / 1024).toFixed(0), 'КБ');
})();

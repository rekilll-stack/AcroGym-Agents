/* Двуязычный (EN + AR) счёт/квитанция по документу in2.
   Вход: JSON ответа GET app.joinin2.com/bookingAPI/transactions/<txId>/document (как отдаёт панель in2).
   node scripts/invoice-bilingual.js <doc.json> [out.pdf]
   in2 печатает только на одном языке на весь клуб (printoutLanguage) — поэтому свой шаблон. */
const fs = require('fs');
const { chromium } = require('/home/admin/acrogym-design-system/.ds-sync/node_modules/playwright');

const [src, outArg] = process.argv.slice(2);
if (!src) { console.error('usage: invoice-bilingual.js <doc.json> [out.pdf]'); process.exit(1); }
const raw = JSON.parse(fs.readFileSync(src, 'utf8'));
const d = raw.entity || raw, h = d.header || {};
const out = outArg || src.replace(/\.json$/, '') + '-bilingual.pdf';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (v) => (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cur = h.tenantCurrencyName || 'QR';
const isInv = h.transactionType === 'INVOICE';
const PAY_AR = { Transfer: 'تحويل بنكي', 'Bank Transfer': 'تحويل بنكي', Cash: 'نقداً', Card: 'بطاقة' };
const L = (en, ar) => `<span class=en>${en}</span><span class=ar>${ar}</span>`; // пара подписей EN | AR
const n = (v) => `<bdi dir=ltr>${esc(v)}</bdi>`; // номера/даты/телефоны не переворачивать

const items = (d.items || []).map((i) => `<tr><td class=l>${esc(i.name)}</td><td>${n(i.qty)}</td><td>${n(money(i.price))}</td><td>${n((Number(i.discount) || 0).toFixed(2) + '%')}</td><td>${n(money(i.total))}</td></tr>`).join('');
const pays = (d.references || []).filter((r) => r && r.amount).map((r) => `<tr><th><div class=pair>${L(esc(r.paymentMethod || ''), PAY_AR[r.paymentMethod] || '')}</div></th><td>${n(money(r.amount) + ' ' + cur)}</td></tr>`).join('');
const title = isInv ? L('INVOICE', 'فاتورة') : L('RECEIPT', 'إيصال');

const html = `<!doctype html><html><head><meta charset=utf-8>
<link href="https://fonts.googleapis.com/css2?family=Noto+Kufi+Arabic:wght@400;700&family=Inter:wght@400;600;800&display=swap" rel=stylesheet>
<style>
@page{size:A4;margin:0}*{box-sizing:border-box;margin:0}
body{width:210mm;min-height:297mm;padding:14mm 15mm 18mm;font:10pt/1.35 Inter,Arial,sans-serif;color:#1d1d2b;position:relative}
.ar{font-family:'Noto Kufi Arabic',sans-serif;direction:rtl;letter-spacing:0}
.pair{display:flex;justify-content:space-between;gap:3mm}
.lab{display:flex;flex-direction:column;line-height:1.15}.lab .ar{font-size:.86em;color:#555}
.top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:.5mm solid #1d1d2b;padding-bottom:5mm}
.top img{height:30mm;margin:-6mm 0 -6mm -4mm}
h1{display:flex;gap:4mm;align-items:baseline;justify-content:flex-end;font-size:22pt;font-weight:800}h1 .ar{font-size:20pt}
.meta{margin-top:2mm;display:grid;grid-template-columns:auto auto;gap:1mm 5mm;justify-content:end;font-size:9.5pt}
.meta .k{display:flex;gap:2mm;font-weight:600}.meta .k .ar{font-weight:700}
.parties{display:flex;justify-content:space-between;margin:5mm 0 6mm}
.co b{font-size:12pt}.to{text-align:right}
table{width:100%;border-collapse:collapse}
th,td{border:.3mm solid #333;padding:1.6mm 2mm;text-align:center;vertical-align:middle}
thead th{background:#e6e6e6}thead th .en{display:block;font-weight:700}thead th .ar{display:block;font-weight:700;font-size:8.5pt}
td.l{text-align:left}
.sum{width:62%;margin:5mm 0 0 auto}.sum th{background:#e6e6e6;width:48%}.sum td{text-align:right;font-weight:600}
.sum th .pair{justify-content:space-between}.sum tr.b td{font-weight:800}
.words{margin:2.5mm 0 0 auto;width:62%;font-size:9pt;display:flex;gap:2mm;justify-content:space-between}
.thanks{margin-top:14mm;text-align:center;font-size:15pt;font-weight:800;display:flex;justify-content:center;gap:5mm}
.foot{position:absolute;left:15mm;right:15mm;bottom:9mm;text-align:center;font-size:8.5pt;color:#444;border-top:.3mm solid #bbb;padding-top:2mm}
</style></head><body>
<div class=top>
  ${h.logo ? `<img src="${h.logo}">` : '<div></div>'}
  <div><h1>${title}</h1>
    <div class=meta>
      <div class=k>${L('Date', 'التاريخ')}</div><div>${n(h.transactionDate + (h.transactionTime && h.transactionTime !== '00:00' ? ' ' + h.transactionTime : ''))}</div>
      <div class=k>${L(isInv ? 'Invoice #' : 'Receipt #', 'رقم')}</div><div>${n(h.number)}</div>
    </div></div>
</div>
<div class=parties>
  <div class=co><b>${esc(h.tenantName)}</b><br>${esc(h.branchLocation || h.tenantLocation || '')}<br>
    <div class=pair style="justify-content:flex-start">${L('Email:', 'البريد الإلكتروني:')} ${n(h.tenantEmail)}</div>
    <div class=pair style="justify-content:flex-start">${L('Phone:', 'الهاتف:')} ${n(h.tenantPhoneNumber)}</div>
    ${h.tenantTaxRegNumber ? `<div class=pair style="justify-content:flex-start">${L('CR:', 'السجل التجاري:')} ${n(h.tenantTaxRegNumber)}</div>` : ''}</div>
  <div class=to><div class=pair style="justify-content:flex-end;color:#666">${L('To', 'إلى')}</div><b>${esc(h.clientName)}</b><br>${n(h.clientPhoneNumber || '')}</div>
</div>
${items ? `<table><thead><tr><th style="width:40%">${L('Description', 'الوصف')}</th><th>${L('Qty', 'الكمية')}</th><th>${L('Price', 'السعر')}</th><th>${L('Discount', 'الخصم')}</th><th>${L('Total', 'الإجمالي')}</th></tr></thead><tbody>${items}</tbody></table>` : ''}
<table class=sum>
  <tr><th><div class=pair>${L('Net Amount', 'صافي المبلغ')}</div></th><td>${n(money(h.netAmount ?? h.amount) + ' ' + cur)}</td></tr>
  <tr class=b><th><div class=pair>${L('Total', 'الإجمالي')}</div></th><td>${n(money(h.amount) + ' ' + cur)}</td></tr>
</table>
${h.amountInWords ? `<div class=words><span>${L('Total (in words):', '')} ${esc(h.amountInWords)} ${esc(cur)}</span><span class=ar>المبلغ بالحروف</span></div>` : ''}
${isInv && pays ? `<table class=sum>${pays}<tr class=b><th><div class=pair>${L('Balance', 'الرصيد')}</div></th><td>${n(money(h.transactionBalance) + ' ' + cur)}</td></tr></table>` : ''}
<div class=thanks><span>THANK YOU!</span><span class=ar>شكراً لكم!</span></div>
<div class=foot>${esc(h.tenantName)} · ${esc(h.branchLocation || '')} · ${n(h.tenantPhoneNumber)} · ${n(h.tenantEmail)}</div>
</body></html>`;

(async () => {
  const br = await chromium.launch({ args: ['--no-sandbox'] });
  const p = await br.newPage();
  await p.setContent(html, { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready);
  fs.writeFileSync(out, await p.pdf({ format: 'A4', printBackground: true }));
  await br.close();
  console.log('ok', out);
})().catch((e) => { console.error(e.message); process.exit(1); });

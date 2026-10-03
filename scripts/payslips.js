/* Расчётные листы сотрудникам (владелец 30.09: «красивый pay list, чтобы не было вопросов, почему такая ЗП»).
   Источник — in2 (только чтение, через панель): Payroll (итог по человеку: сдельно + оклад) и Class Earnings (каждое занятие:
   дата, группа, сколько пришло, есть ли ставка). Сдельно по занятию — ставка Group Class in2: 0 детей → 50, 1–5 → 100,
   +10 за ребёнка сверх 5, максимум 150; занятие без ставки в in2 → 0. Итог листа всегда = итог Payroll in2: если построчная сумма
   не сходится (индивидуальные, ручные правки) — строка «Other / adjustment» и предупреждение в консоль владельцу.
   Запуск: node scripts/payslips.js [ГГГГ-ММ] → docs/payslips/<ГГГГ-ММ>/*.pdf + summary.json. */
const fs = require('fs'), path = require('path');
require('/home/admin/acrogym/node_modules/dotenv').config({ path: '/home/admin/acrogym/.env' }); /* доступы панели in2 — и при запуске из моста приложения */
const panel = require('/home/admin/mcp-servers/in2-panel/panel.js');
const { chromium } = require('/home/admin/acrogym-design-system/.ds-sync/node_modules/playwright');

const YM = process.argv[2] || new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 7);
const [Y, M] = YM.split('-').map(Number), LAST = new Date(Date.UTC(Y, M, 0)).getUTCDate();
const DMY = (d) => String(d).padStart(2, '0') + '/' + String(M).padStart(2, '0') + '/' + Y;
const OUT = path.join(__dirname, '..', 'docs', 'payslips', YM);
/* 30.09 владелец: язык листа — как в приложении (ru | en); запуск: node scripts/payslips.js ГГГГ-ММ [ru|en] */
const LANG = process.argv[3] === 'ru' ? 'ru' : 'en', SFX = LANG === 'ru' ? '-RU' : '';
const MONTH = LANG === 'ru' ? ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'][M - 1] + ' ' + Y : new Date(Date.UTC(Y, M - 1, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
/* русская версия — словарь фраз поверх готового листа: разметка одна, тексты не расходятся */
const RU = [['<h1>PAYSLIP</h1>', '<h1>РАСЧЁТНЫЙ ЛИСТ</h1>'], ['Coach · paid per class', 'Тренер · оплата за занятия'], ['Period: ', 'Период: '], ['Issued: ', 'Выдан: '],
  ['>Classes taught<', '>Проведено занятий<'], ['>Pay type<', '>Тип оплаты<'], ['>Children attended<', '>Пришло детей<'], ['>Per-class pay<', '>Оплата за занятия<'], ['>Private sessions<', '>Персональные<'], ['>Salary<', '>Оклад<'], ['>Other<', '>Прочее<'], ['Monthly salary', 'Месячный оклад'],
  ['Total for ', 'Итого за '], ['<b>How per-class pay works.</b> Each class you teach is paid by the number of children who attended: ', '<b>Как считается оплата за занятия.</b> Каждое ваше занятие оплачивается по числу пришедших детей: '],
  ['<b>no children — 50 QAR</b>', '<b>нет детей — 50 QAR</b>'], ['<b>1 to 5 children — 100 QAR</b>', '<b>от 1 до 5 детей — 100 QAR</b>'], ['<b>+10 QAR for each child above 5</b>', '<b>+10 QAR за каждого ребёнка сверх 5</b>'], ['<b>maximum 150 QAR</b> per class.', '<b>не больше 150 QAR</b> за занятие.'],
  [' Attendance is taken from the class register in in2.', ' Посещаемость берётся из журнала занятий в in2.'], [' Classes shown in grey had no pay rate set in the system for that date and are not included.', ' Серые занятия — в системе на эту дату не стояла ставка, в оплату не вошли.'],
  ['>Your classes<', '>Ваши занятия<'], ['<th>Date</th>', '<th>Дата</th>'], ['<th>Time</th>', '<th>Время</th>'], ['<th>Class</th>', '<th>Группа</th>'], ['>Children<', '>Детей<'], ['>Pay, QAR<', '>Оплата, QAR<'], ['<th>Session · client</th>', '<th>Сессия · клиент</th>'], ['>Value, QAR<', '>Стоимость, QAR<'],
  ['>Per-class pay</td>', '>Оплата за занятия</td>'], ['>Private-session pay</td>', '>Оплата за персональные</td>'], ['<b>Salary.</b> Your monthly salary for ', '<b>Оклад.</b> Ваш оклад за '],
  [' (you also taught ', ' (вы также провели '], [' classes, included in the salary)', ' занятий — они входят в оклад)'], ['. If you started or left during the month, the salary is counted for the days you worked.', '. Если вы начали или закончили работу в середине месяца, оклад считается за отработанные дни.'],
  ['<b>How private-session pay works.</b> You receive <b>40% of the session value</b>: 120 QAR for a single 300 QAR session, 108 QAR for a session from a 10-session pack.', '<b>Как считаются персональные.</b> Вы получаете <b>40% стоимости сессии</b>: 120 QAR с разовой за 300 QAR, 108 QAR с сессии из пакета на 10.'],
  ['<b>Private sessions are included in your monthly salary.</b>', '<b>Персональные тренировки входят в ваш оклад.</b>'], [' Sessions shown in grey had no pay rate set in the system and are not included.', ' Серые сессии — в системе не стояла ставка, в оплату не вошли.'],
  ['>incl.<', '>в окладе<'], [' Private sessions and corrections recorded in the payroll.', ' Персональные и корректировки из расчёта зарплаты.'], ['<b>Other: ', '<b>Прочее: '],
  ['Lagoona Mall, 1st Floor, Doha', 'Lagoona Mall, 1-й этаж, Доха'], ['Questions about this payslip? Speak to the manager — we will go through it with you class by class.', 'Вопросы по листу? Подойдите к управляющему — разберём вместе по каждому занятию.']];
const tr = (h) => (LANG === 'ru' ? RU.reduce((a, [en, ru]) => a.split(en).join(ru), h) : h);
/* решения владельца поверх in2: data/payroll-overrides.json {"ГГГГ-ММ": {"Имя": {mode: "per_class"}}} — месяц по занятиям вместо оклада; итог пишется туда же для приложения */
const OV_FILE = path.join(__dirname, '..', 'data', 'payroll-overrides.json'), OVS = fs.existsSync(OV_FILE) ? JSON.parse(fs.readFileSync(OV_FILE, 'utf8')) : {}, OV = OVS[YM] || {};
const rate = (kids) => (kids <= 0 ? 50 : kids <= 5 ? 100 : Math.min(150, 100 + 10 * (kids - 5)));
const PT_SHARE = 0.4; /* in2 Pay Rate «Private Session» (владелец 15.08): тренеру 40 % стоимости сессии — 120 с разовой 300, 108 с пакета */
const q = (n) => (LANG === 'ru' ? Math.round(n).toLocaleString('en-US').replace(/,/g, ' ') : Math.round(n).toLocaleString('en-US'));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const b64 = (p, m) => (fs.existsSync(p) ? `data:${m};base64,` + fs.readFileSync(p).toString('base64') : '');
const LOGO = b64('/tmp/claude-1000/sticker/logo-white-trim.png', 'image/png');
const NAVY = '#161D45', BLUE = '#28347F', ORANGE = '#F37021', INK = '#1B2350', STONE = '#EEF1F7';

/* отчёт панели: открываем страницу, ловим её собственный запрос, повторяем с датами месяца (прямой вызов из node даёт ACCESS_DENIED) */
async function report(page, url, part) {
  let req = null; const on = (r) => { if (r.url().includes(part) && !req) req = { url: r.url(), headers: r.headers(), body: JSON.parse(r.postData() || '{}') }; };
  page.on('request', on);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 40 && !req; i++) await page.waitForTimeout(500);
  page.off('request', on);
  if (!req) throw new Error('не пойман запрос ' + part);
  const h = {}; for (const [k, v] of Object.entries(req.headers)) if (!/^(content-length|host|:)/i.test(k)) h[k] = v;
  const r = await page.request.post(req.url, { headers: h, data: { ...req.body, fromDate: DMY(1), toDate: DMY(LAST) }, timeout: 60000 });
  return r.json();
}

function html(p) {
  const perClass = p.lines.length > 0;
  const rows = p.lines.map((l) => `<tr${l.pay === 0 && !l.rated ? ' class="z"' : ''}><td>${esc(l.date)}</td><td>${esc(l.time)}</td><td>${esc(l.group)}</td><td class="n">${l.kids}</td><td class="n">${l.rated ? q(l.pay) : '—'}</td></tr>`).join('');
  const kids = p.lines.reduce((a, l) => a + l.kids, 0), ptPaid = p.pt.some((x) => x.rated);
  const ptRows = p.pt.map((x) => `<tr${!x.rated ? ' class="z"' : ''}><td>${esc(x.date)}</td><td>${esc(x.time)}</td><td>${esc(x.service)} · ${esc(x.client)}</td><td class="n">${q(x.value)}</td><td class="n">${x.rated ? q(x.pay) : (p.salary ? 'incl.' : '—')}</td></tr>`).join('');
  const boxes = [[perClass ? 'Classes taught' : 'Pay type', perClass ? p.lines.length : 'Monthly salary'], ...(perClass ? [['Children attended', kids], ['Per-class pay', q(p.perClass) + ' QAR']] : []),
    ...(p.pt.length ? [['Private sessions', p.pt.length + (ptPaid ? ' · ' + q(p.ptPay) + ' QAR' : '')]] : []), ...(p.salary ? [['Salary', q(p.salary) + ' QAR']] : []), ...(p.adjust ? [['Other', q(p.adjust) + ' QAR']] : [])];
  return `<!doctype html><meta charset="utf-8"><style>
@page{size:210mm 297mm;margin:0}*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:Montserrat,sans-serif;color:${INK};background:${STONE}}
.head{background:${NAVY};color:#fff;padding:6mm 14mm;display:flex;align-items:center;justify-content:space-between;border-bottom:2mm solid ${ORANGE}}
.head img{width:34mm}.head .r{text-align:right}.head h1{font-size:21pt;font-weight:800;letter-spacing:.05em}
.head .sub{font-size:8.5pt;font-weight:600;letter-spacing:.22em;text-transform:uppercase;color:#F7B98A;margin-top:1.2mm}
main{padding:6mm 14mm 10mm}
.who{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:5mm}
.who .name{font-size:17pt;font-weight:800;color:${NAVY}}.who .role{font-size:9pt;font-weight:600;color:${BLUE};letter-spacing:.14em;text-transform:uppercase;margin-top:1mm}
.who .meta{font-size:8.5pt;text-align:right;opacity:.75;line-height:1.5}
.boxes{display:flex;gap:4mm;margin-bottom:4mm}
.box{flex:1;background:#fff;border:0.4mm solid #DDD9E8;border-radius:4mm;padding:3.5mm 4mm}
.box .l{font-size:7pt;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:${ORANGE}}.box .v{font-size:13pt;font-weight:800;margin-top:1mm}
.total{background:${NAVY};color:#fff;border-radius:4mm;padding:4mm 6mm;display:flex;justify-content:space-between;align-items:center;margin-bottom:5mm;border:0.6mm solid ${ORANGE}}
.total .l{font-size:9pt;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#F7B98A}.total .v{font-size:20pt;font-weight:800}
.rule{background:#fff;border-left:1.5mm solid ${ORANGE};border-radius:2mm;padding:3mm 4.5mm;font-size:8.4pt;line-height:1.5;margin-bottom:5mm}
.rule b{color:${BLUE}}
h2{font-size:8.5pt;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:${BLUE};margin:0 0 2mm}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:3mm;overflow:hidden;font-size:8.2pt}
th{background:${BLUE};color:#fff;text-align:left;font-weight:700;padding:1.8mm 3mm;font-size:7.5pt;letter-spacing:.08em;text-transform:uppercase}
td{padding:1.4mm 3mm;border-top:0.2mm solid #E4E1EE}.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tr.z td{color:#9A96AE}tfoot td{font-weight:800;background:${STONE};border-top:0.5mm solid ${BLUE}}
.foot{margin-top:5mm;font-size:7.6pt;line-height:1.6;opacity:.7}
</style>
<div class="head"><img src="${LOGO}"><div class="r"><h1>PAYSLIP</h1><div class="sub">${esc(MONTH)} · AcroGym Lagoona Mall</div></div></div>
<main>
<div class="who"><div><div class="name">${esc(p.name)}</div><div class="role">${perClass ? 'Coach · paid per class' : 'Monthly salary'}</div></div>
<div class="meta">Period: 01/${String(M).padStart(2, '0')}/${Y} – ${LAST}/${String(M).padStart(2, '0')}/${Y}<br>Issued: ${new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10).split('-').reverse().join('/')}</div></div>
<div class="boxes">${boxes.map(([l, v]) => `<div class="box"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('')}</div>
<div class="total"><div class="l">Total for ${esc(MONTH)}</div><div class="v">${q(p.total)} QAR</div></div>
${perClass ? `<div class="rule"><b>How per-class pay works.</b> Each class you teach is paid by the number of children who attended: <b>no children — 50 QAR</b>, <b>1 to 5 children — 100 QAR</b>, <b>+10 QAR for each child above 5</b>, <b>maximum 150 QAR</b> per class. Attendance is taken from the class register in in2.${p.lines.some((l) => !l.rated) ? ' Classes shown in grey had no pay rate set in the system for that date and are not included.' : ''}</div>
<h2>Your classes</h2><table><thead><tr><th>Date</th><th>Time</th><th>Class</th><th class="n">Children</th><th class="n">Pay, QAR</th></tr></thead><tbody>${rows}</tbody>
<tfoot><tr><td colspan="3">Per-class pay</td><td class="n">${kids}</td><td class="n">${q(p.perClass)}</td></tr></tfoot></table>`
    : `<div class="rule"><b>Salary.</b> Your monthly salary for ${esc(MONTH)}${p.lines0 ? ` (you also taught ${p.lines0} classes, included in the salary)` : ''}. If you started or left during the month, the salary is counted for the days you worked.</div>`}
${p.pt.length ? `<h2 style="margin-top:5mm">Private sessions</h2><div class="rule">${ptPaid ? `<b>How private-session pay works.</b> You receive <b>40% of the session value</b>: 120 QAR for a single 300 QAR session, 108 QAR for a session from a 10-session pack.` : `<b>Private sessions are included in your monthly salary.</b>`}${p.pt.some((x) => !x.rated) && ptPaid ? ' Sessions shown in grey had no pay rate set in the system and are not included.' : ''}</div>
<table><thead><tr><th>Date</th><th>Time</th><th>Session · client</th><th class="n">Value, QAR</th><th class="n">Pay, QAR</th></tr></thead><tbody>${ptRows}</tbody>${ptPaid ? `<tfoot><tr><td colspan="4">Private-session pay</td><td class="n">${q(p.ptPay)}</td></tr></tfoot>` : ''}</table>` : ''}
${p.note ? `<div class="rule" style="margin-top:5mm">${esc(p.note)}</div>` : ''}
${p.adjust ? `<div class="rule"><b>Other: ${q(p.adjust)} QAR.</b> Private sessions and corrections recorded in the payroll.</div>` : ''}
<div class="foot">AcroGym Sport Center · Lagoona Mall, 1st Floor, Doha · info@acrogym.org · +974 7085 9382<br>Questions about this payslip? Speak to the manager — we will go through it with you class by class.</div>
</main>`;
}

(async () => {
  await panel.ensureLogin(); const page = panel.getPage();
  const pay = await report(page, 'https://portal.joinin2.com/portal/reports/payroll', 'payrollAPI/getPayrollReport');
  const earn = await report(page, 'https://portal.joinin2.com/portal/reports/classEarnings', 'eventReportsAPI/getClassEarningsReport');
  const classes = ((earn.map || {}).regular) || [];
  const appt = await report(page, 'https://portal.joinin2.com/portal/reports/appointmentEarnings', 'eventReportsAPI/getAppointmentEarningsReport');
  const ptAll = Object.values((appt && appt.map) || {}).flat().filter((x) => x && x.instructorName);
  fs.mkdirSync(OUT, { recursive: true });
  const br = await chromium.launch({ args: ['--no-sandbox'] }), pg = await br.newPage();
  const summary = [], parts = [];
  for (const s of pay.list || []) {
    const ov = OV[s.name] || null, perClassMode = ov && ov.mode === 'per_class';
    const earnings = perClassMode ? 1 : Math.round(s.earnings || 0), salary = perClassMode ? 0 : Math.round(s.salary || 0);
    if (!(earnings + salary)) continue; /* ничего не начислено — листа нет */
    const mine = classes.filter((c) => c.instructorName === s.name).sort((a, b) => String(a.eventDate).split(' ')[0].split('/').reverse().join('') + String(a.eventDate).split(' ')[1] < String(b.eventDate).split(' ')[0].split('/').reverse().join('') + String(b.eventDate).split(' ')[1] ? -1 : 1);
    const lines = earnings ? mine.map((c) => { const [d, t] = String(c.eventDate).split(' '), kids = +c.numberOfAttendees || 0, rated = perClassMode || !!c.payRateName; return { date: d, time: (t || '').slice(0, 5), group: String(c.title || '').replace(/ · .*$/, ''), kids, rated, pay: rated ? rate(kids) : 0 }; }) : [];
    const pt = ptAll.filter((x) => x.instructorName === s.name).map((x) => { const [d, t] = String(x.eventDate).split(' '), value = Math.round(+x.earnings || +x.price || 0), rated = !salary && (perClassMode || !!x.payRateName); return { date: d, time: (t || '').slice(0, 5), client: x.clientName || '', service: x.privateServiceName || 'Private session', value, rated, pay: rated ? Math.round(value * PT_SHARE) : 0 }; });
    const key = (x) => x.date.split('/').reverse().join('') + x.time; pt.sort((a, b) => (key(a) < key(b) ? -1 : 1));
    const ptPay = pt.reduce((a, x) => a + x.pay, 0);
    const perClass = lines.reduce((a, l) => a + l.pay, 0), adjust = earnings && !perClassMode ? earnings - perClass - ptPay : 0, total = perClass + ptPay + salary + adjust;
    if (perClassMode) { ov.earnings = perClass + ptPay; ov.salary = 0; ov.in2_salary = Math.round(s.salary || 0); } /* для приложения (finance.js) */
    const p = { name: s.name, lines, lines0: earnings ? 0 : mine.length, perClass, salary, adjust, total, pt, ptPay, note: perClassMode ? (LANG === 'ru' ? ov.note_ru || ov.note_en : ov.note_en) || '' : '' };
    const file = path.join(OUT, `AcroGym-Payslip-${YM}-${s.name.replace(/[^A-Za-z0-9]+/g, '-')}${SFX}.pdf`);
    const H = tr(html(p)); parts.push(H.replace(/^<!doctype html><meta charset="utf-8">/, ''));
    await pg.setContent(H, { waitUntil: 'load' }); await pg.evaluate(() => document.fonts.ready);
    if (process.env.PREVIEW) await pg.screenshot({ path: file.replace(/\.pdf$/, '.png'), fullPage: true }); /* глазами перед отправкой */
    fs.writeFileSync(file, await pg.pdf({ width: '210mm', height: '297mm', printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } }));
    summary.push({ name: s.name, classes: lines.length || mine.length, pt: pt.length, ptPay, perClass, salary, adjust, total, in2: Math.round((s.earnings || 0) + (s.salary || 0)), override: perClassMode ? ov.why : undefined, file: path.basename(file) });
    console.log((adjust ? '⚠️ ' : '✅ ') + s.name + ': ' + (lines.length ? lines.length + ' занятий, сдельно ' + perClass : 'оклад') + (pt.length ? ', персоналок ' + pt.length + (ptPay ? ' на ' + ptPay : ' (в окладе / без ставки)') : '') + (salary ? ', оклад ' + salary : '') + (adjust ? ', НЕ СХОДИТСЯ с in2 на ' + adjust : '') + (perClassMode ? ' · по решению владельца (в in2 оклад ' + Math.round(s.salary || 0) + ')' : '') + ' → итого ' + total);
  }
  if (parts.length) { await pg.setContent('<!doctype html><meta charset="utf-8">' + parts.map((h) => `<section style="page-break-after:always">${h}</section>`).join(''), { waitUntil: 'load' }); await pg.evaluate(() => document.fonts.ready);
    fs.writeFileSync(path.join(OUT, `AcroGym-Payslips-${YM}-ALL${SFX}.pdf`), await pg.pdf({ width: '210mm', height: '297mm', printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } })); }
  fs.writeFileSync(path.join(OUT, LANG === 'ru' ? 'summary-ru.json' : 'summary.json'), JSON.stringify(summary, null, 1));
  if (Object.keys(OV).length) fs.writeFileSync(OV_FILE, JSON.stringify(OVS, null, 1));
  await br.close(); process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });

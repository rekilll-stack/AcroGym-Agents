'use strict';
/* Сплошная проверка занятий in2 по всем правилам владельца. Только чтение.
   node check-class.js 2026-09-20            → все занятия дня
   node check-class.js --occ=8336406,8336447 → конкретные занятия
   Проверяет: зал, Outdoors, Ignore Room, Single Session, запись клиентов, обложку,
   пакеты, вместимость по правилу зала, ставку тренера. */
const panel = require('/home/admin/mcp-servers/in2-panel/panel.js');
require('/home/admin/acrogym/node_modules/dotenv').config({ path: '/home/admin/acrogym/.env' });
const in2 = require('/home/admin/acrogym/shared/in2');

const ARG = process.argv.slice(2);
const OCC = (ARG.find((a) => a.startsWith('--occ=')) || '').split('=')[1];
const DATE = ARG.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
/* правило владельца: будни до 12:00 — 6 мест, суббота и всё дневное — 10 */
const slotsFor = (date, hhmm) => { const d = new Date(date + 'T00:00:00Z').getUTCDay(); return (d !== 6 && d !== 0 && +hhmm.slice(0, 2) < 12) ? 6 : 10; };

const readForm = (page) => page.evaluate(() => {
  const val = (ph) => { const i = document.querySelector(`input[placeholder="${ph}"]`); return i ? i.value : null; };
  const fc = (n) => { const i = document.querySelector(`input[formcontrolname="${n}"]`); return i ? i.value : null; };
  const sel = (label) => { const f = [...document.querySelectorAll('mat-form-field')].find((x) => { const l = x.querySelector('mat-label'); return l && l.textContent.trim() === label; }); const s = f && f.querySelector('mat-select'); return s ? s.textContent.replace(/\s+/g, ' ').trim() : null; };
  const box = (name) => { for (const i of document.querySelectorAll('input[type=checkbox]')) { let el = i.closest('mat-checkbox, .mat-mdc-checkbox, label, div'), t = ''; for (let k = 0; k < 4 && el; k++) { t = (el.innerText || '').trim(); if (t.length > 2) break; el = el.parentElement; } if (t.replace(/\s+/g, ' ').startsWith(name)) return i.checked; } return null; };
  return { title: val('Title'), instr: val('Instructor'), room: val('Select Field or Room'), time: val('From'), dur: val('Duration (mins)'),
    fromAge: fc('fromAge'), toAge: fc('toAge'), slots: fc('slots'), payRate: sel('Pay Rate'),
    booking: box('Disable Client Booking'), out: box('Outdoors'), roomConf: box('Ignore Room Conflict'), single: box('Enable Single Session'),
    imgs: [...document.querySelectorAll('img')].filter((i) => (i.src || '').length > 30).length };
});

(async () => {
  let targets = [];
  if (OCC) {
    for (const x of OCC.split(',')) {
      const id = +x.trim();
      const o = await in2.occurrence(id).catch(() => null); /* дата и время нужны для правила вместимости */
      targets.push({ id, when: o ? String(o.startTime).slice(0, 5) : '', date: o ? o.startDate : DATE, title: o ? o.title : '' });
    }
  }
  else {
    const ev = await in2.call('/classes/events?selectedDate=' + DATE).catch(() => []);
    targets = (Array.isArray(ev) ? ev : []).map((e) => ({ id: e.id, when: String(e.startTime).slice(0, 5), title: e.title, date: DATE }));
    console.log(`день ${DATE}: занятий ${targets.length}`);
  }
  if (!targets.length) { console.log('нечего проверять'); return; }
  await panel.ensureLogin(); const page = panel.getPage();
  let problems = 0;
  for (const t of targets) {
    await page.goto(`https://portal.joinin2.com/portal/activities/activity/${t.id}?listView=true`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    const pk = await page.evaluate(() => (/No packages applicable/.test(document.body.innerText) ? '' : ((document.body.innerText.match(/Packages:[^\n]*/) || [''])[0])));
    await page.locator('button:has-text("Edit")').first().click({ force: true }).catch(() => {});
    await page.waitForFunction(() => !!document.querySelector('input[placeholder="Title"]'), { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const f = await readForm(page);
    if (!f.title) { console.log(`\n${t.id}: форма не открылась`); problems++; continue; }
    const hhmm = (t.when || (f.time || '').replace(/(\d+):(\d+) (AM|PM)/, (m, h, mm, ap) => String((+h % 12) + (ap === 'PM' ? 12 : 0)).padStart(2, '0') + ':' + mm));
    const need = slotsFor(t.date || DATE, hhmm);
    const checks = {
      'зал указан': /AcroGym/.test(f.room || ''),
      'Outdoors снят': f.out === false,
      'Ignore Room': f.roomConf === true,
      'Single снят': f.single === false,
      'запись закрыта': f.booking === true,
      'обложка': f.imgs >= 2,
      'пакеты': !!pk,
      [`мест ${need}`]: f.slots === String(need),
      'ставка': /Kristina|Leyla|Rauf/i.test(f.instr || '') /* оклад, без ставки за занятие (Rauf 1800 — 27.09): поле должно быть ПУСТЫМ — «Group Class (Disabled)» и «Kris Salary» in2 всё равно начисляет (30.09) */ ? (!f.payRate || f.payRate === 'Pay Rate') : !!(f.payRate && f.payRate !== 'Pay Rate' && !/disabled/i.test(f.payRate)),
    };
    const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    problems += bad.length;
    console.log(`\n${hhmm} «${f.title}» (${t.id}) · ${f.instr} · ${f.dur} мин · ${f.fromAge}-${f.toAge} лет · ${f.slots} мест`);
    console.log('  ' + Object.entries(checks).map(([k, v]) => (v ? '✅ ' : '🔴 ') + k).join(' · '));
    if (bad.length) console.log('  ИСПРАВИТЬ: ' + bad.join(', '));
  }
  console.log(`\nИТОГ: ${problems ? problems + ' расхождений — чинить до отчёта владельцу' : 'все проверки пройдены'}`);
  await panel.close();
})().catch(async (e) => { console.error('ОШИБКА', String(e.message).split('\n')[0].slice(0, 170)); try { await panel.close(); } catch (_) {} process.exit(1); });

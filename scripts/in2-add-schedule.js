/* Новый слот в СУЩЕСТВУЮЩУЮ карточку через Add Schedule (правило владельца 18.09; процедура — ~/.claude/CLAUDE.md «Заведение и проверка занятий in2»).
   ВНИМАНИЕ: пакеты из этой формы к новому слоту НЕ привязываются — после сохранения всегда in2-card-packages.js.
   Без GO=1 — только заполняет и показывает, что получилось, ничего не сохраняя. */
const panel = require('/home/admin/mcp-servers/in2-panel/panel.js');
const GO = process.env.GO === '1';
const ONLY = process.env.ONLY || '';
const UNTIL = '24/06/2027';
/* Задание — через env JOB (JSON): {"key":"x","label":"сб 16:15 · 7-10 Leyla","gid":123605,"date":"26/09/2026","time":"04:15 PM","ages":["7","10"],"ignoreTrainer":false}
   gid = idScheduleGroup карточки (есть в GET /classes/events у занятий этой группы). Без GO=1 — репетиция. */
const JOBS = process.env.JOB ? [JSON.parse(process.env.JOB)] : [];
if (!JOBS.length) { console.error("нет JOB — см. комментарий в начале файла"); process.exit(1); }
const set = (page, ph, value) => page.evaluate(({ ph, value }) => {
  const i = document.querySelector(`input[placeholder="${ph}"]`);
  if (!i) return false;
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(i, value);
  i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); i.blur();
  return true;
}, { ph, value });

const read = (page) => page.evaluate(() => {
  const val = (ph) => { const i = document.querySelector(`input[placeholder="${ph}"]`); return i ? i.value : null; };
  const fc = (name) => { const i = document.querySelector(`input[formcontrolname="${name}"]`); return i ? i.value : null; };
  const sel = (label) => { const f = [...document.querySelectorAll('mat-form-field')].find((x) => { const l = x.querySelector('mat-label'); return l && l.textContent.trim() === label; }); const s2 = f && f.querySelector('mat-select'); return s2 ? s2.textContent.replace(/\s+/g, ' ').trim() : null; };
  const boxes = {};
  for (const i of document.querySelectorAll('input[type=checkbox]')) {
    let el = i.closest('mat-checkbox, .mat-mdc-checkbox, label, div'), t = '';
    for (let k = 0; k < 4 && el; k++) { t = (el.innerText || '').trim(); if (t.length > 2) break; el = el.parentElement; }
    boxes[t.replace(/\s+/g, ' ').slice(0, 36)] = i.checked;
  }
  return { out: { Title: val('Title'), Instructor: val('Instructor'), Room: val('Select Field or Room'), date: val('Event Date'), time: val('From'), dur: val('Duration (mins)'), until: fc('repeatUntilDate'), occ: fc('occurences'), fromAge: fc('fromAge'), toAge: fc('toAge'), slots: fc('slots'), repeat: sel('Repeat'), packages: sel('Packages'), payRate: sel('Pay Rate') }, boxes };
});

const tick = (page, name) => page.evaluate((n) => {
  for (const i of document.querySelectorAll('input[type=checkbox]')) {
    let el = i.closest('mat-checkbox, .mat-mdc-checkbox, label, div'), t = '';
    for (let k = 0; k < 4 && el; k++) { t = (el.innerText || '').trim(); if (t.length > 2) break; el = el.parentElement; }
    if (t.replace(/\s+/g, ' ').slice(0, 36) === n) { if (!i.checked) (el.querySelector('label') || el).click(); return true; }
  }
  return false;
}, name);
(async () => {
  await panel.ensureLogin(); const page = panel.getPage();
  for (const j of JOBS) {
    if (ONLY && j.key !== ONLY) continue;
    console.log('\n──────── ' + j.label + (GO ? '' : '  (репетиция, без сохранения)'));
    if (j.gid) { await page.goto('https://portal.joinin2.com/portal/activities/activity/add?idScheduleGroup=' + j.gid, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
    else {
      await page.goto('https://portal.joinin2.com/portal/activities?listView=false', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3500);
      const sm = page.locator(':text("Schedule Management")').first(); if (await sm.count()) { await sm.click({ force: true }); await page.waitForTimeout(6000); }
      await page.locator('button:has-text("Add Schedule")').nth(j.cardIndex).click({ force: true });
    }
    await page.waitForTimeout(6000);
    const before = await read(page);
    console.log('карточка: «' + before.out.Title + '» · тренер ' + before.out.Instructor + ' · зал ' + before.out['Select Field or Room'] + ' · возраст ' + before.out.fromAge + '-' + before.out.toAge + ' · мест ' + before.out.slots);
    if (before.out.fromAge !== j.ages[0] || before.out.toAge !== j.ages[1]) { console.log('✗ возраст карточки не совпал с задачей — пропускаю'); continue; }
    /* заполняем */
    await set(page, 'Event Date', j.date); await page.waitForTimeout(700);
    await set(page, 'From', j.time); await page.waitForTimeout(700);   /* первое поле From — время, второе — возраст */
    await set(page, 'Duration (mins)', '50'); await page.waitForTimeout(500);
    await page.evaluate(() => { const f = [...document.querySelectorAll('mat-form-field')].find((x) => { const l = x.querySelector('mat-label'); return l && /^Repeat$/.test(l.textContent.trim()); }); const s = f && f.querySelector('mat-select'); if (s) s.click(); });
    await page.waitForTimeout(1500);
    await page.evaluate(() => { const o = [...document.querySelectorAll('.cdk-overlay-container mat-option')].find((x) => /weekly/i.test(x.textContent)); if (o) o.click(); });
    await page.waitForTimeout(1800);
    await set(page, 'End Date of Repetition', UNTIL); await page.waitForTimeout(800);
    /* пакеты: все восемь */
    await page.evaluate(() => { const f = [...document.querySelectorAll('mat-form-field')].find((x) => { const l = x.querySelector('mat-label'); return l && /^Packages/.test(l.textContent.trim()); }); const s = f && f.querySelector('mat-select'); if (s) s.click(); });
    await page.waitForTimeout(1800);
    const pk = await page.evaluate(() => { const list = [...document.querySelectorAll('.cdk-overlay-container mat-option')]; let n = 0; for (const o of list) { const on = o.classList.contains('mat-selected') || o.getAttribute('aria-selected') === 'true'; if (!on) { o.click(); n++; } } return { total: list.length, clicked: n }; });
    await page.waitForTimeout(1000); await page.evaluate(() => { const b = document.querySelector('.cdk-overlay-backdrop'); if (b) b.click(); }); await page.waitForTimeout(800); /* правило: закрывать кликом по подложке — Escape сбрасывает выбор */
    console.log('пакеты: отметил ' + pk.clicked + ' из ' + pk.total);
    /* галочки как у эталона */
    await tick(page, 'Disable Client Booking'); await page.waitForTimeout(400);
    await tick(page, 'Ignore Room Conflict'); await page.waitForTimeout(400);
    if (j.ignoreTrainer) { await tick(page, 'Ignore Trainer Conflict'); await page.waitForTimeout(400); }
    const after = await read(page);
    console.log('дата ' + after.out.date + ' · время ' + after.out.time + ' · длительность ' + after.out.dur + ' · повтор ' + after.out.repeat + ' до ' + after.out.until + ' · занятий ' + (after.out.occ || '—') + ' · мест ' + after.out.slots);
    console.log('пакеты в поле: ' + (after.out.packages || '').slice(0, 100) + ' · ставка: ' + after.out.payRate);
    console.log('галочки: ' + Object.entries(after.boxes).map(([k, v]) => (v ? '☑' : '☐') + k.split(' ').slice(0, 2).join(' ')).join(' · '));
    const okDate = after.out.date === j.date, okTime = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.test(after.out.time || '');
    if (!okDate || !okTime || after.out.dur !== '50' || !/weekly/i.test(after.out.repeat || '')) { console.log('✗ поля заполнились не так, НЕ сохраняю'); continue; }
    if (!GO) { console.log('репетиция прошла, сохранение не выполнялось'); continue; }
    const saved = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Save'); if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; });
    await page.waitForTimeout(4000);
    const dlg = await page.evaluate(() => { const d = document.querySelector('mat-dialog-container, [role=dialog]'); return d ? d.innerText.replace(/\s+/g, ' ').slice(0, 220) : null; });
    if (dlg) console.log('диалог после Save: ' + dlg);
    const btn = await page.evaluate(() => { const d = document.querySelector('mat-dialog-container, [role=dialog]'); if (!d) return null; const b = [...d.querySelectorAll('button')].find((x) => /apply to all|yes|ok|override|confirm/i.test(x.textContent)); if (!b) return 'кнопки не нашёл'; b.click(); return b.textContent.trim(); });
    if (btn) console.log('нажал: ' + btn);
    await page.waitForTimeout(5000);
    console.log('URL после сохранения: ' + page.url().slice(0, 90));
  }
  await panel.close();
})().catch(async (e) => { console.error('FATAL', String(e.message).split('\n')[0].slice(0, 180)); try { await panel.close(); } catch (_) {} process.exit(1); });

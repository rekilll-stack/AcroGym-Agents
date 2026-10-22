/* Перенос серии на другое время с этого занятия вперёд (Save → Apply To All). Записи детей сохраняются.
   NEW_TIME='02:20 PM' [GO=1] node in2-edit-time.js <occId>   — без GO только репетиция (ничего не сохраняет). */
const panel = require('/home/admin/mcp-servers/in2-panel/panel.js'); const T = process.env.NEW_TIME, GO = process.env.GO === '1';
(async () => { if (!/^\d{2}:\d{2} (AM|PM)$/.test(T || '')) throw new Error('NEW_TIME вида 02:20 PM');
  await panel.ensureLogin(); const page = panel.getPage();
  const read = () => page.evaluate(() => { const g = (l, last) => { const fs = [...document.querySelectorAll('mat-form-field')].filter((f) => { const x = f.querySelector('mat-label'); return x && x.textContent.trim().startsWith(l); }); const f = last ? fs[fs.length - 1] : fs[0]; const i = f && f.querySelector('input'); return i ? i.value : null; };
    return { title: g('Title'), coach: g('Instructor'), date: g('Event Date'), time: g('From'), age: g('From', true), dur: g('Duration'), room: g('Select Field or Room') }; });
  for (const id of process.argv.slice(2)) { try {
    await page.goto(`https://portal.joinin2.com/portal/activities/activity/${id}?listView=true`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const edit = page.locator('button:has-text("Edit")').first(); await edit.waitFor({ state: 'visible', timeout: 25000 }); await page.waitForTimeout(1300); await edit.click({ force: true }); await page.waitForTimeout(2600);
    const before = await read(); console.log(id, 'ДО:', JSON.stringify(before));
    await page.evaluate((T) => { const f = [...document.querySelectorAll('mat-form-field')].find((f) => (f.querySelector('mat-label') || {}).textContent?.trim().startsWith('From')); const i = f.querySelector('input'); /* ПЕРВОЕ From — время, последнее — возраст */
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, T); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); i.blur(); }, T);
    await page.waitForTimeout(1200); const after = await read(); console.log(id, 'В ФОРМЕ:', JSON.stringify(after));
    const norm = (s) => String(s || '').replace(/^0/, ''); if (norm(after.time) !== norm(T)) throw new Error('время не принялось: ' + after.time);
    for (const k of ['title', 'coach', 'date', 'age', 'dur', 'room']) if (after[k] !== before[k]) throw new Error('СТОП: изменилось поле ' + k);
    if (!GO) { console.log(id, 'репетиция ок, не сохраняю'); continue; }
    await page.evaluate(() => document.querySelectorAll('iframe').forEach((f) => { f.style.display = 'none'; }));
    const ok = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Save'); if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; }); if (!ok) throw new Error('нет Save');
    await page.waitForTimeout(2500); await page.evaluate(() => document.querySelectorAll('iframe').forEach((f) => { f.style.display = 'none'; }));
    const apply = page.locator('button:has-text("Apply To All")').first(); await apply.waitFor({ state: 'visible', timeout: 45000 });
    const rp = page.waitForResponse((r) => /editBookingEvent/.test(r.url()), { timeout: 30000 }).catch(() => null); await apply.click(); const r = await rp; const body = r ? await r.text().catch(() => '') : '';
    if (!r || r.status() !== 200 || !/"message":"valid"/.test(body)) throw new Error('editBookingEvent ' + (r ? r.status() : 'нет ответа') + ' ' + body.slice(0, 160));
    console.log(`✅ ${id} → ${T}`);
  } catch (e) { console.log(`❌ ${id}: ${String(e.message).slice(0, 180)}`); } }
  await panel.close(); })().catch(async (e) => { console.error('FATAL', e.message); try { await panel.close(); } catch (_) {} process.exit(1); });

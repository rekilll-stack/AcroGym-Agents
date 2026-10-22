/* Смена тренера серии с этого занятия вперёд (Apply To All): Title «· Omar»→«· Leyla», Instructor → Leyla Jabbarova, Pay Rate → NONE (оклад).
   node edit-coach.js occ1 occ2 … */
const panel = require('/home/admin/mcp-servers/in2-panel/panel.js');
const FROM = process.env.FROM || 'Omar', TO = process.env.TO || 'Leyla', TO_FULL = process.env.TO_FULL || 'Leyla Jabbarova'; /* FROM=Omar TO=Rauf TO_FULL='Rauf Jabbarov' node in2-edit-coach.js <occ…> — с этого занятия вперёд */
(async () => { await panel.ensureLogin(); const page = panel.getPage();
  const hidePromo = () => page.evaluate(() => document.querySelectorAll('iframe').forEach((f) => { f.style.display = 'none'; f.style.pointerEvents = 'none'; }));
  const read = () => page.evaluate(() => { const g = (l) => { for (const f of document.querySelectorAll('mat-form-field')) { const x = f.querySelector('mat-label'); if (x && x.textContent.trim().startsWith(l)) { const i = f.querySelector('input, textarea'); const s = f.querySelector('mat-select'); return s ? s.textContent.trim() : i ? i.value : null; } } return null; };
    return { title: g('Title'), coach: g('Instructor'), pay: g('Pay Rate'), time: g('From'), date: g('Event Date'), room: g('Select Field or Room') }; });
  for (const id of process.argv.slice(2)) { try {
    await page.goto(`https://portal.joinin2.com/portal/activities/activity/${id}?listView=true`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('button:has-text("Edit")').first().waitFor({ state: 'visible', timeout: 25000 }); await page.waitForTimeout(1300);
    await page.locator('button:has-text("Edit")').first().click({ force: true }); await page.waitForTimeout(2600);
    const before = await read(); console.log(id, 'ДО:', JSON.stringify(before));
    if (!before.title || !before.title.includes('· ' + FROM)) throw new Error('в названии нет «· ' + FROM + '» — пропуск');
    const title = before.title.replace('· ' + FROM, '· ' + TO);
    await page.evaluate((title) => { const f = [...document.querySelectorAll('mat-form-field')].find((f) => (f.querySelector('mat-label') || {}).textContent?.trim().startsWith('Title')); const i = f.querySelector('input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, title); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); }, title);
    const inp = page.locator('mat-form-field:has(mat-label:has-text("Instructor")) input'); await inp.click(); await inp.fill(''); await inp.type(TO, { delay: 60 }); await page.waitForTimeout(1200);
    await page.locator('mat-option', { hasText: TO_FULL }).first().click({ force: true }); await page.waitForTimeout(900);
    await page.evaluate(() => [...document.querySelectorAll('mat-form-field')].find((f) => (f.querySelector('mat-label') || {}).textContent?.includes('Pay Rate')).querySelector('mat-select').click()); await page.waitForTimeout(1000);
    await page.locator('mat-option', { hasText: 'NONE' }).first().click({ force: true }); await page.waitForTimeout(900);
    const after = await read(); console.log(id, 'В ФОРМЕ:', JSON.stringify(after));
    if (after.title !== title) throw new Error('Title не принялся');
    if (after.coach !== TO_FULL) throw new Error('тренер не выбрался: ' + after.coach);
    if (!/^(NONE|Pay Rate)?$/i.test(after.pay || '')) throw new Error('ставка не сброшена: ' + after.pay);
    if (after.time !== before.time || after.date !== before.date || after.room !== before.room) throw new Error('СТОП: поменялось время/дата/зал — не сохраняю');
    await hidePromo();
    const clicked = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Save'); if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; });
    if (!clicked) throw new Error('кнопка Save не найдена');
    await page.waitForTimeout(2500); await hidePromo();
    const apply = page.locator('button:has-text("Apply To All")').first(); await apply.waitFor({ state: 'visible', timeout: 45000 });
    const respP = page.waitForResponse((r) => /editBookingEvent/.test(r.url()), { timeout: 30000 }).catch(() => null);
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /Apply To All/i.test(x.textContent)); if (b) b.click(); });
    const r = await respP; const body = r ? await r.text().catch(() => '') : '';
    if (!r || r.status() !== 200 || !/"message":"valid"/.test(body)) throw new Error('editBookingEvent: ' + (r ? r.status() : 'нет ответа') + ' ' + body.slice(0, 200));
    console.log(`✅ ${id} → ${title}`); await page.waitForTimeout(1500);
  } catch (e) { console.log(`❌ ${id}: ${e.message.slice(0, 200)}`); await page.screenshot({ path: `/tmp/claude-1000/coach/err-${id}.png` }).catch(() => {}); } }
  await panel.close(); })().catch(async (e) => { console.error('FATAL', e.message); await panel.close().catch(() => {}); process.exit(1); });

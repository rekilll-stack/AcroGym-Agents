/* Запуск: TITLE="Gymnastics 7-10 · Omar" node in2-card-packages.js (TITLE — как карточка названа в Schedule Management, может быть по старому тренеру; Q=… — поиск)
   Edit Packages на конкретной карточке (по названию): все 8 пакетов → OK. Список закрывается кликом по подложке (Escape сбрасывает выбор). */
const p = require('/home/admin/mcp-servers/in2-panel/panel.js'); const WANT = process.env.TITLE || 'Gymnastics 7-10 · Leyla';
(async () => {
  await p.ensureLogin(); const page = p.getPage();
  await page.goto('https://portal.joinin2.com/portal/activities', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}); await page.waitForTimeout(4000);
  await page.locator(':text("Schedule Management")').first().click({ force: true }); await page.waitForTimeout(6000);
  if (process.env.Q) { const q = page.locator('input[placeholder*="Search Activities"]').first(); await q.fill(process.env.Q || 'Leyla'); await q.press('Enter').catch(() => {}); await page.waitForTimeout(6000); }
  console.log('после поиска:', (await page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => /Edit Packages/.test(b.textContent)).map((b) => { let el = b; for (let k = 0; k < 8 && el; k++) { el = el.parentElement; if (el && /Trainer/.test(el.innerText || '')) return el.innerText.replace(/\s+/g, ' ').slice(0, 60); } return '?'; }))).join(' | '));
  const n = await page.locator('button:has-text("Edit Packages")').count(); let done = 0;
  for (let i = 0; i < n; i++) {
    const btn = page.locator('button:has-text("Edit Packages")').nth(i);
    const title = await btn.evaluate((b) => { let el = b; for (let k = 0; k < 8 && el; k++) { el = el.parentElement; if (el && /Trainer/.test(el.innerText || '')) return el.innerText.replace(/\s+/g, ' ').slice(0, 80); } return '?'; });
    if (!title.includes(WANT)) continue;
    await btn.scrollIntoViewIfNeeded().catch(() => {}); await btn.click({ force: true }); await page.waitForTimeout(2500);
    const dlg = page.locator('mat-dialog-container').last(); await dlg.locator('mat-select').first().waitFor({ state: 'visible', timeout: 15000 }); await page.waitForTimeout(2500);
    console.log('карточка:', title.slice(0, 60), '| было:', (await dlg.locator('mat-select').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 90));
    await dlg.locator('mat-select').first().click({ force: true }); await page.waitForTimeout(1500);
    const st = await page.evaluate(() => { const os = [...document.querySelectorAll('.cdk-overlay-container mat-option')]; const on = (o) => o.classList.contains('mat-selected') || o.getAttribute('aria-selected') === 'true'; const real = os.filter((o) => !/select all/i.test(o.innerText)); let clicked = 0; for (const o of real) if (!on(o)) { o.click(); clicked++; } return { total: real.length, clicked }; });
    await page.waitForTimeout(800);
    const opts = await page.evaluate(() => [...document.querySelectorAll('.cdk-overlay-container mat-option')].filter((o) => !/select all/i.test(o.innerText)).map((o) => (o.classList.contains('mat-selected') || o.getAttribute('aria-selected') === 'true') ? 1 : 0).reduce((a, b) => a + b, 0));
    console.log('пакетов в списке:', st.total, '| доотметил:', st.clicked, '| отмечено теперь:', opts);
    await page.evaluate(() => { const bs = document.querySelectorAll('.cdk-overlay-backdrop'); if (bs.length) bs[bs.length - 1].click(); }); /* верхняя подложка — у выпадающего списка; первая — у диалога */ await page.waitForTimeout(900);
    console.log('поле после закрытия:', (await dlg.locator('mat-select').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 90));
    if (opts !== st.total) { console.log('✗ отмечены не все — OK не жму'); await dlg.locator('button:has-text("Cancel")').first().click({ force: true }).catch(() => {}); continue; }
    const respP = page.waitForResponse((r) => /editSchedulePackages/.test(r.url()), { timeout: 30000 }).catch(() => null);
    await dlg.locator('button:has-text("OK")').first().click({ force: true });
    const r = await respP; console.log('ответ:', r ? r.status() + ' ' + (await r.text().catch(() => '')).slice(0, 80) : 'нет ответа'); await page.waitForTimeout(2000); done++;
  }
  console.log('обработано карточек:', done); await p.close();
})().catch(async (e) => { console.error('FATAL', e.message.slice(0, 150)); await p.close().catch(() => {}); process.exit(1); });

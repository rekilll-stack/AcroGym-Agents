/* Доводка занятий, созданных через POST /classes (API ставит Outdoors ☑ и Single ☑, без зала и обложки).
   По одному занятию на каждый слот (серию): Outdoors ☐ → зал AcroGym Lagoona → Ignore Room ☑ → Single ☐ → Disable Client Booking ☑
   → обложка (копия с занятия COVER_FROM) → Save → Apply To All (editBookingEvent valid).
   Запуск: COVER_FROM=<occId с нужной обложкой> node in2-fix-new-class.js <occ1> <occ2> …   Пакеты — отдельно: in2-card-packages.js. */
const fs = require('fs'); const panel = require('/home/admin/mcp-servers/in2-panel/panel.js');
const LOGO = 'efde8ce0-2b51-46f2-9bf9-499cb7f391ed', FROM = +process.env.COVER_FROM, IDS = process.argv.slice(2).map(Number).filter(Boolean);
const cover = (page) => page.evaluate((logo) => [...document.querySelectorAll('img')].map((x) => x.src).filter((s) => /storage|bucket/i.test(s) && !s.includes(logo))[0] || null, LOGO);
const box = (page, text, want) => page.evaluate(([text, want]) => { const l = [...document.querySelectorAll('label')].find((x) => x.textContent.trim().startsWith(text)); const i = l && l.querySelector('input[type=checkbox]'); if (!i) return 'нет'; if (i.checked !== want) l.click(); return i.checked === want ? 'ок' : 'клик'; }, [text, want]);
const killPromo = (page) => page.evaluate(() => { const h = [...document.querySelectorAll('*')].find((x) => /Hide Combo Packages|from the Mobile App/i.test(x.textContent || '') && x.children.length <= 3); if (!h) return; let b = h; for (let i = 0; i < 8 && b.parentElement; i++) { b = b.parentElement; if (b.getBoundingClientRect().width > 350) break; } b.style.display = 'none'; });
(async () => {
  if (!FROM || !IDS.length) throw new Error('нужны COVER_FROM и id занятий');
  await panel.ensureLogin(); const page = panel.getPage();
  await page.goto(`https://portal.joinin2.com/portal/activities/activity/${FROM}?listView=true`, { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(3000);
  const src = await cover(page); if (!src) throw new Error('у источника обложки нет фото');
  const file = '/tmp/claude-1000/pics/cover-from-' + FROM + '.jpg'; fs.mkdirSync('/tmp/claude-1000/pics', { recursive: true });
  fs.writeFileSync(file, await (await page.context().request.get(src)).body()); console.log('обложка взята у', FROM);
  for (const id of IDS) {
    try {
      await page.goto(`https://portal.joinin2.com/portal/activities/activity/${id}?listView=true`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const edit = page.locator('button:has-text("Edit")').first(); await edit.waitFor({ state: 'visible', timeout: 25000 }); await page.waitForTimeout(1500); await edit.click({ force: true }); await page.waitForTimeout(3000);
      console.log(id, 'Outdoors:', await box(page, 'Outdoors', false)); await page.waitForTimeout(800);
      const inp = page.locator('mat-form-field:has(mat-label:has-text("Select Field or Room")) input').first(); await inp.waitFor({ state: 'attached', timeout: 15000 });
      if ((await inp.evaluate((el) => el.value)) !== 'AcroGym Lagoona') { await inp.evaluate((el) => { el.scrollIntoView({ block: 'center' }); el.focus(); el.click(); }); await page.waitForTimeout(400); await page.keyboard.type('AcroGym', { delay: 70 }); await page.waitForTimeout(1800);
        const picked = await page.evaluate(() => { const o = [...document.querySelectorAll('.cdk-overlay-container mat-option')].find((x) => x.textContent.includes('AcroGym Lagoona')); if (o) { o.click(); return true; } return false; }); if (!picked) throw new Error('нет опции AcroGym Lagoona'); }
      await page.waitForTimeout(600);
      console.log(id, 'Ignore Room:', await box(page, 'Ignore Room Conflict', true), '| Single:', await box(page, 'Enable Single Session', false), '| Disable Client Booking:', await box(page, 'Disable Client Booking', true));
      const fi = await page.$$('input[type=file]'); if (!fi.length) throw new Error('нет поля загрузки обложки'); await fi[0].setInputFiles(file); await page.waitForTimeout(3500);
      await page.mouse.click(200, 80); await page.waitForTimeout(500); await killPromo(page);
      await page.evaluate(() => document.querySelectorAll('iframe').forEach((f) => { f.style.display = 'none'; }));
      const saved = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Save'); if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; }); if (!saved) throw new Error('нет Save');
      await page.waitForTimeout(2500); await killPromo(page);
      const scr = (await page.locator('body').innerText()).replace(/\s+/g, ' '); if (/Required Field Missing/.test(scr)) throw new Error('Required Field Missing');
      const apply = page.locator('button:has-text("Apply To All")').first(); await apply.waitFor({ state: 'visible', timeout: 45000 });
      const rp = page.waitForResponse((r) => /editBookingEvent/.test(r.url()), { timeout: 30000 }).catch(() => null); await apply.click(); const r = await rp; const body = r ? await r.text().catch(() => '') : '';
      if (!r || r.status() !== 200 || !/"message":"valid"/.test(body)) throw new Error('editBookingEvent ' + (r ? r.status() : 'нет ответа') + ' ' + body.slice(0, 150));
      console.log(`✅ ${id} сохранено`); await page.waitForTimeout(1500);
    } catch (e) { console.log(`❌ ${id}: ${String(e.message).slice(0, 160)}`); }
  }
  await panel.close();
})().catch(async (e) => { console.error('FATAL', e.message); try { await panel.close(); } catch (_) {} process.exit(1); });

/* Удаление клиента in2 через панель (API удаления нет): /portal/clients → поиск → «…» → Delete → два подтверждения.
   NAME='Sofia Kozenyasheva' PHONE_TAIL='50858148' [GO=1] node in2-delete-client.js — строка должна содержать и имя, и хвост телефона, и быть единственной. Без GO — репетиция. */
const panel = require('/home/admin/mcp-servers/in2-panel/panel.js'); const NAME = process.env.NAME, TAIL = process.env.PHONE_TAIL, GO = process.env.GO === '1';
(async () => { if (!NAME || !TAIL) throw new Error('нужны NAME и PHONE_TAIL');
  await panel.ensureLogin(); const page = panel.getPage();
  await page.goto('https://portal.joinin2.com/portal/clients', { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(6000);
  const search = page.locator('table input[placeholder*="Search" i], input[placeholder*="Search" i]').last(); await search.fill(NAME); await page.keyboard.press('Enter').catch(() => {}); await page.waitForTimeout(5000);
  const rows = await page.evaluate(() => [...document.querySelectorAll('tr')].map((r, i) => ({ i, t: r.innerText.replace(/\s+/g, ' ').trim() })).filter((r) => r.t));
  const hit = rows.filter((r) => r.t.toLowerCase().includes(process.env.NAME.toLowerCase()));
  console.log('строки с именем:', hit.map((r) => r.t.slice(0, 140)).join(' || '));
  const target = hit.filter((r) => r.t.replace(/\D/g, '').includes(TAIL));
  if (target.length !== 1) { console.log('✗ строк с именем и телефоном …' + TAIL + ':', target.length, '— не удаляю'); await panel.close(); return; }
  if (!GO) { console.log('репетиция: удалил бы строку', target[0].t.slice(0, 140)); await panel.close(); return; }
  const row = page.locator('tr').nth(target[0].i); await row.locator('button, [class*=menu], mat-icon').last().click({ force: true }); await page.waitForTimeout(1500);
  await page.locator('.cdk-overlay-container button:has-text("Delete"), .cdk-overlay-container [role=menuitem]:has-text("Delete")').first().click({ force: true }); await page.waitForTimeout(1500);
  for (let k = 0; k < 2; k++) { const ok = page.locator('mat-dialog-container button:has-text("OK"), mat-dialog-container button:has-text("Yes"), mat-dialog-container button:has-text("Delete"), mat-dialog-container button:has-text("Confirm")').last(); if (await ok.count()) { await ok.click({ force: true }); console.log('подтверждение', k + 1); await page.waitForTimeout(2500); } }
  await page.goto('https://portal.joinin2.com/portal/clients', { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(5000);
  await page.locator('table input[placeholder*="Search" i], input[placeholder*="Search" i]').last().fill(NAME); await page.keyboard.press('Enter').catch(() => {}); await page.waitForTimeout(5000);
  const left = await page.evaluate((n) => [...document.querySelectorAll('tr')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()).filter((t) => t.toLowerCase().includes(n.toLowerCase())), NAME);
  console.log('после удаления строк с именем:', left.length, left.map((t) => t.slice(0, 120)).join(' || '));
  await panel.close(); })().catch(async (e) => { console.error('FATAL', e.message.slice(0, 200)); try { await panel.close(); } catch (_) {} process.exit(1); });

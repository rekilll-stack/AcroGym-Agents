#!/usr/bin/env node
/* Seesaw → архив + школьный раздел Джарвиса (владелец 20.10: «сохрани все данные и следи, всё отслеживай»).
   Каждый запуск (крон раз в час) по сохранённому входу (data/seesaw/session.json, без повторных логинов и без капчи):
   1) сообщения всех бесед учителей → data/seesaw/messages/<беседа>.json (+ картинки вложений в files/, подписанные ссылки живут ~14 дней);
   2) лента постов (ответ /api/person/parent/feed) → data/seesaw/feed/<дата>.json + все фото/картинки в files/;
   3) новые РАССЫЛКИ (вложения-картинки) учителя ребёнка → распознаём (vision, подписка) только события этого класса/всей школы
      с датой ≥ сегодня → school.json kids[].dated с src; пуш в Джарвис, что добавлено. Текст сообщений уже приходит письмом (mail.db).
   Вход слетел → один пуш в день «нужен вход» со ссылкой на окно (капчу проходит только владелец).
     node agents/seesaw/sync.js [--no-llm] [--dry]                       */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const DIR = '/home/admin/acrogym/data/seesaw', SESSION = DIR + '/session.json', STATE = DIR + '/state.json', FILES = DIR + '/files';
const SCHOOL = '/home/admin/mcp-servers/jarvis-bridge/school.json';
const { chromium } = require('/home/admin/acrogym-design-system/.ds-sync/node_modules/playwright');
const arg = process.argv.slice(2), DRY = arg.includes('--dry'), NOLLM = arg.includes('--no-llm');
const log = (...a) => console.log(new Date().toISOString(), '[seesaw]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const save = (f, v) => { fs.writeFileSync(f, JSON.stringify(v, null, 1)); fs.chmodSync(f, 0o600); };
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
for (const d of [DIR, FILES, DIR + '/messages', DIR + '/feed']) fs.mkdirSync(d, { recursive: true, mode: 0o700 });

function notify(title, body) { /* как у теннис-агента: таблица notif почтового секретаря → пуш в Джарвис */
  if (DRY) return log('PUSH(dry)', title, body);
  try { const db = new (require('/home/admin/acrogym/node_modules/better-sqlite3'))('/home/admin/acrogym/data/mail.db');
    db.prepare('INSERT OR REPLACE INTO notif(id,title,body,at) VALUES(?,?,?,?)').run('seesaw-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), title, body, new Date().toISOString()); db.close();
  } catch (e) { log('notif ERR', e.message); }
}
/* --check (крон :50, 10–22): последний удачный прогон старше 3 ч → пуш раз в день (21.10: синк молча падал сутки на обёртке heavy) */
if (arg.includes('--check')) {
  const age = (Date.now() - Date.parse(load(STATE, {}).lastRun || 0)) / 36e5, CHK = DIR + '/check.json', c = load(CHK, {});
  if (age > 3 && c.alarmed !== today()) { notify('⚠️ Seesaw не синхронизируется', `Последняя удачная синхронизация ${Math.round(age)} ч назад — новые сообщения школы не приходят. Скажи Claude: «проверь Seesaw».`); save(CHK, { alarmed: today() }); }
  return log('check: последний удачный прогон', age.toFixed(1), 'ч назад');
}
/* картинка Seesaw: imaging.seesaw.me?url=<подписанная s3-ссылка> → files/<uuid>.<ext>; повтор не качаем */
async function fetchFile(u) {
  const m = decodeURIComponent(u).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.(jpg|jpeg|png|gif|mp4|pdf|webp)/i); if (!m) return null;
  const out = path.join(FILES, m[1] + '.' + m[2].toLowerCase()); if (fs.existsSync(out)) return out;
  if (/mp4/i.test(m[2])) return null; /* видео не качаем — ссылку храним в архиве */
  try { const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) }); if (!r.ok) return null;
    fs.writeFileSync(out, Buffer.from(await r.arrayBuffer())); fs.chmodSync(out, 0o600); return out; } catch { return null; }
}

/* беседа: прокрутка вверх до конца истории, затем все пузыри с вложениями (многостраничные — листаем) */
async function readConversation(p, deep) {
  const box = p.locator('[data-testid=":bidirectional-infinite-scroll"]');
  let prev = -1;
  for (let i = 0; i < (deep ? 40 : 2); i++) { /* первый проход — вся история, дальше хватает последних сообщений */
    const n = await p.locator('[data-testid=":msg-bubble-container"]').count(); if (n === prev && i > 2) break; prev = n;
    await box.evaluate((el) => { el.scrollTop = 0; }).catch(() => {}); await p.mouse.wheel(0, -5000); await sleep(1300);
  }
  const conts = p.locator('[data-testid=":msg-bubble-container"]'), out = [];
  for (let i = 0; i < await conts.count(); i++) {
    const c = conts.nth(i);
    const head = (await c.innerText().catch(() => '')).split('\n').find((l) => /\|\d{2}\/\d{2}\/\d{4}/.test(l)) || '';
    const ts = await c.locator('[data-testid=":msg-bubble-timestamp"]').first().innerText().catch(() => '');
    const text = await c.locator('[data-testid=":msg-bubble-contents"]').first().innerText().catch(() => '');
    const imgs = new Set();
    const items = c.locator('[data-testid=":open-item-modal"]');
    for (let k = 0; k < await items.count(); k++) {
      const it = items.nth(k);
      for (const s of await it.locator('img').evaluateAll((a) => a.map((x) => x.src))) if (/imaging\.seesaw\.me/.test(s)) imgs.add(s);
      const ind = await it.locator('[data-testid=":page-indicator"]').count() ? await it.locator('[data-testid=":page-indicator"]').first().innerText().catch(() => '') : ''; /* у одностраничных счётчика нет — без count() ждали бы 30 с */ const pages = +((ind.match(/\/\s*(\d+)/) || [])[1] || 1);
      for (let pg = 1; pg < pages && pg < 20; pg++) { await it.locator('[data-testid=":next-page"]').click({ force: true }).catch(() => {}); await sleep(900);
        for (const s of await it.locator('img').evaluateAll((a) => a.map((x) => x.src))) if (/imaging\.seesaw\.me/.test(s)) imgs.add(s); }
    }
    const author = (head.split('|')[0] || '').trim(), when = (head.split('|')[1] || ts || '').trim();
    out.push({ key: sha(author + '|' + when + '|' + text.slice(0, 200)), author, when, text: text.trim(), images: [...imgs] });
  }
  return out;
}
/* «24/09/2026 at 13:19» → 2026-09-24 */
const words = (t) => new Set(String(t || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter((w) => w.length > 3));
const overlap = (a, b) => { const A = words(a), B = words(b); let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.max(1, Math.min(A.size, B.size)); };
const isoOf = (w) => { const m = String(w).match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

/* рассылка-картинка → события класса с датой (vision через подписку); строго: только то, что прямо сказано */
async function extract(kid, teacher, msg, files) {
  const { generateText } = require('/home/admin/acrogym/agents/content-bot/llm.js');
  const images = files.filter((f) => /\.(jpe?g|png)$/i.test(f)).slice(0, 6).map((f) => ({ data: fs.readFileSync(f).toString('base64'), media_type: /png$/i.test(f) ? 'image/png' : 'image/jpeg' }));
  if (!images.length) return [];
  const sys = 'Ты аккуратно выписываешь даты из школьной рассылки. Ничего не придумывай. Только то, что прямо написано.';
  const user = `Рассылка учителя ${teacher} (класс ребёнка: ${kid.cls[0]}; ребёнок ${kid.name[0]}), сообщение от ${msg.when}: «${msg.text.slice(0, 600)}».
Сегодня ${today()}. Выпиши ТОЛЬКО события с конкретной датой не раньше сегодняшней, которые прямо относятся к ЭТОМУ классу (${kid.cls[0]}) или ко всей школе/всем Early Years: фото, поездки, костюмы/цвет одежды, что принести, праздники, оплаты, выходные. Если событие для другого класса — не выписывай.
Ответ — ТОЛЬКО JSON-массив: [{"date":"ГГГГ-ММ-ДД","ru":"кратко по-русски, что нужно (одежда/что принести)","en":"same in English","quote":"дословная цитата из рассылки"}]. Нет событий — [].`;
  let raw = ''; try { raw = await generateText({ system: sys, user, images }); } catch (e) { log('llm ERR', e.message); return null; } /* null = повторить в следующий прогон */
  const m = String(raw).match(/\[[\s\S]*\]/); let arr = []; try { arr = JSON.parse(m ? m[0] : '[]'); } catch { arr = []; }
  return arr.filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.date) && x.date >= today() && x.ru && x.quote);
}

(async () => {
  if (!fs.existsSync(SESSION)) { log('нет сессии'); process.exit(2); }
  const st = load(STATE, { seen: {}, posts: {}, askedLogin: null });
  const b = await chromium.launch(); const ctx = await b.newContext({ storageState: SESSION, viewport: { width: 1280, height: 1400 }, locale: 'en-GB', timezoneId: 'Asia/Qatar' }); /* 21.10: без LANG (крон) Chromium брал en-US → даты «09/24/2026 4:25 PM» и ключи сообщений менялись → 44 ложных «новых» */ const p = await ctx.newPage();
  p.setDefaultTimeout(4000); /* отсутствующий элемент пузыря не должен держать по 30 с */
  const feeds = []; p.on('response', async (r) => { if (/\/api\/person\/parent\/feed/.test(r.url())) { try { feeds.push(await r.json()); } catch (_) {} } });
  const added = [], newMsgs = [];
  try {
    await p.goto('https://app.seesaw.me/#/family/feed', { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(9000);
    if (/#\/login/.test(p.url()) || await p.getByText('Sign In as a Family Member').count()) {
      if (st.askedLogin !== today()) { notify('🏫 Seesaw: нужен вход', 'Сессия Seesaw закончилась. Откройте https://acrogym.org/schedule/seesaw/ (окно запускаю я по вашей команде) — капчу проходите вы.'); st.askedLogin = today(); save(STATE, st); }
      log('вход слетел'); return;
    }
    for (let i = 0; i < 6; i++) { await p.mouse.wheel(0, 6000); await sleep(1500); } /* догрузка ленты */
    /* 2) лента: сырые ответы + все картинки */
    if (feeds.length) { save(path.join(DIR, 'feed', today() + '.json'), feeds);
      const urls = new Set(); JSON.stringify(feeds).replace(/https?:\\?\/\\?\/[^"\s]+?(magiccam-assets|imaging\.seesaw)[^"\s]+/g, (u) => urls.add(u.replace(/\\\//g, '/')));
      let n = 0; for (const u of urls) { if (await fetchFile(u)) n++; } log('лента: ответов', feeds.length, 'файлов', n); }
    /* 1) сообщения */
    await p.locator('button[aria-label^="Messages"]').click({ force: true }); await sleep(7000);
    const school = load(SCHOOL, { kids: [] }), K = school.kids || [];
    const btns = p.locator('[data-testid=":conversation-list-item"]'), nConv = await btns.count(); /* «…-item-button» — это меню «⋯», не сама беседа */
    for (let i = 0; i < nConv; i++) {
      await btns.nth(i).click({ position: { x: 40, y: 20 } }).catch(() => btns.nth(i).click({ force: true })); await sleep(6000);
      const header = (await p.locator('[data-testid=":conversation-header"]').innerText().catch(() => 'conv' + i)).split('\n')[0].trim();
      const conv = p.url().match(/conv\.[A-Z0-9]+/i)?.[0] || 'conv' + i;
      const msgs = await readConversation(p, !st.initDone);
      const file = path.join(DIR, 'messages', conv + '.json'), arch = load(file, { header, messages: [] });
      const have = new Set(arch.messages.map((m) => m.key));
      for (const m of msgs) {
        m.files = []; for (const u of m.images) { const f = await fetchFile(u); if (f) m.files.push(path.basename(f)); }
        if (!have.has(m.key)) { arch.messages.push({ ...m, saved: new Date().toISOString() }); have.add(m.key); }
        if (!st.seen[m.key]) { st.seen[m.key] = today(); newMsgs.push({ header, conv, m }); }
      }
      arch.header = header; save(file, arch); log('беседа', header, 'сообщений', msgs.length);
    }
    /* 3) новые рассылки (картинки) учителя ребёнка → события в школьный раздел */
    const firstRun = !st.initDone;
    for (const { header, m } of newMsgs) {
      if (!m.files.length || NOLLM) continue;
      const d = isoOf(m.when); if (firstRun && (!d || d < new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10))) continue; /* архив: распознаём только последние 30 дней */
      const kid = K.find((k) => new RegExp(k.match, 'i').test(header + ' ' + m.author)); if (!kid) continue;
      const ev = await extract(kid, m.author || header, m, m.files.map((f) => path.join(FILES, f)));
      if (!ev) { delete st.seen[m.key]; continue; } /* 21.10: ИИ недоступен (обновлялся claude CLI) — рассылку не теряем, разберём в следующий прогон */
      for (const x of ev) {
        kid.dated = kid.dated || [];
        /* одно событие повторяется в нескольких еженедельных рассылках — не плодим дубли: та же дата и похожие слова = уже есть */
        if (kid.dated.some((y) => y.date === x.date && overlap(y.ru + ' ' + (y.quote || ''), x.ru + ' ' + x.quote) >= 0.25)) continue;
        kid.dated.push({ date: x.date, ru: x.ru, en: x.en || x.ru, src: `Seesaw: ${m.author || header}, ${m.when}`, quote: String(x.quote).slice(0, 300) });
        added.push(`${kid.name[0]} ${x.date.slice(8)}.${x.date.slice(5, 7)}: ${x.ru}`);
      }
    }
    if (added.length && !DRY) { fs.copyFileSync(SCHOOL, SCHOOL + '.bak-seesaw'); fs.writeFileSync(SCHOOL, JSON.stringify(school, null, 1)); }
    if (added.length) notify('🏫 Seesaw: новое в «Школе»', added.slice(0, 8).join('\n'));
    else if (newMsgs.length && !firstRun) notify('🏫 Seesaw: новые сообщения', newMsgs.slice(0, 5).map(({ header, m }) => `${(m.author || header).split(' ')[0]}: ${m.text.replace(/\s+/g, ' ').slice(0, 90)}`).join('\n'));
    st.initDone = true; st.lastRun = new Date().toISOString(); save(STATE, st);
    await ctx.storageState({ path: SESSION }); fs.chmodSync(SESSION, 0o600);
    log('готово: новых сообщений', newMsgs.length, 'событий в Школу', added.length);
  } finally { await b.close(); }
})().catch((e) => { log('ERR', e.message); process.exit(1); });

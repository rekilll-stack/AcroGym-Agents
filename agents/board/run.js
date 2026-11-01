'use strict';

/**
 * agents/board/run.js — ежемесячный «совет директоров» AcroGym (задача владельца 31.10, #2069).
 *
 *   node agents/board/run.js [ГГГГ-ММ] [--reuse]   (--reuse — взять уже собранные facts.json / ответы ролей)
 *
 * 1) collect.js — факты месяца (только чтение: Payroll in2, мост Джарвиса, наша БД);
 * 2) цифры целей года и светофоры считает КОД (kpis) — модель их не придумывает;
 * 3) 8 ролей-специалистов на подписке (claude -p, как content-bot) дают выводы и 3–5 советов каждый;
 * 4) директор сводит: вердикт, план до 5 пунктов, статусы стратегии, комментарии к целям, свои советы;
 * 5) PDF RU и EN в docs/board/<ym>/ (папка в .gitignore — там зарплаты и имена детей).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const dayjs = require('dayjs');

const ROOT = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { collect, responseTimes } = require('./collect');
const { runCli } = require('../content-bot/agent');
const { html, kpis, renderPdf, STRATEGY, ROLES } = require('./view'); /* цифры целей и внешний вид — общие с экраном Джарвиса */

const MODEL = process.env.BOARD_MODEL || 'opus';
const PARALLEL = 3;


const CAVEATS = `ОГРАНИЧЕНИЯ ДАННЫХ (учитывай, не делай ложных выводов):
- «Заработано» (pnl.earned) — выручка с термом, разнесённым по дням пакета; «получено» — касса. Сентябрьская касса выше из-за термов, оплаченных вперёд.
- Дети на занятиях и ЗП — из Payroll in2 (засчитанные in2). Кристина в расходах движка не считается (not_cost) — её оплата добавлена отдельно в «прибыль с полной оплатой».
- Оплата управляющего 11 000 QAR — ОЦЕНКА по открытым данным (marketPay), не факт.
- Скорость ответа считается по кнопке «✅ Ответил»; если админ ответил в WhatsApp и не нажал — время завышено. Ночь считается с 9:00.
- Воронка заявок lead_stats сопоставляет заявки с карточками in2 по телефону/имени: Meta 332 заявки → 15 карточек может означать и плохие заявки, и плохое сопоставление.
- Продления октября занижены школьными каникулами 25–29.10 (семьи откладывали); «ещё решают» — закончились < 7 дней назад.
- Причины отказа в чек-листе админов собираются только с 31.10; отчёты о прогрессе — инструмент запущен 24.10.
- Омар больше не работает (ушёл), его строки — история.
- ЗП по Payroll in2 (payrollStaff — весь штат): Okba Labio (он же Okba Labiod в счетах RCH) — оклад 3 000, в движке P&L он стоит в списке «coaches» как поштучный — это не расхождение. Рауф в in2 — 1 742 (оклад с даты начала), в постоянных — 1 800. У Кристины +439 сверх оклада — персоналки по ставке in2 «Private Session (Disabled)».
- Прогресс (progress): отметки навыков тренеры ставят с запуска 24.10; «ready»/«sent» — отчёты родителям, подготовленные/отправленные за месяц.`;

const ADVICE_SCHEMA = `"advice": [ { "title": {"ru": "", "en": ""}, "what": {"ru": "что именно сделать", "en": ""}, "effect": {"ru": "ожидаемый эффект, по возможности в цифрах", "en": ""}, "effort": "low|medium|high", "cost": {"ru": "0 или сумма QAR", "en": ""}, "owner": {"ru": "кто делает", "en": ""}, "deadline": "ГГГГ-ММ-ДД" } ]  // 3–5 советов`;

function rolePrompt(role, f, k) {
  const [, ru, , focus] = role;
  return `Ты — ${ru} в совете директоров детского гимнастического центра AcroGym (Lagoona Mall, Доха, Катар; открылся 01.09.2026). Раз в месяц совет разбирает итоги месяца для владельца — Кирилла. Месяц: ${f.ym}.
Твоя зона: ${focus}.

ПРАВИЛА
- Опирайся ТОЛЬКО на ФАКТЫ, ЦЕЛИ (с уже посчитанными значениями) и СТРАТЕГИЮ ниже. Не придумывай цифр. Нет данных — скажи прямо и предложи, как их собрать.
- Пиши просто и коротко, без жаргона, как для занятого владельца. Числа — ровно как в фактах.
- Советы — конкретные действия на 1–3 месяца, только в своей зоне; сроки не позже ${dayjs(f.to).add(3, 'month').format('YYYY-MM-DD')}. Ответственные — реальные люди: Кирилл (владелец), Кристина (старший тренер), админы Michael и Bruhan, тренеры Лейла, Рауф, Алина, Андрей, или бот/Джарвис.
- Каждый текст — на двух языках: ru и en (английский естественный, не дословный).
- Не используй инструменты. Ответ — ТОЛЬКО JSON, без пояснений и без \`\`\`.

${CAVEATS}

СХЕМА ОТВЕТА
{ "summary": {"ru": "2–4 предложения: главное в твоей зоне за месяц", "en": ""},
  "findings": [ {"ru": "факт с цифрой и что он значит", "en": ""} ],  // 2–4
  ${ADVICE_SCHEMA} }

ЦЕЛИ ГОДА (значения уже посчитаны кодом; status: green/yellow/red, base = этот месяц — база, grey = нет данных):
${JSON.stringify(k)}

ФАКТЫ:
${JSON.stringify(compactFacts(f))}

СТРАТЕГИЯ ВЛАДЕЛЬЦА:
${f.strategy}`;
}

function directorPrompt(f, k, roles) {
  return `Ты — Директор (CEO) в совете директоров детского гимнастического центра AcroGym (Доха). Месяц: ${f.ym}. Ты сводишь мнения совета в решение для владельца — Кирилла.
Перед тобой: цели года (посчитаны кодом), факты, стратегия владельца и выводы 8 членов совета.

ЗАДАЧИ
1) "verdict": 3–5 предложений — как прошёл месяц и что сейчас главное.
2) "plan": до 5 действий на следующий месяц — самые важные из советов совета (можно объединять), каждое с ответственным, сроком и мерилом успеха.
3) "kpiComments": по каждой цели (id из ЦЕЛЕЙ) — одна фраза простыми словами: что значит значение и что делать.
4) "strategy": статус каждого пункта стратегии (ключи ниже) — green (идёт по плану), yellow (начато/есть риски), red (не начато или идёт плохо) и короткий комментарий с опорой на факты. Будь честен: месяц только второй.
5) Свои 3–5 советов уровня директора.

ПРАВИЛА: только факты из данных, без выдуманных цифр; просто и коротко; каждый текст на ru и en; не используй инструменты; ответ — ТОЛЬКО JSON без \`\`\`.

${CAVEATS}

СХЕМА
{ "verdict": {"ru": "", "en": ""},
  "plan": [ {"what": {"ru": "", "en": ""}, "why": {"ru": "", "en": ""}, "owner": {"ru": "", "en": ""}, "deadline": "ГГГГ-ММ-ДД", "metric": {"ru": "как поймём, что сделано", "en": ""}} ],
  "kpiComments": { "<id цели>": {"ru": "", "en": ""} },
  "strategy": [ {"key": "y1", "status": "green|yellow|red", "comment": {"ru": "", "en": ""}} ],
  ${ADVICE_SCHEMA} }

ПУНКТЫ СТРАТЕГИИ: ${JSON.stringify(STRATEGY.map(([key, ru]) => ({ key, ru })))}

ЦЕЛИ ГОДА: ${JSON.stringify(k)}

ВЫВОДЫ СОВЕТА: ${JSON.stringify(roles.map((r) => ({ role: r.role, summary: r.summary && r.summary.ru, findings: (r.findings || []).map((x) => x.ru), advice: (r.advice || []).map((a) => ({ title: a.title && a.title.ru, effect: a.effect && a.effect.ru, owner: a.owner && a.owner.ru, deadline: a.deadline })) })))}

ФАКТЫ: ${JSON.stringify(compactFacts(f))}

СТРАТЕГИЯ ВЛАДЕЛЬЦА:
${f.strategy}`;
}

/* В промпт — без длинных списков (графики по дням, имена в продлениях) */
function compactFacts(f) {
  const { strategy, goals, ...rest } = f;
  const strip = (s) => s && { ...s, gym: s.gym && { ...s.gym, visitsByDate: undefined } };
  return { ...rest, month: strip(f.month), prevMonth: strip(f.prevMonth), ownerContext: goals && goals.owner_context_ru };
}

async function ask(prompt, label) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'board-'));
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const run = await runCli(prompt, { model: MODEL, maxTurns: 3, timeoutMs: 600000, cwd });
      const m = run.ok && String(run.result || '').match(/\{[\s\S]*\}/);
      if (m) { try { return JSON.parse(m[0]); } catch { /* повтор */ } }
      console.warn(`[board] ${label}: попытка ${attempt} без JSON — ${run.error || String(run.result || '').slice(0, 120)}`);
    }
    return null;
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const j = i++; out[j] = await fn(items[j], j); } }));
  return out;
}

/* пуш в Джарвис (лента notif почтового секретаря, как у других агентов); тап открывает экран «Совет директоров» на этом месяце */
function notify(ym) {
  const names = JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/i18n/ru.json'), 'utf8')).month_names;
  const db = new (require('better-sqlite3'))(path.join(ROOT, 'data/mail.db'));
  try {
    db.prepare('INSERT OR REPLACE INTO notif(id,title,body,at) VALUES(?,?,?,?)').run(`board-${ym}`, `🏛 Совет директоров: ${names[String(+ym.slice(5))].toLowerCase()} готов`,
      'Цели года, графики, план директора и советы. PDF на русском и английском — в Джарвисе.', new Date().toISOString());
  } finally { db.close(); }
}

async function main() {
  const ym = process.argv.find((a) => /^\d{4}-\d{2}$/.test(a)) || dayjs().subtract(1, 'month').format('YYYY-MM');
  const reuse = process.argv.includes('--reuse');
  const dir = path.join(ROOT, 'docs/board', ym);
  fs.mkdirSync(dir, { recursive: true });
  const factsFile = path.join(dir, 'facts.json'), boardFile = path.join(dir, 'board.json');

  let f;
  if (reuse && fs.existsSync(factsFile)) f = JSON.parse(fs.readFileSync(factsFile, 'utf8'));
  else { f = await collect(ym); fs.writeFileSync(factsFile, JSON.stringify(f, null, 1)); }
  const pm = dayjs(ym + '-01').subtract(1, 'month');
  f.prevResponse = f.prevResponse || responseTimes(pm.format('YYYY-MM-DD'), pm.endOf('month').format('YYYY-MM-DD'));
  const k = kpis(f);

  let board = reuse && fs.existsSync(boardFile) ? JSON.parse(fs.readFileSync(boardFile, 'utf8')) : { roles: [] };
  const todo = ROLES.filter(([id]) => !board.roles.some((r) => r.role === id && r.advice));
  console.log(`[board] ${ym}: ролей к запуску ${todo.length}, параллельно ${PARALLEL}`);
  const done = await pool(todo, PARALLEL, async (role) => {
    const t0 = Date.now(); const r = await ask(rolePrompt(role, f, k), role[0]);
    console.log(`[board] ${role[0]} ${r ? 'ok' : 'FAIL'} ${Math.round((Date.now() - t0) / 1000)}s`);
    return r && { role: role[0], ...r };
  });
  board.roles = [...board.roles.filter((r) => r && r.advice), ...done.filter(Boolean)].sort((a, b) => ROLES.findIndex(([id]) => id === a.role) - ROLES.findIndex(([id]) => id === b.role));
  fs.writeFileSync(boardFile, JSON.stringify(board, null, 1));
  if (!board.director || !reuse) {
    const t0 = Date.now(); board.director = await ask(directorPrompt(f, k, board.roles), 'director');
    console.log(`[board] director ${board.director ? 'ok' : 'FAIL'} ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  board.kpis = k;
  fs.writeFileSync(boardFile, JSON.stringify(board, null, 1));

  const outs = [];
  for (const lang of ['ru', 'en']) {
    const h = html(f, k, board.roles, board.director, lang);
    fs.writeFileSync(path.join(dir, `board-${lang}.html`), h);
    const out = path.join(dir, `AcroGym-Board-${ym}-${lang.toUpperCase()}.pdf`);
    await renderPdf(h, out); outs.push(out);
  }
  console.log(outs.join('\n'));
  if (process.argv.includes('--push')) notify(ym);
  return outs;
}

module.exports = { main };

if (require.main === module) main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

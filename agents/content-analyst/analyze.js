'use strict';
// Content Analyst — превращает статистику постов Instagram в конкретные выводы
// для владельца и подсказки для content-bot. Источник данных ИНЖЕКТИРУЕТСЯ
// (Instagram Graph API в бою, образцы в тестах), поэтому здесь — чистая логика
// + один LLM-вызов. Токены/сеть сюда не заходят.

// Вовлечённость считаем сами = interactions / reach (устойчиво к причудам API).
function rate(p) {
  return p && p.reach > 0 ? p.interactions / p.reach : 0;
}

function isReel(p) {
  return /REEL|VIDEO/i.test(p.type || '');
}

function summarize(posts) {
  const n = posts.length;
  if (!n) return { n: 0 };
  const sum = (f) => posts.reduce((a, p) => a + (Number(f(p)) || 0), 0);
  const avgReach = Math.round(sum((p) => p.reach) / n);
  const avgRate  = sum(rate) / n;
  const avgSaved = sum((p) => p.saved) / n;

  const byType = {};
  for (const p of posts) {
    const t = isReel(p) ? 'Reels' : 'Посты/карусели';
    (byType[t] || (byType[t] = { n: 0, reach: 0, rate: 0 }));
    byType[t].n++;
    byType[t].reach += Number(p.reach) || 0;
    byType[t].rate  += rate(p);
  }
  for (const t of Object.keys(byType)) {
    byType[t].avgReach = Math.round(byType[t].reach / byType[t].n);
    byType[t].avgRate  = byType[t].rate / byType[t].n;
  }
  return { n, avgReach, avgRate, avgSaved, byType };
}

function rankPosts(posts) {
  return [...posts].sort((a, b) => rate(b) - rate(a));
}

async function insights(posts, { generate }) {
  const ranked = rankPosts(posts);
  const lines = ranked
    .map((p, i) =>
      `${i + 1}. [${isReel(p) ? 'Reel' : 'Пост'}] охват ${p.reach}, вовлечённость ${(rate(p) * 100).toFixed(1)}%, сохранений ${p.saved}\n` +
      `   «${String(p.caption || '').replace(/\s+/g, ' ').slice(0, 160)}»`)
    .join('\n');

  const system =
    'Ты — контент-аналитик детского акро-зала AcroGym (Доха, Катар). Читатель отчёта — владелец, не маркетолог. ' +
    'Пиши по-русски, коротко и по делу, без воды и лишних англицизмов. Опирайся на цифры, а не на общие фразы.';
  const user =
    `Посты Instagram за период, отсортированы по вовлечённости (interactions/reach):\n\n${lines}\n\n` +
    'Дай разбор строго в 3 блока (без вступлений):\n' +
    '1. ЧТО СРАБОТАЛО — 2-3 наблюдения по цифрам (форматы, темы, приёмы).\n' +
    '2. ЧТО ПОСТИТЬ БОЛЬШЕ — 3 конкретные идеи постов под детскую акробатику, повторяющие успех.\n' +
    '3. ЧАСТОТА/ФОРМАТ — одна строка совета.';

  // Запас под thinking + полный ответ из 3 блоков (иначе текст обрежется).
  const text = await generate({ system, user, maxTokens: 1500 });
  return String(text || '').trim();
}

/**
 * @param {Array} posts  [{date,type,reach,interactions,saved,likes,shares,caption,url}]
 * @param {object} [deps] { generate } — инжектируемый LLM (по умолчанию shared/claude)
 * @returns {Promise<{summary, ranked, advice}>}
 */
async function analyze(posts, deps = {}) {
  // Подписочный путь (шим content-bot/llm через `claude -p`, $0 API) — правило владельца.
  const generate = deps.generate || require('../content-bot/llm').generateText;
  const summary = summarize(posts);
  const advice = summary.n ? await insights(posts, { generate }) : '';
  return { summary, ranked: rankPosts(posts), advice };
}

module.exports = { analyze, summarize, rankPosts, rate, isReel };

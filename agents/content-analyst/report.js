'use strict';
// Форматирование результата аналитика в Telegram-отчёт (HTML) для владельца.

const { rate, isReel } = require('./analyze');

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function pct(x) { return (x * 100).toFixed(1) + '%'; }

function buildReport({ summary, ranked, advice }, { period = '', lang = 'ru' } = {}) {
  const en = lang === 'en';
  const T = en ? {
    title: 'Content Analyst', ig: 'Instagram', none: 'No posts in the period — nothing to analyze. I\'ll send a breakdown when new ones are out.',
    posts: 'Posts', reach: 'avg reach', eng: 'engagement', saves: 'avg saves', pcs: 'pcs',
    top: 'Top by engagement', post: 'Post', reachW: 'reach', engW: 'eng.', analysis: 'Analysis',
  } : {
    title: 'Аналитик контента', ig: 'Instagram', none: 'За период постов не было — разбирать нечего. Как выйдут новые, пришлю разбор.',
    posts: 'Постов', reach: 'средний охват', eng: 'вовлечённость', saves: 'сохранений в среднем', pcs: 'шт',
    top: 'Топ по вовлечённости', post: 'Пост', reachW: 'охват', engW: 'вовл.', analysis: 'Разбор',
  };
  if (!summary.n) return `📊 <b>${T.title}</b>\n\n${T.none}`;

  const L = [];
  L.push(`📊 <b>${T.title}</b> — ${T.ig}${period ? ', ' + esc(period) : ''}`);
  L.push('');
  L.push(
    `${T.posts}: <b>${summary.n}</b> · ${T.reach}: <b>${summary.avgReach}</b> · ` +
    `${T.eng}: <b>${pct(summary.avgRate)}</b> · ${T.saves}: <b>${summary.avgSaved.toFixed(1)}</b>`);

  const typeLabel = en ? { reels: 'Reels', posts: 'Posts/carousels' } : { reels: 'Reels', posts: 'Посты/карусели' };
  const types = Object.entries(summary.byType || {});
  if (types.length > 1) {
    L.push('');
    for (const [t, d] of types) {
      L.push(`• ${esc(typeLabel[t] || t)}: ${d.n} ${T.pcs} · ${T.reachW} ~${d.avgReach} · ${T.engW} ${pct(d.avgRate)}`);
    }
  }

  L.push('');
  L.push(`🏆 <b>${T.top}:</b>`);
  ranked.slice(0, 3).forEach((p, i) => {
    L.push(`${i + 1}. [${isReel(p) ? 'Reel' : T.post}] ${T.reachW} ${p.reach} · ${T.engW} ${pct(rate(p))} · 💾 ${p.saved}`);
  });

  if (advice) {
    L.push('');
    L.push(`💡 <b>${T.analysis}:</b>`);
    L.push(esc(advice));
  }
  return L.join('\n');
}

module.exports = { buildReport };

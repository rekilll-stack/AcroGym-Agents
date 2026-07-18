'use strict';
// Форматирование результата аналитика в Telegram-отчёт (HTML) для владельца.

const { rate, isReel } = require('./analyze');

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function pct(x) { return (x * 100).toFixed(1) + '%'; }

function buildReport({ summary, ranked, advice }, { period = 'за неделю' } = {}) {
  if (!summary.n) {
    return `📊 <b>Аналитик контента</b>\n\nЗа период постов не было — разбирать нечего. Как выйдут новые, пришлю разбор.`;
  }
  const L = [];
  L.push(`📊 <b>Аналитик контента</b> — Instagram, ${esc(period)}`);
  L.push('');
  L.push(
    `Постов: <b>${summary.n}</b> · средний охват: <b>${summary.avgReach}</b> · ` +
    `вовлечённость: <b>${pct(summary.avgRate)}</b> · сохранений в среднем: <b>${summary.avgSaved.toFixed(1)}</b>`);

  const types = Object.entries(summary.byType || {});
  if (types.length > 1) {
    L.push('');
    for (const [t, d] of types) {
      L.push(`• ${esc(t)}: ${d.n} шт · охват ~${d.avgReach} · вовл. ${pct(d.avgRate)}`);
    }
  }

  L.push('');
  L.push('🏆 <b>Топ по вовлечённости:</b>');
  ranked.slice(0, 3).forEach((p, i) => {
    L.push(`${i + 1}. [${isReel(p) ? 'Reel' : 'Пост'}] охват ${p.reach} · вовл. ${pct(rate(p))} · 💾 ${p.saved}`);
  });

  if (advice) {
    L.push('');
    L.push('💡 <b>Разбор:</b>');
    L.push(esc(advice));
  }
  return L.join('\n');
}

module.exports = { buildReport };

// Месячный отчёт owner-bot без отправки + проверка экранирования MarkdownV2: node scripts/check-monthly-report.js [ru|en] [ГГГГ-ММ]
process.chdir('/home/admin/acrogym'); require('/home/admin/acrogym/node_modules/dotenv').config({ path: '/home/admin/acrogym/.env' });
const { buildMonthlyReport } = require('/home/admin/acrogym/agents/owner-bot/builders/monthly-builder');
const lang = process.argv[2] || 'ru', month = process.argv[3];
(async () => {
  const t0 = Date.now(); const r = await buildMonthlyReport({ lang, month, dryRun: true });
  /* после снятия валидных экранов не должно остаться зарезервированных символов, кроме разметки * и _ */
  const bare = r.text.replace(/\\[_*\[\]()~`>#+\-=|{}.!\\]/g, '');
  const bad = bare.match(/[\[\]()~`>#+\-=|{}.!]/g);
  const stars = (bare.match(/\*/g) || []).length, unders = (bare.match(/_/g) || []).length;
  console.log(r.text.replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, '$1'));
  console.log('---', ((Date.now() - t0) / 1000).toFixed(1) + 's', 'bad:', bad ? bad.join('') : 'none', 'stars', stars, 'unders', unders, stars % 2 || unders % 2 ? 'UNBALANCED' : 'ok');
  process.exit(bad || stars % 2 || unders % 2 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

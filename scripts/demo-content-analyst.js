'use strict';
// Демо аналитика контента: реальный пост AcroGym (28.06, из Metricool) + 2 образца,
// чтобы показать, что агент выдаёт. Живой источник данных (IG Graph API) подключим отдельно.
require('dotenv').config();
const { analyze } = require('../agents/content-analyst/analyze');
const { buildReport } = require('../agents/content-analyst/report');

const posts = [
  { date: '2026-06-28', type: 'FEED_CAROUSEL_ALBUM', reach: 165, interactions: 32, saved: 0, likes: 32, shares: 0,
    caption: "Season's a wrap! What an incredible year at AcroGym Qatar. Watching our athletes grow stronger, braver and prouder every week. See you in September — enrolment opens soon!" },
  { date: '2026-07-02', type: 'REEL', reach: 540, interactions: 78, saved: 14, likes: 52, shares: 9,
    caption: 'Backflip progress — 6yo Layla nails her first unassisted backflip after 3 months 🤸' },
  { date: '2026-07-05', type: 'FEED_IMAGE', reach: 210, interactions: 21, saved: 3, likes: 18, shares: 1,
    caption: 'Meet Coach Sara — 10 years turning shy kids into confident acrobats' },
];

(async () => {
  const result = await analyze(posts);
  const report = buildReport(result, { period: 'демо: 1 реальный пост + 2 образца' });
  console.log('\n============== ЧТО ПРИШЛЁТ АНАЛИТИК ==============\n');
  console.log(report.replace(/<\/?b>/g, '').replace(/<[^>]+>/g, ''));
  console.log('\n=================================================\n');
})().catch((e) => { console.error('demo failed:', e.message); process.exit(1); });

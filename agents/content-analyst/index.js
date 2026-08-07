'use strict';
// Аналитик контента — раз в неделю тянет статистику Instagram (Meta Graph API,
// бесплатно, в обход Metricool), прогоняет через LLM-разбор и шлёт владельцу
// отчёт «что сработало / что постить больше / частота». Публикацию/постинг НЕ
// делает — только читает и советует.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const cron = require('node-cron');
const graph = require('./graph');
const { analyze } = require('./analyze');
const { buildReport } = require('./report');
const { sendToOwner } = require('../../shared/notify');
const { getPreferredLanguage } = require('../../shared/preferences');
const { createLogger } = require('../../shared/logger');
const { writeHeartbeat } = require('../../shared/heartbeat');

const logger = createLogger('content-analyst');
const TZ = process.env.TIMEZONE || 'Asia/Qatar';
const LIMIT = Math.max(3, parseInt(process.env.ANALYST_POST_LIMIT || '12', 10));

/** Собрать и отправить отчёт владельцу. Возвращает число проанализированных постов. */
async function runReport({ limit = LIMIT, period, lang } = {}) {
  if (!graph.isConfigured()) { logger.warn('META_GRAPH_TOKEN/IG_BUSINESS_ID не заданы — пропуск отчёта'); return 0; }
  // Язык отчёта = предпочтение владельца (первый из OWNER_CHAT_IDS), как у остальных ботов.
  if (!lang) {
    const firstOwner = String(process.env.OWNER_CHAT_IDS || '216299177').split(',')[0].trim();
    lang = getPreferredLanguage(Number(firstOwner)) === 'en' ? 'en' : 'ru';
  }
  if (!period) period = lang === 'en' ? 'this week' : 'за неделю';
  const posts = await graph.fetchPosts({ limit });
  const result = await analyze(posts, { lang });
  const text = buildReport(result, { period, lang });
  // Telegram-лимит 4096 — режем по абзацам на всякий случай.
  if (text.length <= 3900) {
    await sendToOwner(text, { parse_mode: 'HTML' });
  } else {
    let buf = '';
    for (const para of text.split('\n\n')) {
      if ((buf + '\n\n' + para).length > 3900) { await sendToOwner(buf, { parse_mode: 'HTML' }); buf = para; }
      else buf = buf ? buf + '\n\n' + para : para;
    }
    if (buf) await sendToOwner(buf, { parse_mode: 'HTML' });
  }
  logger.info({ posts: posts.length }, 'content-analyst report sent');
  writeHeartbeat('content-analyst', `report ${posts.length} posts`);
  return posts.length;
}

function start() {
  logger.info({ tz: TZ, configured: graph.isConfigured() }, 'Content-analyst starting');
  // Еженедельный отчёт: понедельник 09:30 (Asia/Qatar).
  cron.schedule('30 9 * * 1', () => {
    runReport({ period: 'за неделю' }).catch((e) => logger.error({ e: e.message }, 'weekly report failed'));
  }, { timezone: TZ });
  // Часовой heartbeat — для видимости/мониторинга (сам агент почти всё время спит).
  writeHeartbeat('content-analyst', 'started');
  setInterval(() => { try { writeHeartbeat('content-analyst', 'alive'); } catch (_) {} }, 60 * 60 * 1000);
  logger.info('Content-analyst running ✅ (еженедельно пн 09:30)');
}

process.on('uncaughtException', (err) => { logger.fatal({ err }, 'Uncaught exception'); process.exit(1); });
process.on('unhandledRejection', (reason) => { logger.error({ reason }, 'Unhandled rejection'); });

if (require.main === module) start();

module.exports = { runReport, start };

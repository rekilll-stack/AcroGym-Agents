'use strict';
// Lead poller — замена Make.com для приёма Meta Lead Ads (постоянный System User токен,
// см. project_content_analyst памяти). Опрашивает формы лидов страницы напрямую через
// Graph API и пересылает НОВЫЕ лиды в тот же n8n-вебхук, что раньше кормил Make (тот же
// путь дедупа/Sheets/уведомлений — не переизобретаем). external_id = реальный Facebook
// lead id → n8n считает lead_uid = sha256(external_id) детерминированно (см. диф 21.07),
// поэтому повторная отправка того же лида просто обновит ту же строку, не задвоит её.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { createLogger } = require('../../shared/logger');
const { writeHeartbeat } = require('../../shared/heartbeat');

const logger = createLogger('lead-poller');
const TZ = process.env.TIMEZONE || 'Asia/Qatar';
const V = process.env.META_GRAPH_API_VERSION || 'v21.0';
const STATE_PATH = path.join(__dirname, '../../data/lead-poller-state.json');

function isConfigured() {
  return !!(process.env.META_GRAPH_TOKEN && process.env.META_PAGE_ID && process.env.LEAD_WEBHOOK_URL && process.env.LEAD_WEBHOOK_TOKEN);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return { sinceUnix: 0 }; }
}
function saveState(s) {
  try { fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true }); fs.writeFileSync(STATE_PATH, JSON.stringify(s)); }
  catch (e) { logger.error({ e: e.message }, 'state save failed'); }
}

async function gget(path_) {
  const url = `https://graph.facebook.com/${V}/${path_}${path_.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(process.env.META_GRAPH_TOKEN)}`;
  const j = await (await fetch(url)).json();
  if (j.error) throw new Error(`graph ${path_.split('?')[0]}: ${j.error.message}`);
  return j;
}

async function pageToken() {
  const p = await gget(`${process.env.META_PAGE_ID}?fields=access_token`);
  return p.access_token;
}

/** Опросить формы лидов страницы, найти НОВЫЕ (created_time > since), переслать в n8n. */
async function poll() {
  if (!isConfigured()) { logger.warn('не сконфигурирован — пропуск'); return { sent: 0 }; }
  const state = loadState();
  const pt = await pageToken(); // формы и лиды требуют Page Token, не User/System token
  const forms = await (await fetch(`https://graph.facebook.com/${V}/${process.env.META_PAGE_ID}/leadgen_forms?fields=id,status&access_token=${encodeURIComponent(pt)}`)).json();
  if (forms.error) throw new Error(`leadgen_forms: ${forms.error.message}`);
  let sent = 0, maxSeen = state.sinceUnix;

  for (const form of (forms.data || [])) {
    if (form.status !== 'ACTIVE') continue;
    const since = state.sinceUnix ? `&since=${state.sinceUnix}` : '';
    const url = `${form.id}/leads?fields=id,created_time,field_data&limit=50${since}`;
    let leads;
    try { leads = await (await fetch(`https://graph.facebook.com/${V}/${url}&access_token=${encodeURIComponent(pt)}`)).json(); }
    catch (e) { logger.error({ e: e.message, form: form.id }, 'fetch leads failed'); continue; }
    if (leads.error) { logger.error({ form: form.id, err: leads.error.message }, 'leads error'); continue; }

    for (const lead of (leads.data || [])) {
      const created = Math.floor(new Date(lead.created_time).getTime() / 1000);
      if (created > maxSeen) maxSeen = created;
      try {
        const res = await fetch(process.env.LEAD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-webhook-token': process.env.LEAD_WEBHOOK_TOKEN },
          body: JSON.stringify({ external_id: lead.id, field_data: lead.field_data, source: 'meta_direct' }),
        });
        if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
        sent++;
        logger.info({ leadId: lead.id }, 'lead forwarded to n8n');
      } catch (e) {
        logger.error({ e: e.message, leadId: lead.id }, 'forward failed — оставляем since как есть, попробуем снова');
        // ponytail: watermark общий на все формы странице — при сбое в форме A ПОСЛЕ уже
        // успешной формы B общий maxSeen может уйти вперёд и лид формы A не переопросится.
        // Сейчас на странице ОДНА активная форма (leads_count=0) — риска нет. Если появится
        // вторая активная форма, поднять watermark до per-form структуры в state.
        maxSeen = state.sinceUnix;
        break;
      }
    }
  }
  saveState({ sinceUnix: maxSeen });
  writeHeartbeat('lead-poller', `polled, sent ${sent}`);
  return { sent };
}

function start() {
  logger.info({ tz: TZ, configured: isConfigured() }, 'Lead-poller starting');
  const minutes = Math.max(5, parseInt(process.env.LEAD_POLL_MINUTES || '15', 10));
  cron.schedule(`*/${minutes} * * * *`, () => {
    poll().catch((e) => logger.error({ e: e.message }, 'poll failed'));
  }, { timezone: TZ });
  writeHeartbeat('lead-poller', 'started');
  logger.info({ minutes }, 'Lead-poller running ✅');
}

process.on('uncaughtException', (err) => { logger.fatal({ err }, 'Uncaught exception'); process.exit(1); });
process.on('unhandledRejection', (reason) => { logger.error({ reason }, 'Unhandled rejection'); });

if (require.main === module) start();

module.exports = { poll, start, isConfigured };

'use strict';

/**
 * R5a — watchdog cron-agent evaluation test (temp DB only).
 *
 * Proves the pm2:false branch in evaluate() and the alert-state dedup, without
 * starting the real watchdog (index.js exports evaluate/WATCHED behind a
 * require.main guard, so importing it does NOT tick / send Telegram alerts).
 *
 *   rm -f /tmp/wd-cron.db*
 *   cp data/acrogym.db /tmp/wd-cron.db
 *   ACROGYM_DB_PATH=/tmp/wd-cron.db node scripts/test-watchdog-cron.js
 */

if (!process.env.ACROGYM_DB_PATH || process.env.ACROGYM_DB_PATH.includes('data/acrogym.db')) {
  console.error('REFUSING: set ACROGYM_DB_PATH to a temp copy first.'); process.exit(1);
}
{
  const fs = require('fs');
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(process.env.ACROGYM_DB_PATH + ext)) {
    console.error(`REFUSING: stale ${process.env.ACROGYM_DB_PATH + ext} — delete .db,-wal,-shm together.`); process.exit(1);
  }
}

const { getDb } = require('../shared/db');
const { getAlertState, setAlertState } = require('../shared/heartbeat');
const { evaluate, WATCHED } = require('../agents/watchdog/index');

getDb(); // open temp + migrate

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { console.log('  ✅ ' + n); pass++; } else { console.log('  ❌ ' + n); fail++; } };

const NOW  = Date.now();
const cron = WATCHED.find(a => a.pm2 === false);
const MIN  = 60 * 1000;

console.log('=== cron agent under watch ===');
t('registrations-poller is a pm2:false cron agent in WATCHED',
  cron && cron.name === 'registrations-poller' && cron.kind === 'cron' && cron.thresholdMs === 70 * MIN);

console.log('\n=== stale heartbeat (older than threshold) → alert, reason=stale ===');
const staleHb = { last_ok_at: NOW - 80 * MIN, detail: 'ok, 8 rows, 0 new' }; // 80 > 70
const rStale  = evaluate(cron, staleHb, null, NOW);
console.log('  →', JSON.stringify({ problem: rStale.problem, reason: rStale.reason }));
t('80-min-old heartbeat → problem', rStale.problem === true);
t("reason === 'stale' (NOT 'hung' → no auto-restart)", rStale.reason === 'stale');
t('ran-then-silent → detail says "молчит N мин" with a real time', /молчит/.test(rStale.detailHtml));
t('ran-then-silent → no "Infinity", no dangling "с —"', !/Infinity/.test(rStale.detailHtml) && !/с —/.test(rStale.detailHtml));

console.log('\n=== no heartbeat at all (null → Infinity) → alert, reason=stale ===');
const rNone = evaluate(cron, null, null, NOW);
console.log('  →', JSON.stringify({ problem: rNone.problem, reason: rNone.reason }));
console.log('  detail:', rNone.detailHtml.split('\n')[0]);
t('missing heartbeat → problem', rNone.problem === true);
t("missing heartbeat → reason 'stale'", rNone.reason === 'stale');
t('never-ran → detail says "ни разу не отрабатывал" (readable)', /ни разу не отрабатывал/.test(rNone.detailHtml));
t('never-ran → NO "Infinity мин", NO dangling "с —"', !/Infinity/.test(rNone.detailHtml) && !/с —/.test(rNone.detailHtml));

console.log('\n=== fresh heartbeat (within threshold) → ok ===');
const freshHb = { last_ok_at: NOW - 10 * MIN, detail: 'ok, 8 rows, 0 new' }; // 10 < 70
const rFresh  = evaluate(cron, freshHb, null, NOW);
console.log('  →', JSON.stringify({ problem: rFresh.problem, reason: rFresh.reason }));
t('10-min-old heartbeat → no problem', rFresh.problem === false);
t("fresh → reason 'ok'", rFresh.reason === 'ok');

console.log('\n=== pm2 branches do NOT fire for a cron agent ===');
// Even if a (bogus) pm2 proc says offline, the cron branch returns first → the
// 'down'/'hung' paths are never reached, so reason is never down/hung.
const proc = { status: 'stopped', pmUptime: null, restarts: 0 };
const rWithProc = evaluate(cron, staleHb, proc, NOW);
t('stale cron + offline proc → still stale, never down/hung',
  rWithProc.reason === 'stale' && rWithProc.reason !== 'down' && rWithProc.reason !== 'hung');
const rFreshProc = evaluate(cron, freshHb, proc, NOW);
t('fresh cron + offline proc → ok, pm2 status ignored', rFreshProc.reason === 'ok');

console.log('\n=== dedup: repeated stale → one alert (alert-state transition) ===');
// Replicates tick()'s gate: alert only on ok→problem; silent while alerting.
const fire = (agent, res) => {
  const prev = (getAlertState(agent.name) || {}).alert_state || 'ok';
  if (res.problem && prev === 'ok')        { setAlertState(agent.name, 'alerting', NOW); return 'ALERT'; }
  if (!res.problem && prev === 'alerting') { setAlertState(agent.name, 'ok', NOW);       return 'RECOVER'; }
  return 'silent';
};
const a1 = fire(cron, rStale); // first stale
const a2 = fire(cron, rStale); // second stale (still alerting)
const a3 = fire(cron, rFresh); // recovers
console.log('  transitions:', a1, '→', a2, '→', a3);
t('first stale → ALERT', a1 === 'ALERT');
t('second stale → silent (deduped, one alert)', a2 === 'silent');
t('then fresh → RECOVER (single recovery)', a3 === 'RECOVER');

console.log('\n=== regression: pm2 agents (lead-helper / owner-bot) unchanged ===');
const lh = WATCHED.find(a => a.name === 'lead-helper');
const ob = WATCHED.find(a => a.name === 'owner-bot');
// online + stale heartbeat (past warmup) → hung, as before the cron branch.
const onlineOld = { status: 'online', pmUptime: NOW - 60 * MIN, restarts: 0 };
const lhStaleHb = { last_ok_at: NOW - 10 * MIN, detail: 'x' }; // 10 > 5-min threshold
t('lead-helper online+stale → still hung (auto-restart path intact)',
  evaluate(lh, lhStaleHb, onlineOld, NOW).reason === 'hung');
t('owner-bot stopped proc → still down',
  evaluate(ob, { last_ok_at: NOW - 10 * MIN }, { status: 'stopped', pmUptime: null }, NOW).reason === 'down');
t('lead-helper fresh heartbeat → ok',
  evaluate(lh, { last_ok_at: NOW - 1 * MIN }, onlineOld, NOW).reason === 'ok');

console.log(`\n═══ Results: ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);

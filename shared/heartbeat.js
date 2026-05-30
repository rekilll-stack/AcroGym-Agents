'use strict';

/**
 * shared/heartbeat.js
 * Liveness heartbeats for the watchdog.
 *
 * Agents call writeHeartbeat() only after a REAL successful cycle
 * (lead-helper: after a successful Sheets fetch; owner-bot: after a
 * successful getMe probe). The watchdog reads freshness and compares
 * against per-agent thresholds. Anti-spam alert state lives in the DB
 * (watchdog_state) so a watchdog restart never re-spams.
 */

const { getDb } = require('./db');

/**
 * Record a successful cycle for an agent.
 * @param {string} agentName
 * @param {string} [detail] — short human context (row count, probe info, …)
 */
function writeHeartbeat(agentName, detail = '') {
  getDb()
    .prepare(`
      INSERT INTO heartbeats (agent_name, last_ok_at, detail)
      VALUES (?, ?, ?)
      ON CONFLICT(agent_name) DO UPDATE SET
        last_ok_at = excluded.last_ok_at,
        detail     = excluded.detail
    `)
    .run(agentName, Date.now(), String(detail));
}

/** @returns {{agent_name, last_ok_at, detail}|null} */
function readHeartbeat(agentName) {
  return getDb()
    .prepare(`SELECT agent_name, last_ok_at, detail FROM heartbeats WHERE agent_name = ?`)
    .get(agentName) || null;
}

/** @returns {Array<{agent_name, last_ok_at, detail}>} */
function readAllHeartbeats() {
  return getDb()
    .prepare(`SELECT agent_name, last_ok_at, detail FROM heartbeats`)
    .all();
}

/** @returns {{agent_name, alert_state, alerted_at}|null} */
function getAlertState(agentName) {
  return getDb()
    .prepare(`SELECT agent_name, alert_state, alerted_at FROM watchdog_state WHERE agent_name = ?`)
    .get(agentName) || null;
}

/**
 * @param {string} agentName
 * @param {'ok'|'alerting'} state
 * @param {number} [ts] — epoch ms; defaults to now
 */
function setAlertState(agentName, state, ts = Date.now()) {
  getDb()
    .prepare(`
      INSERT INTO watchdog_state (agent_name, alert_state, alerted_at)
      VALUES (?, ?, ?)
      ON CONFLICT(agent_name) DO UPDATE SET
        alert_state = excluded.alert_state,
        alerted_at  = excluded.alerted_at
    `)
    .run(agentName, state, ts);
}

module.exports = {
  writeHeartbeat,
  readHeartbeat,
  readAllHeartbeats,
  getAlertState,
  setAlertState,
};

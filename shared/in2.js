'use strict';

/**
 * shared/in2.js — клиент Public API in2 (app.joinin2.com) + агрегаторы для отчётов.
 *
 * Подключено 07.08.2026. Грабли и факты:
 *  - API за Cloudflare: без "живого" User-Agent отвечает `error code: 1010` (text/plain).
 *  - Auth: POST /token {apiKey: IN2_API_KEY} → JWT на 1ч (кэшируем, обновляем по 401).
 *  - Rate limit 300 req/min (Pro) — агрегатор капит выборку occurrence'ов.
 *  - Тенант: branch 2265 «AcroGym Lagoona». Данτων пока мало — ВСЕ функции обязаны
 *    тихо переживать пустые ответы (отчёты сами прячут пустые блоки).
 * Спека: docs/in2-public-api.openapi.json.
 */

const { createLogger } = require('./logger');
const logger = require('./logger').createLogger ? createLogger('in2') : console;

const API = 'https://app.joinin2.com/api/v1';
const UA = 'AcroGym-Integration/1.0 (+https://acrogym.org)';
const OCCURRENCE_FETCH_CAP = 200; // защита rate-limit'а на месячной агрегации

let _tok = { access: null, exp: 0 };

async function _rawFetch(path, { method = 'GET', body, token } = {}) {
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    const err = new Error(`in2 ${method} ${path}: HTTP ${res.status} ${detail}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function _accessToken(force = false) {
  if (!force && _tok.access && Date.now() < _tok.exp - 60000) return _tok.access;
  const key = process.env.IN2_API_KEY;
  if (!key) throw new Error('IN2_API_KEY is not set in .env');
  const tok = await _rawFetch('/token', { method: 'POST', body: { apiKey: key } });
  _tok = { access: tok.accessToken, exp: Date.now() + (tok.expiresIn || 3600) * 1000 };
  return _tok.access;
}

async function call(path, opts = {}) {
  try {
    return await _rawFetch(path, { ...opts, token: await _accessToken() });
  } catch (e) {
    if (e.status === 401) { // токен протух раньше срока — один повтор со свежим
      return _rawFetch(path, { ...opts, token: await _accessToken(true) });
    }
    throw e;
  }
}

// ── Низкоуровневые обёртки ───────────────────────────────────
const fmt = (d) => d instanceof Date ? d.toISOString().slice(0, 10) : String(d);

async function salesTotals(fromDate, toDate) {
  const r = await call('/reports/sales', { method: 'POST', body: { fromDate: fmt(fromDate), toDate: fmt(toDate) } });
  if (!r) return null;
  const total = ['totalPackagesAmount', 'totalProductsAmount', 'totalReservationsAmount', 'totalOthersAmount']
    .reduce((s, k) => s + (Number(r[k]) || 0), 0);
  return {
    total,
    packages: Number(r.totalPackagesAmount) || 0,
    products: Number(r.totalProductsAmount) || 0,
    reservations: Number(r.totalReservationsAmount) || 0,
    others: Number(r.totalOthersAmount) || 0,
    transactions: Array.isArray(r.transactions) ? r.transactions.length : 0,
  };
}

async function eventsRange(startDate, endDate) {
  const q = new URLSearchParams({ selectedDate: fmt(startDate), endDate: fmt(endDate), showCancelled: 'false' });
  const r = await call(`/classes/events?${q}`);
  return Array.isArray(r) ? r : [];
}

async function occurrence(id) {
  return call(`/classes/occurrences/${id}`);
}

async function trainers() {
  const r = await call('/trainers');
  return Array.isArray(r) ? r : [];
}

// ── Извлечение посетителей из occurrence (схема может отличаться — ищем массив
//    объектов с признаками клиента; поле "пришёл" берём по первому найденному флагу) ──
function extractAttendees(occ) {
  if (!occ || typeof occ !== 'object') return [];
  const arrays = Object.values(occ).filter((v) => Array.isArray(v) && v.length && typeof v[0] === 'object');
  for (const arr of arrays) {
    if (arr[0] && ('idClient' in arr[0] || 'clientName' in arr[0] || 'clientId' in arr[0])) return arr;
  }
  return [];
}

function attendedFlag(a) {
  for (const k of ['attended', 'isAttended', 'checkedIn', 'isCheckedIn', 'present']) {
    if (k in a) return !!a[k];
  }
  return true; // флага нет — считаем записанного посетившим (уточним на реальных данных)
}

// Формула ЗП тренера (владелец + in2, июнь 2026): 100 QAR за занятие при 1-5 детях,
// +10 за каждого сверх 5.
const classPay = (attendees) => 100 + Math.max(0, attendees - 5) * 10;

// ── Главный агрегатор: операционная сводка за период ─────────
async function opsSummary(fromDate, toDate) {
  const out = {
    from: fmt(fromDate), to: fmt(toDate),
    revenue: null, classes: 0, visits: 0, uniqueClients: 0,
    trainers: [], truncated: false,
  };
  try { out.revenue = await salesTotals(fromDate, toDate); }
  catch (e) { logger.warn ? logger.warn({ err: e.message }, 'in2 salesTotals failed') : 0; }

  let events = [];
  try { events = await eventsRange(fromDate, toDate); }
  catch (e) { logger.warn ? logger.warn({ err: e.message }, 'in2 eventsRange failed') : 0; return out; }
  // только прошедшие к моменту отчёта занятия
  const today = new Date().toISOString().slice(0, 10);
  events = events.filter((ev) => (ev.startDate || ev.startDateTime || '').slice(0, 10) <= today);
  if (events.length > OCCURRENCE_FETCH_CAP) { out.truncated = true; events = events.slice(0, OCCURRENCE_FETCH_CAP); }

  const byTrainer = new Map();
  const allClients = new Set();
  for (const ev of events) {
    let att = [];
    try { att = extractAttendees(await occurrence(ev.id)); }
    catch { /* одна битая запись не валит сводку */ }
    const visited = att.filter(attendedFlag);
    const name = (ev.trainerName || 'Unassigned').trim() || 'Unassigned';
    const t = byTrainer.get(name) || { name, classes: 0, visits: 0, clients: new Set(), pay: 0 };
    t.classes += 1;
    t.visits += visited.length;
    t.pay += classPay(visited.length);
    for (const a of visited) {
      const cid = a.idClient ?? a.clientId ?? a.clientName;
      if (cid != null) { t.clients.add(cid); allClients.add(cid); }
    }
    byTrainer.set(name, t);
    out.classes += 1;
    out.visits += visited.length;
  }
  out.uniqueClients = allClients.size;
  out.trainers = [...byTrainer.values()]
    .map((t) => ({ name: t.name, classes: t.classes, visits: t.visits, uniqueClients: t.clients.size, estPay: t.pay }))
    .sort((a, b) => b.visits - a.visits); // рейтинг по посещениям
  return out;
}

module.exports = { call, salesTotals, eventsRange, occurrence, trainers, opsSummary, classPay };

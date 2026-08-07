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
  // 'attendance' — родное поле in2 (AttendanceResponse); остальные — на случай других бинов
  for (const k of ['attendance', 'attended', 'isAttended', 'checkedIn', 'isCheckedIn', 'present']) {
    if (k in a && a[k] != null) return !!a[k];
  }
  return true; // флага нет — считаем записанного посетившим (админы могут не отмечать)
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
  let capacitySum = 0, booked = 0, fullClasses = 0;
  for (const ev of events) {
    let occ = null, att = [];
    try { occ = await occurrence(ev.id); att = extractAttendees(occ); }
    catch { /* одна битая запись не валит сводку */ }
    if (occ && occ.isCancelled) continue;
    const visited = att.filter(attendedFlag);
    const cap = Number(occ && occ.maximumCapacity) || 0;
    if (cap > 0) { capacitySum += cap; if (att.length >= cap) fullClasses += 1; }
    booked += att.length;
    const name = (ev.trainerName || (occ && occ.trainer) || 'Unassigned');
    const key = (typeof name === 'string' ? name : (name && name.name) || 'Unassigned').trim() || 'Unassigned';
    const t = byTrainer.get(key) || { name: key, classes: 0, visits: 0, booked: 0, clients: new Set(), pay: 0, revenue: 0 };
    t.classes += 1;
    t.visits += visited.length;
    t.booked += att.length;
    t.pay += classPay(visited.length);
    for (const a of visited) {
      const cid = a.idClient ?? a.clientId ?? a.clientName;
      if (cid != null) { t.clients.add(cid); allClients.add(cid); }
      if (a.price != null) t.revenue += Number(a.price) || 0; // цена посещения, если бин её отдаёт
    }
    byTrainer.set(key, t);
    out.classes += 1;
    out.visits += visited.length;
  }
  out.uniqueClients = allClients.size;
  out.booked = booked;
  out.noShowRate = booked > 0 ? Math.round((1 - out.visits / booked) * 100) : null;
  out.utilization = capacitySum > 0 ? Math.round(booked / capacitySum * 100) : null;
  out.fullClasses = fullClasses;
  out.trainers = [...byTrainer.values()]
    .map((t) => ({ name: t.name, classes: t.classes, visits: t.visits, booked: t.booked,
                   uniqueClients: t.clients.size, estPay: t.pay,
                   revenue: t.revenue > 0 ? Math.round(t.revenue) : null }))
    .sort((a, b) => b.visits - a.visits); // рейтинг по посещениям
  return out;
}

// ── Клиенты: рост базы + дебиторка (customers/list без фильтра = все; cap разумный) ──
async function customersSummary(monthStartStr) {
  const list = await call('/customers/list', { method: 'POST', body: {} });
  if (!Array.isArray(list)) return null;
  const debtors = list.filter((c) => Number(c.balance) < 0);
  return {
    total: list.length,
    newThisMonth: monthStartStr ? list.filter((c) => (c.memberSince || '').slice(0, 10) >= monthStartStr).length : null,
    children: list.filter((c) => c.isChild).length,
    debtors: debtors.length,
    debtTotal: Math.round(Math.abs(debtors.reduce((s, c) => s + Number(c.balance || 0), 0))),
  };
}

// ── Абонементы: активные / новые / истекающие / замороженные (N+1 c капом) ──
const MEMBERSHIP_FETCH_CAP = 300;
async function membershipsSummary(monthStartStr, expiringDays = 14) {
  const list = await call('/customers/list', { method: 'POST', body: {} });
  if (!Array.isArray(list)) return null;
  const today = new Date();
  const horizon = new Date(today.getTime() + expiringDays * 86400000).toISOString().slice(0, 10);
  const todayStr = today.toISOString().slice(0, 10);
  const out = { active: 0, newThisMonth: 0, frozen: 0, expiringSoon: [], truncated: list.length > MEMBERSHIP_FETCH_CAP };
  for (const c of list.slice(0, MEMBERSHIP_FETCH_CAP)) {
    let ms = [];
    try { ms = await call(`/customers/${c.id}/customer-memberships`); } catch { continue; }
    if (!Array.isArray(ms)) continue;
    for (const m of ms) {
      const status = String(m.status || '').toUpperCase();
      if (m.isExpired || status.includes('EXPIR') || status.includes('CANCEL')) continue;
      out.active += 1;
      if (status.includes('FROZEN') || status.includes('FREEZE')) out.frozen += 1;
      if (monthStartStr && (m.purchaseDate || '').slice(0, 10) >= monthStartStr) out.newThisMonth += 1;
      const exp = (m.expiryDate || '').slice(0, 10);
      if (exp && exp >= todayStr && exp <= horizon) {
        out.expiringSoon.push({ client: c.name, membership: m.membershipName, expiry: exp });
      }
    }
  }
  out.expiringSoon.sort((a, b) => a.expiry.localeCompare(b.expiry));
  return out;
}

// ── Сегодняшние занятия (для дневного дайджеста, 1 вызов) ──
async function todayClasses() {
  const today = new Date().toISOString().slice(0, 10);
  const ev = await eventsRange(today, today);
  return { classes: ev.length };
}

module.exports = { call, salesTotals, eventsRange, occurrence, trainers, opsSummary, classPay,
  customersSummary, membershipsSummary, todayClasses };

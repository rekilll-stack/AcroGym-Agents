'use strict';

// Рабочие часы зала (владелец 10.08: отсчёт SLA по лидам — с 9 утра, ночь не
// считается). Катар — UTC+3 без переходов. Используется lead-helper
// (напоминания) и owner-bot (часы «висящих» в дайджесте) — считать одинаково.

const QATAR_OFFSET_MS = 3 * 3600e3;
const WORK_START_H = 9, WORK_END_H = 21;

function qatarHour(ts = Date.now()) {
  return new Date(ts + QATAR_OFFSET_MS).getUTCHours();
}

/** Ночная нотификация (21:00–09:00) считается сделанной в ближайшие 9:00 утра. */
function effectiveNotifiedMs(notifiedAt) {
  const real = new Date(notifiedAt).getTime();
  const loc = new Date(real + QATAR_OFFSET_MS);
  const h = loc.getUTCHours();
  if (h >= WORK_END_H) { loc.setUTCDate(loc.getUTCDate() + 1); loc.setUTCHours(WORK_START_H, 0, 0, 0); }
  else if (h < WORK_START_H) { loc.setUTCHours(WORK_START_H, 0, 0, 0); }
  else return real;
  return loc.getTime() - QATAR_OFFSET_MS;
}

/** Часы ожидания ответа с учётом рабочего дня (не бывает отрицательных). */
function hoursWaiting(notifiedAt, now = Date.now()) {
  return Math.max(0, Math.floor((now - effectiveNotifiedMs(notifiedAt)) / 3600000));
}

module.exports = { QATAR_OFFSET_MS, WORK_START_H, WORK_END_H, qatarHour, effectiveNotifiedMs, hoursWaiting };

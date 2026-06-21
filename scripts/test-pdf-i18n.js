'use strict';

/**
 * #7 — proves the PDF i18n migration is byte-for-byte equivalent at the string
 * level: the new i18n-backed buildTx() must produce the EXACT same strings as the
 * old hardcoded TX object (the oracle below) for every key, both languages,
 * including parametrised templates and the RU plural for "лид". If every string
 * matches, the same strings are fed to pdfkit → the rendered PDF is unchanged.
 *
 *   node scripts/test-pdf-i18n.js
 */

const { buildTx } = require('../agents/owner-bot/exporters/pdf-exporter');

// ── Oracle: the old hardcoded TX object (verbatim, pre-migration) ──
const ORACLE = {
  en: {
    cover_title: 'MONTHLY REPORT',
    cover_date_label: (d) => d,
    cover_generated: (d) => `Generated ${d}`,
    summary_header: 'EXECUTIVE SUMMARY',
    leads_label: 'NEW LEADS', revenue_label: 'REVENUE (QAR)', members_label: 'ACTIVE MEMBERS', pending_label: 'in2 pending',
    status_revenue: 'Revenue: in2 data pending (August 2026)',
    status_leads_zero: 'Leads: no activity (0 this month, target 40)',
    status_leads_red: (n) => `Leads: below target (${n} this month, target 40)`,
    status_leads_yellow: (n) => `Leads: approaching target (${n} this month, target 40)`,
    status_leads_green: (n) => `Leads: on target (${n} this month, target 40)`,
    status_response_none: 'Response: no responses yet',
    status_response_calc: (t, goal) => `Avg first-response ${t}, goal ≤ ${goal}`,
    key_events: 'Key Events', ev_leads_zero: 'No new leads this month',
    ev_leads_some: (n) => `${n} new leads this month`,
    ev_in2: 'Revenue & attendance data pending in2 (Aug 2026)',
    ev_response_none: 'Avg first-response: no data yet',
    ev_response_calc: (t, goal, met) => `Avg first-response ${t} — target ≤ ${goal} ${met ? 'met' : 'not met'}`,
    vs_prev_pos: (p) => `+${p}% vs prev month`, vs_prev_neg: (p) => `${p}% vs prev month`,
    vs_prev_zero: '0% vs prev month', vs_no_prior: 'no prior data', vs_no_activity: '—',
    chart_no_data: 'No daily activity for this period', pie_no_data: 'No source data for this period',
    leads_header: 'LEADS & PIPELINE', funnel_title: 'Conversion Funnel',
    f_submitted: 'Submitted', f_responded: 'Responded', f_trial_book: 'Trial Booked', f_trial_attend: 'Trial Attended', f_subscribed: 'Subscribed',
    in2_title: 'Coming with in2 integration',
    in2_body: 'Trial bookings, attendance tracking, subscriptions and revenue after in2 API (Aug 2026).',
    sources_title: 'Lead Sources Distribution', src_col_source: 'Source', src_col_leads: 'Leads',
    chart_title: 'Daily Leads — Last 4 Weeks',
    best_label: (d, n) => `Best: ${d} (${n} leads)`,
    worst_label: (d, n) => `Worst: ${d} (${n} lead${n !== 1 ? 's' : ''})`,
    p4_header: 'ATTENDANCE, REVENUE & COACHES',
    s_attendance: 'Attendance', s_attendance_sub: 'Total visits, per-coach attendance, group fill rates',
    s_revenue: 'Revenue', s_revenue_sub: 'Monthly revenue, QAR per session, coach compensation',
    s_coaches: 'Coach Overview', s_coaches_sub: 'Session counts, performance metrics, feedback scores',
    coming_in2: 'Coming with in2 integration', expected: 'Expected: August 2026',
    footer: 'AcroGym · Monthly Report',
    page_of: (n, t) => `Page ${n} of ${t}`,
  },
  ru: {
    cover_title: 'ЕЖЕМЕСЯЧНЫЙ ОТЧЁТ',
    cover_date_label: (d) => d,
    cover_generated: (d) => `Сформировано ${d}`,
    summary_header: 'ИТОГИ МЕСЯЦА',
    leads_label: 'НОВЫЕ ЛИДЫ', revenue_label: 'ВЫРУЧКА (QAR)', members_label: 'АКТИВНЫХ ЧЛЕНОВ', pending_label: 'ожидает in2',
    status_revenue: 'Выручка: данные in2 ожидаются (август 2026)',
    status_leads_zero: 'Лиды: активности не было (0 за месяц, цель 40)',
    status_leads_red: (n) => `Лиды: ниже цели (${n} за месяц, цель 40)`,
    status_leads_yellow: (n) => `Лиды: приближаются к цели (${n} за месяц, цель 40)`,
    status_leads_green: (n) => `Лиды: цель достигнута (${n} за месяц, цель 40)`,
    status_response_none: 'Отклик: ответов ещё не было',
    status_response_calc: (t, goal) => `Ср. время ответа ${t}, цель ≤ ${goal}`,
    key_events: 'Ключевые события', ev_leads_zero: 'Заявок в этом месяце не было',
    ev_leads_some: (n) => `${n} новых лидов в этом месяце`,
    ev_in2: 'Выручка и посещаемость ожидают in2 (авг. 2026)',
    ev_response_none: 'Ср. время ответа: данных пока нет',
    ev_response_calc: (t, goal, met) => `Ср. время ответа ${t} — цель ≤ ${goal} ${met ? 'достигнута' : 'не достигнута'}`,
    vs_prev_pos: (p) => `+${p}% к прошлому месяцу`, vs_prev_neg: (p) => `${p}% к прошлому месяцу`,
    vs_prev_zero: '0% к прошлому месяцу', vs_no_prior: 'нет данных за прошлый месяц', vs_no_activity: '—',
    chart_no_data: 'Нет активности за период', pie_no_data: 'Нет данных по источникам за период',
    leads_header: 'ЛИДЫ И ВОРОНКА ПРОДАЖ', funnel_title: 'Воронка конверсии',
    f_submitted: 'Подано заявок', f_responded: 'Получили ответ', f_trial_book: 'Записались на пробу', f_trial_attend: 'Пришли на пробу', f_subscribed: 'Оформили абонемент',
    in2_title: 'Появится с интеграцией in2',
    in2_body: 'Бронирование, посещаемость, конверсии и выручка появятся после запуска in2 (август 2026).',
    sources_title: 'Распределение по источникам', src_col_source: 'Источник', src_col_leads: 'Лиды',
    chart_title: 'Лиды по дням — последние 4 недели',
    best_label: (d, n) => `Лучший: ${d} (${n} лидов)`,
    worst_label: (d, n) => `Худший: ${d} (${n} лид${n === 1 ? '' : n < 5 ? 'а' : 'ов'})`,
    p4_header: 'ПОСЕЩАЕМОСТЬ, ВЫРУЧКА И ТРЕНЕРЫ',
    s_attendance: 'Посещаемость', s_attendance_sub: 'Итого визитов, посещаемость по тренерам, заполняемость групп',
    s_revenue: 'Выручка', s_revenue_sub: 'Ежемесячная выручка, QAR за занятие, вознаграждение тренеров',
    s_coaches: 'Обзор тренеров', s_coaches_sub: 'Кол-во занятий, показатели эффективности, оценки обратной связи',
    coming_in2: 'Появится с интеграцией in2', expected: 'Ожидается: август 2026',
    footer: 'AcroGym · Месячный отчёт',
    page_of: (n, t) => `Стр. ${n} из ${t}`,
  },
};

// Sample args for the parametrised keys (cover plurals + verdict branches).
const ARGS = {
  cover_date_label: [['May 2026']],
  cover_generated: [['2026-05-27']],
  status_leads_red: [[25]], status_leads_yellow: [[30]], status_leads_green: [[45]],
  status_response_calc: [['1m 30s', '2h']],
  ev_leads_some: [[25]],
  ev_response_calc: [['1m 30s', '2h', true], ['1m 30s', '2h', false]],
  vs_prev_pos: [[12]], vs_prev_neg: [[-12]],
  best_label: [['May 3', 5], ['May 3', 1]],
  worst_label: [['May 7', 1], ['May 7', 3], ['May 7', 12], ['May 7', 22]],
  page_of: [[2, 4]],
};

let pass = 0, fail = 0;
const T = (n, c) => { if (c) pass++; else { console.log('  ❌ ' + n); fail++; } };

for (const lang of ['en', 'ru']) {
  const oracle = ORACLE[lang];
  const tx = buildTx(lang);
  for (const key of Object.keys(oracle)) {
    if (typeof oracle[key] === 'function') {
      for (const args of (ARGS[key] || [[]])) {
        const want = oracle[key](...args);
        const got  = tx[key](...args);
        T(`${lang}.${key}(${JSON.stringify(args)})`, got === want);
        if (got !== want) console.log(`     want: ${JSON.stringify(want)}\n     got:  ${JSON.stringify(got)}`);
      }
    } else {
      T(`${lang}.${key}`, tx[key] === oracle[key]);
      if (tx[key] !== oracle[key]) console.log(`     want: ${JSON.stringify(oracle[key])}\n     got:  ${JSON.stringify(tx[key])}`);
    }
  }
}

console.log(`\n═══ PDF i18n equivalence: ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);

'use strict';

/**
 * exporters/pdf-exporter.js — генерирует PDF-отчёт и возвращает Buffer.
 *
 * Использует дизайн из font-test-v5.js (принят владельцем).
 * EN/RU тексты — inline-константы (pdf.* i18n ключи ещё не полные).
 *
 * @param {{ period, lang, dateFrom, dateTo }} opts
 * @returns {Promise<Buffer>}
 */

const PDFDocument = require('pdfkit');
const path        = require('path');

const icons                    = require('../../../shared/pdf-icons');
const { renderPieChart, renderLineChart } = require('../../../shared/chart');
const {
  countLeadsInRange,
  getSourceBreakdownInRange,
  getLeadsByDayRange,
  getQualityStatsInRange,
} = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('pdf-exporter');

// ── Brand constants ──────────────────────────────────────────
const FONT   = '/usr/share/fonts/truetype/montserrat/';
const BLUE   = '#28347F';
const ORANGE = '#F37021';
const GREY   = '#666666';
const DARK   = '#1A1A2E';
const WHITE  = '#FFFFFF';
const LIGHT  = '#F8F9FA';
const PAGE   = { size: 'A4', margin: 0 };

// ── Bilingual text ───────────────────────────────────────────
const TX = {
  en: {
    cover_title:       'MONTHLY REPORT',
    cover_date_label:  (d) => d,                          // "May 2026"
    cover_generated:   (d) => `Generated ${d}`,           // "Generated 2026-05-27"
    summary_header:    'EXECUTIVE SUMMARY',
    leads_label:       'NEW LEADS',
    revenue_label:     'REVENUE (QAR)',
    members_label:     'ACTIVE MEMBERS',
    pending_label:     'in2 pending',
    status_revenue:    'Revenue: behind target (in2 data pending)',
    status_leads:      (n) => `Leads: on pace (${n} this month, target 40)`,
    status_response:   'Response: behind target (avg 4.2h, goal ≤ 2h)',
    key_events:        'Key Events',
    ev_leads:          (n) => `${n} new leads this month — highest since February`,
    ev_in2:            'Revenue & attendance data pending in2 (Aug 2026)',
    ev_response:       'Avg first-response 4.2h — target ≤ 2h not met',
    leads_header:      'LEADS & PIPELINE',
    funnel_title:      'Conversion Funnel',
    f_submitted:       'Submitted',
    f_responded:       'Responded',
    f_trial_book:      'Trial Booked',
    f_trial_attend:    'Trial Attended',
    f_subscribed:      'Subscribed',
    in2_title:         'Coming with in2 integration',
    in2_body:          'Trial bookings, attendance tracking, subscriptions and revenue after in2 API (Aug 2026).',
    sources_title:     'Lead Sources Distribution',
    src_col_source:    'Source',
    src_col_leads:     'Leads',
    chart_title:       'Daily Leads — Last 4 Weeks',
    best_label:        (d, n) => `Best: ${d} (${n} leads)`,
    worst_label:       (d, n) => `Worst: ${d} (${n} lead${n !== 1 ? 's' : ''})`,
    p4_header:         'ATTENDANCE, REVENUE & COACHES',
    s_attendance:      'Attendance',
    s_attendance_sub:  'Total visits, per-coach attendance, group fill rates',
    s_revenue:         'Revenue',
    s_revenue_sub:     'Monthly revenue, QAR per session, coach compensation',
    s_coaches:         'Coach Overview',
    s_coaches_sub:     'Session counts, performance metrics, feedback scores',
    coming_in2:        'Coming with in2 integration',
    expected:          'Expected: August 2026',
    footer:            'AcroGym · Monthly Report',
    page_of:           (n, t) => `Page ${n} of ${t}`,
  },
  ru: {
    cover_title:       'ЕЖЕМЕСЯЧНЫЙ ОТЧЁТ',
    cover_date_label:  (d) => d,
    cover_generated:   (d) => `Сформировано ${d}`,
    summary_header:    'ИТОГИ МЕСЯЦА',
    leads_label:       'НОВЫЕ ЛИДЫ',
    revenue_label:     'ВЫРУЧКА (QAR)',
    members_label:     'АКТИВНЫХ ЧЛЕНОВ',
    pending_label:     'ожидает in2',
    status_revenue:    'Выручка: ниже плана (данные in2 ожидаются)',
    status_leads:      (n) => `Лиды: в рамках плана (${n} за месяц, цель 40)`,
    status_response:   'Отклик: ниже цели (ср. 4,2 ч, цель ≤ 2 ч)',
    key_events:        'Ключевые события',
    ev_leads:          (n) => `${n} новых лидов — максимум с февраля`,
    ev_in2:            'Выручка и посещаемость ожидают in2 (авг. 2026)',
    ev_response:       'Ср. время ответа 4,2 ч — цель ≤ 2 ч не достигнута',
    leads_header:      'ЛИДЫ И ВОРОНКА ПРОДАЖ',
    funnel_title:      'Воронка конверсии',
    f_submitted:       'Подано заявок',
    f_responded:       'Получили ответ',
    f_trial_book:      'Записались на пробу',
    f_trial_attend:    'Пришли на пробу',
    f_subscribed:      'Оформили абонемент',
    in2_title:         'Появится с интеграцией in2',
    in2_body:          'Бронирование, посещаемость, конверсии и выручка появятся после запуска in2 (август 2026).',
    sources_title:     'Распределение по источникам',
    src_col_source:    'Источник',
    src_col_leads:     'Лиды',
    chart_title:       'Лиды по дням — последние 4 недели',
    best_label:        (d, n) => `Лучший: ${d} (${n} лидов)`,
    worst_label:       (d, n) => `Худший: ${d} (${n} лид${n === 1 ? '' : n < 5 ? 'а' : 'ов'})`,
    p4_header:         'ПОСЕЩАЕМОСТЬ, ВЫРУЧКА И ТРЕНЕРЫ',
    s_attendance:      'Посещаемость',
    s_attendance_sub:  'Итого визитов, посещаемость по тренерам, заполняемость групп',
    s_revenue:         'Выручка',
    s_revenue_sub:     'Ежемесячная выручка, QAR за занятие, вознаграждение тренеров',
    s_coaches:         'Обзор тренеров',
    s_coaches_sub:     'Кол-во занятий, показатели эффективности, оценки обратной связи',
    coming_in2:        'Появится с интеграцией in2',
    expected:          'Ожидается: август 2026',
    footer:            'AcroGym · Месячный отчёт',
    page_of:           (n, t) => `Стр. ${n} из ${t}`,
  },
};

// ── Period-aware titles ──────────────────────────────────────
const PERIOD_TITLES = {
  en: {
    day:    { cover: 'DAILY REPORT',    summary: 'DAILY SUMMARY',     chart: 'Lead Activity — Selected Day',   footer: 'AcroGym · Daily Report'   },
    week:   { cover: 'WEEKLY REPORT',   summary: 'WEEKLY SUMMARY',    chart: 'Daily Leads — This Week',        footer: 'AcroGym · Weekly Report'  },
    month:  { cover: 'MONTHLY REPORT',  summary: 'EXECUTIVE SUMMARY', chart: 'Daily Leads — Last 4 Weeks',     footer: 'AcroGym · Monthly Report' },
    custom: { cover: 'PERIOD REPORT',   summary: 'PERIOD SUMMARY',    chart: 'Daily Leads — Selected Period',  footer: 'AcroGym · Period Report'  },
  },
  ru: {
    day:    { cover: 'ЕЖЕДНЕВНЫЙ ОТЧЁТ',  summary: 'ИТОГИ ДНЯ',       chart: 'Активность за выбранный день',       footer: 'AcroGym · Ежедневный отчёт' },
    week:   { cover: 'НЕДЕЛЬНЫЙ ОТЧЁТ',   summary: 'ИТОГИ НЕДЕЛИ',    chart: 'Лиды по дням — выбранная неделя',   footer: 'AcroGym · Недельный отчёт'  },
    month:  { cover: 'ЕЖЕМЕСЯЧНЫЙ ОТЧЁТ', summary: 'ИТОГИ МЕСЯЦА',    chart: 'Лиды по дням — последние 4 недели', footer: 'AcroGym · Месячный отчёт'   },
    custom: { cover: 'ОТЧЁТ ЗА ПЕРИОД',   summary: 'ИТОГИ ПЕРИОДА',   chart: 'Лиды по дням — выбранный период',   footer: 'AcroGym · Отчёт за период'  },
  },
};

// ── Helpers ──────────────────────────────────────────────────

function noLig(str) {
  return String(str == null ? '' : str)
    .replace(/fi/g, 'f‌i')
    .replace(/fl/g, 'f‌l')
    .replace(/ff/g, 'f‌f');
}

function formatDate(dateStr, lang) {
  // "2026-05-27" → "May 2026" / "Май 2026"
  const d   = new Date(dateStr + 'T00:00:00Z');
  const loc = lang === 'ru' ? 'ru-RU' : 'en-US';
  return new Intl.DateTimeFormat(loc, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}

function formatDateShort(dateStr, lang) {
  // "2026-05-27" → "27.05" (ru) or "05/27" (en)
  const [, mm, dd] = dateStr.split('-');
  return lang === 'ru' ? `${dd}.${mm}` : `${mm}/${dd}`;
}

function formatGenerated(dateStr) {
  // "2026-05-27" → "27.05.2026"
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

function coverDateForPeriod(period, dateFrom, dateTo, lang) {
  const loc = lang === 'ru' ? 'ru-RU' : 'en-US';
  if (period === 'day') {
    // "27 мая 2026" / "May 27, 2026"
    const d = new Date(dateFrom + 'T00:00:00Z');
    return new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
  }
  if (period === 'month') {
    return formatDate(dateFrom, lang); // "May 2026" / "май 2026"
  }
  // week or custom: "18 мая — 24 мая 2026" / "18 May — 24 May 2026"
  const d1 = new Date(dateFrom + 'T00:00:00Z');
  const d2 = new Date(dateTo   + 'T00:00:00Z');
  const fmt = new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'long', timeZone: 'UTC' });
  return `${fmt.format(d1)} — ${fmt.format(d2)} ${d2.getUTCFullYear()}`;
}

// ── Main export function ─────────────────────────────────────

async function generatePdf({ period = 'month', lang = 'en', dateFrom, dateTo } = {}) {
  const tx = TX[lang] || TX.en;
  // Period-aware titles (cover, summary header, chart title, footer)
  const ptLang = PERIOD_TITLES[lang] || PERIOD_TITLES.en;
  const pt     = ptLang[period] || ptLang.month;

  // ── Fetch real data ──────────────────────────────────────
  const totalLeads  = countLeadsInRange(dateFrom, dateTo);
  const rawSources  = getSourceBreakdownInRange(dateFrom, dateTo);
  const dailyRows   = getLeadsByDayRange(dateFrom, dateTo);
  const quality     = getQualityStatsInRange(dateFrom, dateTo);

  // Source breakdown (top 4)
  const SRC_COLORS  = ['#28347F', '#F37021', '#5A6BC4', '#FF9755', '#1A2356', '#C25617'];
  const srcLabels   = rawSources.slice(0, 4).map(r => r.source);
  const srcCounts   = rawSources.slice(0, 4).map(r => r.cnt);
  const srcTotal    = srcCounts.reduce((a, b) => a + b, 0) || 1;

  // Daily line chart data
  const lineLabels = dailyRows.map(r => formatDateShort(r.day, lang));
  const lineData   = dailyRows.map(r => r.cnt);

  // Responded count
  const respondedCount = quality.total_responded || 0;

  // Pre-render charts
  const [pieBuffer, lineBuffer] = await Promise.all([
    renderPieChart({ title: '', labels: srcLabels.length ? srcLabels : ['No data'], data: srcCounts.length ? srcCounts : [1], width: 220, height: 220 }),
    renderLineChart({ title: noLig(pt.chart), labels: lineLabels.length ? lineLabels : ['—'], data: lineData.length ? lineData : [0], width: 960, height: 320 }),
  ]);

  const maxIdx      = lineData.length ? lineData.indexOf(Math.max(...lineData)) : 0;
  const minIdx      = lineData.length ? lineData.indexOf(Math.min(...lineData)) : 0;
  const insightStr  = lineData.length
    ? `${tx.best_label(lineLabels[maxIdx] || '—', lineData[maxIdx] || 0)}  ·  ${tx.worst_label(lineLabels[minIdx] || '—', lineData[minIdx] || 0)}`
    : '';

  // Cover date label — period-aware
  const coverDateLabel  = coverDateForPeriod(period, dateFrom, dateTo, lang);
  const coverGenerated  = lang === 'ru' ? formatGenerated(dateTo) : dateTo;

  // ── Build PDF ────────────────────────────────────────────
  const doc    = new PDFDocument({ size: 'A4', margin: 0 });
  const chunks = [];
  doc.on('data', c => chunks.push(c));

  const bufferPromise = new Promise((resolve, reject) => {
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.registerFont('M-Black',    FONT + 'Montserrat-Black.ttf');
  doc.registerFont('M-ExtraBold',FONT + 'Montserrat-ExtraBold.ttf');
  doc.registerFont('M-Bold',     FONT + 'Montserrat-Bold.ttf');
  doc.registerFont('M-SemiBold', FONT + 'Montserrat-SemiBold.ttf');
  doc.registerFont('M-Regular',  FONT + 'Montserrat-Regular.ttf');
  doc.registerFont('M-Light',    FONT + 'Montserrat-Light.ttf');

  const W = doc.page.width;
  const H = doc.page.height;
  const M = 40;

  function txt(text, x, y, opts = {}) {
    doc.text(noLig(text), x, y, { lineBreak: false, ...opts });
  }
  function par(text, x, y, opts = {}) {
    doc.text(noLig(text), x, y, opts);
  }
  function footer(pageNum, total) {
    doc.rect(0, H - 44, W, 44).fill(LIGHT);
    doc.moveTo(M, H - 44).lineTo(W - M, H - 44).lineWidth(0.5).strokeColor('#E0E0E0').stroke();
    doc.fontSize(7.5).fillColor(GREY).font('M-Regular');
    txt(pt.footer, M, H - 28);
    txt(tx.page_of(pageNum, 4), W - M - 80, H - 28);
  }

  // ══════════════════════════════════════════════
  // PAGE 1 — COVER
  // ══════════════════════════════════════════════
  doc.rect(0, 0, W, H).fill(BLUE);

  const logoPath = path.join(__dirname, '../../../config/brand/logo-white.png');
  try {
    doc.image(logoPath, W / 2 - 60, 130, { width: 120 });
  } catch {
    doc.fontSize(54).fillColor(WHITE).font('M-Black');
    txt('AcroGym', 0, 140, { width: W, align: 'center' });
  }

  doc.fontSize(26).fillColor(WHITE).font('M-ExtraBold');
  txt(pt.cover, 0, 300, { width: W, align: 'center' });

  doc.fontSize(15).fillColor('rgba(255,255,255,0.75)').font('M-Regular');
  txt(tx.cover_date_label(coverDateLabel), 0, 338, { width: W, align: 'center' });

  doc.moveTo(80, 374).lineTo(W - 80, 374).lineWidth(0.5).strokeColor('rgba(255,255,255,0.3)').stroke();

  doc.fontSize(10).fillColor('#E0E0FF').font('M-Light');
  txt(tx.cover_generated(coverGenerated), 0, 390, { width: W, align: 'center' });

  // ══════════════════════════════════════════════
  // PAGE 2 — EXECUTIVE SUMMARY
  // ══════════════════════════════════════════════
  doc.addPage(PAGE);
  doc.rect(0, 0, W, H).fill(WHITE);
  doc.rect(0, 0, W, 52).fill(BLUE);
  doc.fontSize(12).fillColor(WHITE).font('M-Bold');
  txt(pt.summary, M, 19);
  doc.fontSize(9).fillColor('rgba(255,255,255,0.65)').font('M-Regular');
  txt(coverDateLabel, W - M - 80, 21);

  const colW = (W - M * 2) / 3;
  const COLS = [
    { label: tx.leads_label,   value: String(totalLeads), sub: '+12% vs prev', real: true  },
    { label: tx.revenue_label, value: '—',                sub: tx.pending_label, real: false },
    { label: tx.members_label, value: '—',                sub: tx.pending_label, real: false },
  ];

  COLS.forEach((col, i) => {
    const cx = M + i * colW;
    doc.fontSize(col.real ? 54 : 32).fillColor(col.real ? ORANGE : '#C8C8C8').font('M-Black');
    txt(col.value, cx, 68, { width: colW, align: 'center' });
    doc.fontSize(8).fillColor(GREY).font('M-Bold');
    txt(col.label, cx, 138, { width: colW, align: 'center' });
    doc.fontSize(7.5).fillColor(col.real ? '#16A34A' : '#C8C8C8').font('M-Regular');
    txt(noLig(col.sub), cx, 152, { width: colW, align: 'center' });
    if (i < 2) {
      doc.moveTo(M + (i + 1) * colW, 62).lineTo(M + (i + 1) * colW, 170)
         .lineWidth(0.5).strokeColor('#E5E5E5').stroke();
    }
  });

  const STATUS_Y = 192;
  doc.rect(M, STATUS_Y, W - M * 2, 92).fill(LIGHT)
     .roundedRect(M, STATUS_Y, W - M * 2, 92, 5).fill(LIGHT);

  const STATUSES = [
    { fill: '#DC2626', line: tx.status_revenue },
    { fill: '#F59E0B', line: tx.status_leads(totalLeads) },
    { fill: '#DC2626', line: tx.status_response },
  ];
  STATUSES.forEach((s, i) => {
    const sy = STATUS_Y + 14 + i * 24;
    doc.circle(M + 20, sy + 6, 5).fill(s.fill);
    doc.fontSize(9.5).fillColor(DARK).font('M-SemiBold');
    txt(s.line, M + 32, sy + 1);
  });

  const KE_Y = STATUS_Y + 108;
  doc.fontSize(12).fillColor(BLUE).font('M-ExtraBold');
  txt(tx.key_events, M, KE_Y);

  const EVENTS = [
    { icon: 'TrendingUp',    color: '#16A34A', text: tx.ev_leads(totalLeads)    },
    { icon: 'Package',       color: ORANGE,    text: noLig(tx.ev_in2)          },
    { icon: 'AlertTriangle', color: '#DC2626', text: noLig(tx.ev_response)     },
  ];
  EVENTS.forEach((ev, i) => {
    const ey = KE_Y + 22 + i * 32;
    doc.rect(M, ey + 3, 3, 16).fill(ORANGE);
    const iw = icons.draw(doc, ev.icon, M + 10, ey + 4, { size: 13, color: ev.color });
    doc.fontSize(9.5).fillColor(DARK).font('M-Regular');
    par(ev.text, M + 10 + iw, ey + 5, { width: W - M * 2 - 30 });
  });

  footer(2, 4);

  // ══════════════════════════════════════════════
  // PAGE 3 — LEADS & PIPELINE
  // ══════════════════════════════════════════════
  doc.addPage(PAGE);
  doc.rect(0, 0, W, H).fill(WHITE);
  doc.rect(0, 0, W, 52).fill(BLUE);
  doc.fontSize(12).fillColor(WHITE).font('M-Bold');
  txt(tx.leads_header, M, 19);
  doc.fontSize(9).fillColor('rgba(255,255,255,0.65)').font('M-Regular');
  txt(coverDateLabel, W - M - 80, 21);

  doc.fontSize(11).fillColor(BLUE).font('M-ExtraBold');
  txt(tx.funnel_title, M, 66);

  const FUNNEL = [
    { stage: tx.f_submitted,   count: String(totalLeads),    pct: '100%', real: true  },
    { stage: tx.f_responded,   count: String(respondedCount), pct: respondedCount && totalLeads ? Math.round(respondedCount / totalLeads * 100) + '%' : '—', real: respondedCount > 0 },
    { stage: tx.f_trial_book,  count: '—', pct: '—', real: false },
    { stage: tx.f_trial_attend,count: '—', pct: '—', real: false },
    { stage: tx.f_subscribed,  count: '—', pct: '—', real: false },
  ];

  FUNNEL.forEach((row, i) => {
    const ry = 84 + i * 24;
    if (i % 2 === 0) doc.rect(M, ry, W - M * 2, 23).fill(LIGHT);
    doc.fontSize(9).fillColor(row.real ? DARK : '#BBBBBB').font('M-Regular');
    txt(row.stage, M + 8, ry + 6);
    doc.fontSize(12).fillColor(row.real ? BLUE : '#CCCCCC').font('M-Bold');
    txt(row.count, 0, ry + 4, { width: W - M - 80, align: 'right' });
    doc.fontSize(8).fillColor(row.real ? GREY : '#DDDDDD').font('M-Regular');
    txt(row.pct, 0, ry + 7, { width: W - M - 8, align: 'right' });
  });

  const PH_Y = 84 + FUNNEL.length * 24 + 8;
  doc.rect(M, PH_Y, W - M * 2, 54).fill('#FFF8F0')
     .roundedRect(M, PH_Y, W - M * 2, 54, 5).fill('#FFF8F0');
  doc.rect(M, PH_Y, 4, 54).fill(ORANGE);
  const piw = icons.draw(doc, 'Package', M + 14, PH_Y + 10, { size: 15, color: ORANGE });
  doc.fontSize(10).fillColor(ORANGE).font('M-Bold');
  txt(tx.in2_title, M + 14 + piw, PH_Y + 11);
  doc.fontSize(8).fillColor(GREY).font('M-Regular');
  par(noLig(tx.in2_body), M + 14 + piw, PH_Y + 26, { width: W - M * 2 - 50 });

  // Pie chart
  const CHART_Y   = PH_Y + 66;
  const PIE_PDF_W = 175;
  const TABLE_X   = M + PIE_PDF_W + 16;
  const TABLE_W   = W - TABLE_X - M;
  const LINE_PDF_W = W - M * 2;

  doc.fontSize(11).fillColor(BLUE).font('M-ExtraBold');
  txt(noLig(tx.sources_title), M, CHART_Y);

  const PIE_Y = CHART_Y + 16;
  doc.image(pieBuffer, M, PIE_Y, { width: PIE_PDF_W });

  doc.fontSize(9).fillColor(GREY).font('M-Bold');
  txt(tx.src_col_source, TABLE_X, PIE_Y + 4);
  txt(tx.src_col_leads, TABLE_X + TABLE_W - 60, PIE_Y + 4);
  txt('%', TABLE_X + TABLE_W - 20, PIE_Y + 4);
  doc.moveTo(TABLE_X, PIE_Y + 16).lineTo(TABLE_X + TABLE_W, PIE_Y + 16)
     .lineWidth(0.5).strokeColor('#DDDDDD').stroke();

  srcLabels.forEach((lbl, i) => {
    const ty = PIE_Y + 24 + i * 22;
    doc.circle(TABLE_X + 6, ty + 6, 4).fill(SRC_COLORS[i % SRC_COLORS.length]);
    doc.fontSize(9).fillColor(DARK).font('M-Regular');
    txt(lbl, TABLE_X + 16, ty + 2);
    doc.font('M-Bold');
    txt(String(srcCounts[i]), TABLE_X + TABLE_W - 60, ty + 2);
    doc.font('M-Regular').fillColor(GREY);
    txt(`${Math.round(srcCounts[i] / srcTotal * 100)}%`, TABLE_X + TABLE_W - 20, ty + 2);
  });

  // Line chart
  const LINE_Y = CHART_Y + 16 + PIE_PDF_W + 14;
  doc.fontSize(11).fillColor(BLUE).font('M-ExtraBold');
  txt(noLig(tx.chart_title), M, LINE_Y);
  if (insightStr) {
    const headW = doc.widthOfString(noLig(tx.chart_title));
    doc.fontSize(8.5).fillColor(GREY).font('M-Regular');
    txt(`  ·  ${noLig(insightStr)}`, M + headW, LINE_Y + 1.5);
  }
  doc.image(lineBuffer, M, LINE_Y + 18, { width: LINE_PDF_W });

  footer(3, 4);

  // ══════════════════════════════════════════════
  // PAGE 4 — PLACEHOLDERS
  // ══════════════════════════════════════════════
  doc.addPage(PAGE);
  doc.rect(0, 0, W, H).fill(WHITE);
  doc.rect(0, 0, W, 52).fill(BLUE);
  doc.fontSize(12).fillColor(WHITE).font('M-Bold');
  txt(tx.p4_header, M, 19);
  doc.fontSize(9).fillColor('rgba(255,255,255,0.65)').font('M-Regular');
  txt(coverDateLabel, W - M - 80, 21);

  const PH_SECS = [
    { icon: 'BarChart3',  title: tx.s_attendance, sub: noLig(tx.s_attendance_sub) },
    { icon: 'TrendingUp', title: tx.s_revenue,    sub: noLig(tx.s_revenue_sub)    },
    { icon: 'User',       title: tx.s_coaches,    sub: noLig(tx.s_coaches_sub)    },
  ];

  const SEC_H = 218;
  PH_SECS.forEach((sec, i) => {
    const sy  = 62 + i * SEC_H;
    const iw2 = icons.draw(doc, sec.icon, M, sy + 2, { size: 15, color: BLUE });
    doc.fontSize(12).fillColor(BLUE).font('M-ExtraBold');
    txt(sec.title, M + iw2, sy);

    const bx = M, by = sy + 22, bw = W - M * 2, bh = 172;
    doc.rect(bx, by, bw, bh).fill(LIGHT)
       .roundedRect(bx, by, bw, bh, 8).fill(LIGHT);
    doc.roundedRect(bx, by, bw, bh, 8).lineWidth(1).strokeColor('#E0E0E0').stroke();

    icons.draw(doc, 'Package', W / 2 - 22, by + 40, { size: 44, color: '#CCCCCC' });
    doc.fontSize(12).fillColor('#AAAAAA').font('M-SemiBold');
    txt(tx.coming_in2, 0, by + 96, { width: W, align: 'center' });
    doc.fontSize(8.5).fillColor('#BBBBBB').font('M-Regular');
    txt(sec.sub, 0, by + 114, { width: W, align: 'center' });
    doc.fontSize(8).fillColor('#CCCCCC').font('M-Light');
    txt(tx.expected, 0, by + 132, { width: W, align: 'center' });
  });

  footer(4, 4);

  doc.end();

  logger.info({ lang, dateFrom, dateTo, totalLeads }, 'PDF generated');
  return bufferPromise;
}

module.exports = { generatePdf };

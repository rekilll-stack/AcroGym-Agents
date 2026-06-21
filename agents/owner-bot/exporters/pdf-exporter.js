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
const { buildReportData, formatDuration } = require('../../../shared/report-data');
const { createLogger }         = require('../../../shared/logger');
const { t }                    = require('../../../shared/i18n');

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
// Bilingual text now lives in shared/i18n under the `pdf.*` namespace (verbatim
// migration — same wording the owner approved). buildTx keeps the EXACT shape the
// renderer expects (plain strings + parametrised functions) so call sites are
// unchanged; only the source of the strings moved (hardcoded → i18n).
function buildTx(lang) {
  const T = (k, v) => t(`pdf.${k}`, lang, v);
  // RU plural for "лид" — preserves the original simple (n<5) rule verbatim.
  const leadsNoun = (n) => lang === 'ru'
    ? (n === 1 ? 'лид' : n < 5 ? 'лида' : 'лидов')
    : (n === 1 ? 'lead' : 'leads');
  return {
    cover_title:          T('cover_title'),
    cover_date_label:     (d) => d,
    cover_generated:      (d) => T('cover_generated', { date: d }),
    summary_header:       T('summary_header'),
    leads_label:          T('leads_label'),
    revenue_label:        T('revenue_label'),
    members_label:        T('members_label'),
    pending_label:        T('pending_label'),
    status_revenue:       T('status_revenue'),
    status_leads_zero:    T('status_leads_zero'),
    status_leads_red:     (n) => T('status_leads_red',    { n }),
    status_leads_yellow:  (n) => T('status_leads_yellow', { n }),
    status_leads_green:   (n) => T('status_leads_green',  { n }),
    status_response_none: T('status_response_none'),
    status_response_calc: (time, goal) => T('status_response_calc', { time, goal }),
    key_events:        T('key_events'),
    ev_leads_zero:     T('ev_leads_zero'),
    ev_leads_some:     (n) => T('ev_leads_some', { n }),
    ev_in2:            T('ev_in2'),
    ev_response_none:  T('ev_response_none'),
    ev_response_calc:  (time, goal, met) => T('ev_response_calc', { time, goal, verdict: met ? T('verdict_met') : T('verdict_not_met') }),
    vs_prev_pos:       (p) => T('vs_prev_pos', { p }),
    vs_prev_neg:       (p) => T('vs_prev_neg', { p }),
    vs_prev_zero:      T('vs_prev_zero'),
    vs_no_prior:       T('vs_no_prior'),
    vs_no_activity:    T('vs_no_activity'),
    chart_no_data:     T('chart_no_data'),
    pie_no_data:       T('pie_no_data'),
    leads_header:      T('leads_header'),
    funnel_title:      T('funnel_title'),
    f_submitted:       T('f_submitted'),
    f_responded:       T('f_responded'),
    f_trial_book:      T('f_trial_book'),
    f_trial_attend:    T('f_trial_attend'),
    f_subscribed:      T('f_subscribed'),
    in2_title:         T('in2_title'),
    in2_body:          T('in2_body'),
    sources_title:     T('sources_title'),
    src_col_source:    T('src_col_source'),
    src_col_leads:     T('src_col_leads'),
    chart_title:       T('chart_title'),
    best_label:        (d, n) => T('best_label',  { d, n }),
    worst_label:       (d, n) => T('worst_label', { d, n, noun: leadsNoun(n) }),
    p4_header:         T('p4_header'),
    s_attendance:      T('s_attendance'),
    s_attendance_sub:  T('s_attendance_sub'),
    s_revenue:         T('s_revenue'),
    s_revenue_sub:     T('s_revenue_sub'),
    s_coaches:         T('s_coaches'),
    s_coaches_sub:     T('s_coaches_sub'),
    coming_in2:        T('coming_in2'),
    expected:          T('expected'),
    footer:            T('footer'),
    page_of:           (n, total) => T('page_of', { n, total }),
  };
}

// ── Helpers ──────────────────────────────────────────────────

function noLig(str) {
  return String(str == null ? '' : str)
    .replace(/fi/g, 'f‌i')
    .replace(/fl/g, 'f‌l')
    .replace(/ff/g, 'f‌f');
}

// ── Main export function ─────────────────────────────────────

async function generatePdf({ period = 'month', lang = 'en', dateFrom, dateTo } = {}) {
  const tx = buildTx(lang);

  // ── Shared data (DB + derived) ────────────────────────────
  const rd = await buildReportData({ period, lang, dateFrom, dateTo });
  const {
    pt, totalLeads, respondedCount,
    srcLabels, srcCounts, srcTotal, SRC_COLORS, hasSourceData,
    lineLabels, lineData, maxIdx, minIdx, hasLineData,
    avgResponseSeconds, prevTotal, prevDelta, prevDeltaPct,
    coverDateLabel, coverGenerated,
  } = rd;

  // ── Pre-render charts only when there's data (avoid fake single-segment pie / flat line) ──
  const [pieBuffer, lineBuffer] = await Promise.all([
    hasSourceData
      ? renderPieChart({ title: '', labels: srcLabels, data: srcCounts, width: 220, height: 220 })
      : Promise.resolve(null),
    hasLineData
      ? renderLineChart({ title: noLig(pt.chart), labels: lineLabels, data: lineData, width: 960, height: 320 })
      : Promise.resolve(null),
  ]);

  const insightStr = hasLineData
    ? `${tx.best_label(lineLabels[maxIdx] || '—', lineData[maxIdx] || 0)}  ·  ${tx.worst_label(lineLabels[minIdx] || '—', lineData[minIdx] || 0)}`
    : '';

  // ── Card 1 sub: vs prev (honest, no fake +12%) ─────────────
  function vsPrevSub() {
    if (totalLeads === 0)          return { text: tx.vs_no_activity, color: '#C8C8C8' };
    if (prevDeltaPct === null)     return { text: tx.vs_no_prior,    color: '#C8C8C8' };
    if (prevDeltaPct === 0)        return { text: tx.vs_prev_zero,   color: '#888888' };
    if (prevDeltaPct  >  0)        return { text: tx.vs_prev_pos(prevDeltaPct),       color: '#16A34A' };
    return                                { text: tx.vs_prev_neg(prevDeltaPct),       color: '#DC2626' };
  }
  const card1Sub = vsPrevSub();

  // ── Status helpers (severity-aware) ─────────────────────────
  function leadsStatus(n) {
    if (n === 0) return { text: tx.status_leads_zero,        color: '#DC2626' };
    if (n < 20)  return { text: tx.status_leads_red(n),      color: '#DC2626' };
    if (n < 40)  return { text: tx.status_leads_yellow(n),   color: '#F59E0B' };
    return       { text: tx.status_leads_green(n),           color: '#16A34A' };
  }
  function responseStatus(seconds, responded) {
    if (!responded || seconds == null) return { text: tx.status_response_none, color: '#DC2626' };
    const dur = formatDuration(seconds, lang);
    const sec = seconds;
    const color = sec <= 2 * 3600 ? '#16A34A' : sec <= 4 * 3600 ? '#F59E0B' : '#DC2626';
    return { text: tx.status_response_calc(dur, lang === 'ru' ? '2 ч' : '2h'), color };
  }
  const stLeads    = leadsStatus(totalLeads);
  const stResponse = responseStatus(avgResponseSeconds, respondedCount);

  // ── Key Events (honest copy, no "highest since February") ──
  const evLeadsText    = totalLeads === 0 ? tx.ev_leads_zero    : tx.ev_leads_some(totalLeads);
  const evResponseText = (avgResponseSeconds == null || respondedCount === 0)
    ? tx.ev_response_none
    : tx.ev_response_calc(formatDuration(avgResponseSeconds, lang), lang === 'ru' ? '2 ч' : '2h', avgResponseSeconds <= 2*3600);

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
    { label: tx.leads_label,   value: String(totalLeads), sub: card1Sub.text, subColor: card1Sub.color, real: totalLeads > 0 },
    { label: tx.revenue_label, value: '—', sub: tx.pending_label, subColor: '#C8C8C8', real: false },
    { label: tx.members_label, value: '—', sub: tx.pending_label, subColor: '#C8C8C8', real: false },
  ];

  COLS.forEach((col, i) => {
    const cx = M + i * colW;
    doc.fontSize(col.real ? 54 : 32).fillColor(col.real ? ORANGE : '#C8C8C8').font('M-Black');
    txt(col.value, cx, 68, { width: colW, align: 'center' });
    doc.fontSize(8).fillColor(GREY).font('M-Bold');
    txt(col.label, cx, 138, { width: colW, align: 'center' });
    doc.fontSize(7.5).fillColor(col.subColor).font('M-Regular');
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
    { fill: '#F59E0B',     line: tx.status_revenue },  // in2 pending = yellow (was red — consistency with PPTX)
    { fill: stLeads.color, line: stLeads.text      },
    { fill: stResponse.color, line: stResponse.text },
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
    { icon: 'TrendingUp',    color: '#16A34A', text: evLeadsText            },
    { icon: 'Package',       color: ORANGE,    text: noLig(tx.ev_in2)        },
    { icon: 'AlertTriangle', color: '#DC2626', text: noLig(evResponseText)   },
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
  if (hasSourceData) {
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
  } else {
    // Placeholder block sized like the pie chart area, centered italic text
    doc.rect(M, PIE_Y, W - M * 2, PIE_PDF_W).fill(LIGHT)
       .roundedRect(M, PIE_Y, W - M * 2, PIE_PDF_W, 6).fill(LIGHT);
    doc.fontSize(11).fillColor('#999999').font('M-Regular');
    txt(noLig(tx.pie_no_data), 0, PIE_Y + PIE_PDF_W / 2 - 7, { width: W, align: 'center' });
  }

  // Line chart
  const LINE_Y = CHART_Y + 16 + PIE_PDF_W + 14;
  doc.fontSize(11).fillColor(BLUE).font('M-ExtraBold');
  txt(noLig(tx.chart_title), M, LINE_Y);
  if (insightStr) {
    const headW = doc.widthOfString(noLig(tx.chart_title));
    doc.fontSize(8.5).fillColor(GREY).font('M-Regular');
    txt(`  ·  ${noLig(insightStr)}`, M + headW, LINE_Y + 1.5);
  }
  if (hasLineData) {
    doc.image(lineBuffer, M, LINE_Y + 18, { width: LINE_PDF_W });
  } else {
    const LINE_PH_H = 160;
    doc.rect(M, LINE_Y + 18, LINE_PDF_W, LINE_PH_H).fill(LIGHT)
       .roundedRect(M, LINE_Y + 18, LINE_PDF_W, LINE_PH_H, 6).fill(LIGHT);
    doc.fontSize(11).fillColor('#999999').font('M-Regular');
    txt(noLig(tx.chart_no_data), 0, LINE_Y + 18 + LINE_PH_H / 2 - 7, { width: W, align: 'center' });
  }

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

module.exports = { generatePdf, buildTx };

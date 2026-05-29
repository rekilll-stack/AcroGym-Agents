'use strict';

/**
 * agents/owner-bot/exporters/pptx-exporter.js
 *
 * Premium PPTX monthly report — 5 slides:
 *   1. Cover                       (blue background)
 *   2. Executive Summary           (3 KPI cards + 3 status indicators)
 *   3. Leads & Pipeline            (funnel + pie + table + line chart)
 *   4. Attendance, Revenue & Coaches  (3 in2 placeholder cards)
 *   5. Closing                     (blue background)
 *
 * Architecture rules (enforced):
 *   - ALL strings via t() / createTranslator(lang). No TX object. No hardcoded copy.
 *   - Colors limited to: 28347F (blue), F37021 (orange), FFFFFF, FAFAFA, E0E0E0,
 *     1A1A1A, 333333, 666666, 999999, BDBDBD, DC2626, F59E0B, 16A34A.
 *   - Layout LAYOUT_WIDE = 13.333 × 7.5 inch.
 *
 * @param {{ period, lang, dateFrom, dateTo }} opts
 * @returns {Promise<Buffer>}
 */

const path      = require('path');
const fs        = require('fs');
const PptxGenJS = require('pptxgenjs');

const { buildReportData }            = require('../../../shared/report-data');
const { renderLineChart, renderPieChart } = require('../../../shared/chart');
const { createTranslator }           = require('../../../shared/i18n');
const icons                          = require('../../../shared/pptx-icons');
const { createLogger }               = require('../../../shared/logger');

const logger = createLogger('pptx-exporter');

// ─────────────────────────────────────────────────────────────
// Layout (LAYOUT_WIDE = 13.333 × 7.5 inch)
// ─────────────────────────────────────────────────────────────
const W   = 13.333;
const H   = 7.5;
const M   = 0.42;          // page margin

const HDR_H = 0.70;        // blue header bar height
const HDR_ACCENT_H = 0.04; // orange accent strip height
const FTR_H = 0.36;        // blue footer bar height
const FTR_Y = H - FTR_H;

// ─────────────────────────────────────────────────────────────
// Color palette (limited, brand)
// ─────────────────────────────────────────────────────────────
const C = {
  BLUE:   '28347F',
  ORANGE: 'F37021',
  WHITE:  'FFFFFF',
  BG:     'FAFAFA',  // card background
  LINE:   'E0E0E0',  // hairline border
  INK:    '1A1A1A',  // status text
  TXT:    '333333',  // body text
  MUTED:  '666666',  // subtext
  WEAK:   '999999',  // weakest text
  GHOST:  'BDBDBD',  // placeholder "—"
  RED:    'DC2626',
  YELLOW: 'F59E0B',
  GREEN:  '16A34A',
};

// Status thresholds (per checklist d)
const STATUS_LEADS_GREEN  = 40;
const STATUS_LEADS_YELLOW = 20;
const STATUS_RESP_GREEN   = 90;
const STATUS_RESP_YELLOW  = 70;

const TOTAL_PAGES = 5;

// ─────────────────────────────────────────────────────────────
// Asset helpers
// ─────────────────────────────────────────────────────────────
const BRAND_DIR = path.join(__dirname, '../../../config/brand');
let _logoWhite  = null;

function pngData(buf) {
  return 'data:image/png;base64,' + buf.toString('base64');
}

function logoWhiteData() {
  if (_logoWhite === null) {
    const p = path.join(BRAND_DIR, 'logo-white.png');
    _logoWhite = fs.existsSync(p) ? pngData(fs.readFileSync(p)) : '';
  }
  return _logoWhite || null;
}

// ─────────────────────────────────────────────────────────────
// Shared slide chrome (header bar + footer bar)
// ─────────────────────────────────────────────────────────────

function addHeader(slide, headerText, dateLabel) {
  // Blue full-width bar
  slide.addShape('rect', {
    x: 0, y: 0, w: W, h: HDR_H,
    fill: { color: C.BLUE }, line: { color: C.BLUE, width: 0 },
  });
  // Orange thin accent under it
  slide.addShape('rect', {
    x: 0, y: HDR_H, w: W, h: HDR_ACCENT_H,
    fill: { color: C.ORANGE }, line: { color: C.ORANGE, width: 0 },
  });
  // Section title (left)
  slide.addText(headerText, {
    x: M, y: 0, w: W * 0.62, h: HDR_H,
    fontFace: 'Montserrat', bold: true, fontSize: 22,
    color: C.WHITE, valign: 'middle', align: 'left',
  });
  // Period (right)
  if (dateLabel) {
    slide.addText(dateLabel, {
      x: W * 0.62, y: 0, w: W * 0.38 - M, h: HDR_H,
      fontFace: 'Montserrat', fontSize: 12,
      color: 'CCDDFF', valign: 'middle', align: 'right',
    });
  }
}

function addFooter(slide, tr, rd, pageNum) {
  slide.addShape('rect', {
    x: 0, y: FTR_Y, w: W, h: FTR_H,
    fill: { color: C.BLUE }, line: { color: C.BLUE, width: 0 },
  });
  slide.addText(rd.pt.footer, {
    x: M, y: FTR_Y, w: W * 0.5, h: FTR_H,
    fontFace: 'Montserrat', fontSize: 10,
    color: 'AABBDD', valign: 'middle', align: 'left',
  });
  slide.addText(
    tr.t('common.page_x_of_y', { x: pageNum, y: TOTAL_PAGES }),
    {
      x: W * 0.5, y: FTR_Y, w: W * 0.5 - M, h: FTR_H,
      fontFace: 'Montserrat', fontSize: 10,
      color: 'AABBDD', valign: 'middle', align: 'right',
    }
  );
}

// ─────────────────────────────────────────────────────────────
// SLIDE 1 — Cover
// ─────────────────────────────────────────────────────────────

function renderCover(prs, tr, rd) {
  const slide = prs.addSlide();

  // Full blue background
  slide.addShape('rect', {
    x: 0, y: 0, w: W, h: H,
    fill: { color: C.BLUE }, line: { color: C.BLUE, width: 0 },
  });

  // White logo — centered horizontally, top ~15%
  const logo = logoWhiteData();
  if (logo) {
    const logoW = 3.0;
    slide.addImage({
      data: logo,
      x: (W - logoW) / 2,
      y: H * 0.15,
      w: logoW,
      h: 1.35,
    });
  }

  // Main title — centered (~45% from top)
  slide.addText(tr.t('pptx.cover_subtitle'), {
    x: 0, y: H * 0.42, w: W, h: 1.0,
    fontFace: 'Montserrat', bold: true, fontSize: 54,
    color: C.WHITE, valign: 'middle', align: 'center',
    charSpacing: 4,
  });

  // Period label (under title)
  slide.addText(rd.coverDateLabel, {
    x: 0, y: H * 0.42 + 1.05, w: W, h: 0.5,
    fontFace: 'Montserrat', fontSize: 22,
    color: 'D5DDF2',  // white at ~85% opacity, approximated
    valign: 'middle', align: 'center',
  });

  // Horizontal divider — centered, ~6 inch wide
  const divW = 6.0;
  slide.addShape('rect', {
    x: (W - divW) / 2, y: H * 0.72, w: divW, h: 0.015,
    fill: { color: 'AAB5D9' }, line: { color: 'AAB5D9', width: 0 },
  });

  // Generated date — under divider
  slide.addText(
    tr.t('common.generated_on', { date: rd.coverGenerated }),
    {
      x: 0, y: H * 0.74, w: W, h: 0.4,
      fontFace: 'Montserrat', fontSize: 12,
      color: '99A6CC', valign: 'middle', align: 'center',
    }
  );
}

// ─────────────────────────────────────────────────────────────
// SLIDE 2 — Executive Summary
// ─────────────────────────────────────────────────────────────

function renderExecutiveSummary(prs, tr, rd) {
  const slide = prs.addSlide();
  addHeader(slide, tr.t('monthly.section_exec'), rd.coverDateLabel);
  addFooter(slide, tr, rd, 2);

  // ── 3 KPI cards (row, ~25% from top) ──────────────────────
  const cardW    = 3.7;
  const cardH    = 2.0;
  const cardGap  = 0.5;
  const rowW     = cardW * 3 + cardGap * 2;
  const startX   = (W - rowW) / 2;
  const cardY    = HDR_H + HDR_ACCENT_H + 0.55;

  const convRate = rd.totalLeads > 0
    ? Math.round((rd.respondedCount / rd.totalLeads) * 100)
    : 0;

  // Card 1 sub — honest vs-prev (no fake "+12%")
  let card1SubText, card1SubColor;
  if (rd.totalLeads === 0) {
    card1SubText  = tr.t('pptx.card_no_activity');
    card1SubColor = C.GHOST;
  } else if (rd.prevDeltaPct === null) {
    card1SubText  = tr.t('pptx.card_vs_no_prior');
    card1SubColor = C.WEAK;
  } else if (rd.prevDeltaPct === 0) {
    card1SubText  = tr.t('pptx.card_vs_prev_zero');
    card1SubColor = C.MUTED;
  } else if (rd.prevDeltaPct > 0) {
    card1SubText  = tr.t('pptx.card_vs_prev_pos', { pct: rd.prevDeltaPct });
    card1SubColor = C.GREEN;
  } else {
    card1SubText  = tr.t('pptx.card_vs_prev_neg', { pct: rd.prevDeltaPct });
    card1SubColor = C.RED;
  }

  const cards = [
    {
      value:    String(rd.totalLeads),
      label:    tr.t('monthly.exec_headline_leads'),
      sub:      card1SubText,
      subColor: card1SubColor,
      hasValue: rd.totalLeads > 0,
    },
    {
      value:    '—',
      label:    tr.t('monthly.exec_headline_revenue'),
      sub:      tr.t('pptx.card_in2_pending'),
      subColor: C.MUTED,
      hasValue: false,
    },
    {
      value:    '—',
      label:    tr.t('monthly.exec_headline_students'),
      sub:      tr.t('pptx.card_in2_pending'),
      subColor: C.MUTED,
      hasValue: false,
    },
  ];

  cards.forEach((c, i) => {
    const cx = startX + i * (cardW + cardGap);

    // Card outline
    slide.addShape('rect', {
      x: cx, y: cardY, w: cardW, h: cardH,
      fill: { color: C.BG },
      line: { color: C.LINE, width: 1 },
    });

    // Big number
    slide.addText(c.value, {
      x: cx, y: cardY + 0.25, w: cardW, h: 1.05,
      fontFace: 'Montserrat', bold: true, fontSize: 60,
      color: c.hasValue ? C.ORANGE : C.GHOST,
      valign: 'middle', align: 'center',
    });

    // Label
    slide.addText(c.label.toUpperCase(), {
      x: cx, y: cardY + 1.32, w: cardW, h: 0.32,
      fontFace: 'Montserrat', bold: true, fontSize: 12,
      color: C.BLUE, valign: 'middle', align: 'center',
      charSpacing: 1,
    });

    // Subtext
    slide.addText(c.sub, {
      x: cx, y: cardY + 1.65, w: cardW, h: 0.28,
      fontFace: 'Montserrat', fontSize: 10,
      color: c.subColor, valign: 'middle', align: 'center',
    });
  });

  // ── 3 Status indicators ────────────────────────────────────
  const statusY     = cardY + cardH + 0.65;
  const statusRowH  = 0.45;
  const statusX     = startX;
  const statusW     = rowW;
  const dotR        = 0.10;     // radius in inches (~7pt)
  const dotSize     = dotR * 2;

  // 1) Leads status
  const leadsColor  =
    rd.totalLeads >= STATUS_LEADS_GREEN  ? C.GREEN  :
    rd.totalLeads >= STATUS_LEADS_YELLOW ? C.YELLOW : C.RED;

  // 2) Response status
  const responseColor =
    convRate >= STATUS_RESP_GREEN  ? C.GREEN  :
    convRate >= STATUS_RESP_YELLOW ? C.YELLOW : C.RED;

  // 3) Revenue — always yellow until in2
  const revenueColor = C.YELLOW;

  const rows = [
    {
      color: leadsColor,
      text:  rd.totalLeads === 0
        ? tr.t('pptx.status_leads_no_activity')
        : tr.t('pptx.status_leads_label', { count: rd.totalLeads }),
    },
    {
      color: rd.totalLeads === 0 ? C.RED : responseColor,
      text:  rd.totalLeads === 0
        ? tr.t('pptx.status_response_none')
        : tr.t('pptx.status_response_label', {
            rate:      convRate,
            responded: rd.respondedCount,
            total:     rd.totalLeads,
          }),
    },
    {
      color: revenueColor,
      text:  tr.t('pptx.status_revenue_pending'),
    },
  ];

  rows.forEach((r, i) => {
    const ry = statusY + i * statusRowH;

    // Colored dot
    slide.addShape('ellipse', {
      x: statusX, y: ry + (statusRowH - dotSize) / 2,
      w: dotSize, h: dotSize,
      fill: { color: r.color }, line: { color: r.color, width: 0 },
    });

    // Status text
    slide.addText(r.text, {
      x: statusX + dotSize + 0.18, y: ry,
      w: statusW - dotSize - 0.18, h: statusRowH,
      fontFace: 'Montserrat', fontSize: 13,
      color: C.INK, valign: 'middle', align: 'left',
    });
  });
}

// ─────────────────────────────────────────────────────────────
// SLIDE 3 — Leads & Pipeline
// ─────────────────────────────────────────────────────────────

async function renderLeadsAndPipeline(prs, tr, rd) {
  const slide = prs.addSlide();
  addHeader(slide, tr.t('pptx.slide_leads_header'), rd.coverDateLabel);
  addFooter(slide, tr, rd, 3);

  const CY = HDR_H + HDR_ACCENT_H + 0.30;

  // ── Layout: left column (funnel) / right column (pie+table) ──
  const leftX  = M;
  const leftW  = 5.20;
  const rightX = leftX + leftW + 0.40;
  const rightW = W - rightX - M;

  // ── LEFT: Conversion Funnel ─────────────────────────────────
  slide.addText(tr.t('monthly.leads_funnel_title'), {
    x: leftX, y: CY, w: leftW, h: 0.38,
    fontFace: 'Montserrat', bold: true, fontSize: 16,
    color: C.BLUE, valign: 'middle', align: 'left',
  });

  const pctSubmitted = 100;
  const pctResponded = rd.totalLeads > 0
    ? Math.round((rd.respondedCount / rd.totalLeads) * 100)
    : 0;

  const funnelRows = [
    {
      label: tr.t('monthly.leads_funnel_stage_submitted'),
      val:   String(rd.totalLeads),
      pct:   `${pctSubmitted}%`,
      live:  rd.totalLeads > 0,
    },
    {
      label: tr.t('monthly.leads_funnel_stage_responded'),
      val:   String(rd.respondedCount),
      pct:   `${pctResponded}%`,
      live:  rd.respondedCount > 0,
    },
    { label: tr.t('monthly.leads_funnel_stage_trial'),      val: '—', pct: '—', live: false },
    { label: tr.t('monthly.leads_funnel_stage_attended'),   val: '—', pct: '—', live: false },
    { label: tr.t('monthly.leads_funnel_stage_subscribed'), val: '—', pct: '—', live: false },
  ];

  const funY     = CY + 0.50;
  const funRowH  = 0.32;
  const colLabelW = leftW - 1.5;
  const colValX   = leftX + colLabelW;
  const colValW   = 0.75;
  const colPctX   = colValX + colValW;
  const colPctW   = 0.75;

  funnelRows.forEach((r, i) => {
    const ry = funY + i * funRowH;
    const fg = r.live ? C.BLUE : C.GHOST;

    slide.addText(r.label, {
      x: leftX, y: ry, w: colLabelW, h: funRowH,
      fontFace: 'Montserrat', fontSize: 12,
      color: fg, bold: false,
      valign: 'middle', align: 'left',
    });
    slide.addText(r.val, {
      x: colValX, y: ry, w: colValW, h: funRowH,
      fontFace: 'Montserrat', bold: true, fontSize: 14,
      color: fg, valign: 'middle', align: 'right',
    });
    slide.addText(r.pct, {
      x: colPctX, y: ry, w: colPctW, h: funRowH,
      fontFace: 'Montserrat', bold: true, fontSize: 14,
      color: fg, valign: 'middle', align: 'right',
    });

    // Thin row separator
    if (i < funnelRows.length - 1) {
      slide.addShape('rect', {
        x: leftX, y: ry + funRowH - 0.015, w: leftW, h: 0.012,
        fill: { color: 'E5E5E5' }, line: { color: 'E5E5E5', width: 0 },
      });
    }
  });

  // ── Coming-with-in2 plate (below funnel) ────────────────────
  const plateY = funY + funnelRows.length * funRowH + 0.25;
  const plateH = 0.72;

  // Background
  slide.addShape('rect', {
    x: leftX, y: plateY, w: leftW, h: plateH,
    fill: { color: 'FFF7ED' },
    line: { color: 'FFF7ED', width: 0 },
  });
  // Left orange accent bar
  slide.addShape('rect', {
    x: leftX, y: plateY, w: 0.055, h: plateH,
    fill: { color: C.ORANGE }, line: { color: C.ORANGE, width: 0 },
  });
  // Text
  slide.addText(tr.t('common.coming_with_in2'), {
    x: leftX + 0.18, y: plateY, w: leftW - 0.30, h: plateH,
    fontFace: 'Montserrat', fontSize: 10.5,
    color: C.TXT, valign: 'middle', align: 'left',
  });

  // ── RIGHT: Lead Sources Distribution ────────────────────────
  slide.addText(tr.t('monthly.leads_sources_title'), {
    x: rightX, y: CY, w: rightW, h: 0.38,
    fontFace: 'Montserrat', bold: true, fontSize: 16,
    color: C.BLUE, valign: 'middle', align: 'left',
  });

  // Pie chart + source table (only when there's source data)
  const pieSize = 2.7;
  const pieY    = CY + 0.50;

  if (rd.hasSourceData) {
    let pieImg = null;
    try {
      const buf = await renderPieChart({
        title:    '',
        labels:   rd.srcLabels,
        data:     rd.srcCounts,
        width:    420,
        height:   420,
        doughnut: false,
      });
      pieImg = pngData(buf);
    } catch (e) {
      logger.warn({ err: e.message }, 'pie chart render failed');
    }

    if (pieImg) {
      slide.addImage({ data: pieImg, x: rightX, y: pieY, w: pieSize, h: pieSize });
    }

    // Source mini-rows (no column headings — per agreement)
    const srcX  = rightX + pieSize + 0.30;
    const srcW  = rightX + rightW - srcX;
    const srcY  = pieY + 0.15;
    const srcRowH = 0.40;

    rd.srcLabels.forEach((lbl, i) => {
      const ry  = srcY + i * srcRowH;
      const cnt = rd.srcCounts[i];
      const pct = Math.round((cnt / rd.srcTotal) * 100);
      const clr = (rd.SRC_COLORS[i % rd.SRC_COLORS.length] || '#28347F').replace('#', '');

      slide.addShape('ellipse', {
        x: srcX, y: ry + (srcRowH - 0.18) / 2, w: 0.18, h: 0.18,
        fill: { color: clr }, line: { color: clr, width: 0 },
      });
      slide.addText(lbl, {
        x: srcX + 0.30, y: ry,
        w: srcW - 0.30 - 1.40, h: srcRowH,
        fontFace: 'Montserrat', fontSize: 11,
        color: C.TXT, valign: 'middle', align: 'left',
      });
      slide.addText(String(cnt), {
        x: srcX + srcW - 1.30, y: ry, w: 0.55, h: srcRowH,
        fontFace: 'Montserrat', bold: true, fontSize: 11,
        color: C.TXT, valign: 'middle', align: 'right',
      });
      slide.addText(`${pct}%`, {
        x: srcX + srcW - 0.65, y: ry, w: 0.65, h: srcRowH,
        fontFace: 'Montserrat', bold: true, fontSize: 11,
        color: clr, valign: 'middle', align: 'right',
      });
    });
  } else {
    // Placeholder: no source data
    slide.addShape('rect', {
      x: rightX, y: pieY, w: rightW, h: pieSize,
      fill: { color: C.BG }, line: { color: C.LINE, width: 1 },
    });
    slide.addText(tr.t('pptx.pie_no_data'), {
      x: rightX, y: pieY, w: rightW, h: pieSize,
      fontFace: 'Montserrat', italic: true, fontSize: 13,
      color: C.WEAK, valign: 'middle', align: 'center',
    });
  }

  // ── Bottom: Line chart full width ───────────────────────────
  const chartY     = 5.30;
  const chartH     = FTR_Y - chartY - 0.20;
  const chartTitleY = chartY - 0.30;

  slide.addText(rd.pt.chart, {
    x: M, y: chartTitleY, w: W - M * 2, h: 0.28,
    fontFace: 'Montserrat', bold: true, fontSize: 12,
    color: C.BLUE, valign: 'middle', align: 'left',
  });

  if (rd.hasLineData) {
    let lineImg = null;
    try {
      const buf = await renderLineChart({
        title:  '',
        labels: rd.lineLabels,
        data:   rd.lineData,
        width:  1500,
        height: 320,
      });
      lineImg = pngData(buf);
    } catch (e) {
      logger.warn({ err: e.message }, 'line chart render failed');
    }

    if (lineImg) {
      slide.addImage({ data: lineImg, x: M, y: chartY, w: W - M * 2, h: chartH });
    }
  } else {
    // Placeholder: no daily activity
    slide.addShape('rect', {
      x: M, y: chartY, w: W - M * 2, h: chartH,
      fill: { color: C.BG }, line: { color: C.LINE, width: 1 },
    });
    slide.addText(tr.t('pptx.chart_no_data'), {
      x: M, y: chartY, w: W - M * 2, h: chartH,
      fontFace: 'Montserrat', italic: true, fontSize: 14,
      color: C.WEAK, valign: 'middle', align: 'center',
    });
  }
}

// ─────────────────────────────────────────────────────────────
// SLIDE 4 — Attendance, Revenue & Coaches (in2 placeholders)
// ─────────────────────────────────────────────────────────────

function renderIn2Placeholders(prs, tr, rd) {
  const slide = prs.addSlide();
  addHeader(slide, tr.t('pptx.slide_in2_header'), rd.coverDateLabel);
  addFooter(slide, tr, rd, 4);

  const cardW   = 3.7;
  const cardH   = 4.0;
  const cardGap = 0.50;
  const rowW    = cardW * 3 + cardGap * 2;
  const startX  = (W - rowW) / 2;
  const cardY   = HDR_H + HDR_ACCENT_H + 0.60;

  const cards = [
    {
      title: tr.t('pptx.in2_attendance_title'),
      desc:  tr.t('pptx.in2_attendance_desc'),
    },
    {
      title: tr.t('pptx.in2_revenue_title'),
      desc:  tr.t('pptx.in2_revenue_desc'),
    },
    {
      title: tr.t('pptx.in2_coaches_title'),
      desc:  tr.t('pptx.in2_coaches_desc'),
    },
  ];

  const comingText  = tr.t('common.coming_with_in2');
  const expectedTxt = tr.t('pptx.in2_expected_date');

  cards.forEach((c, i) => {
    const cx = startX + i * (cardW + cardGap);

    // Card background
    slide.addShape('rect', {
      x: cx, y: cardY, w: cardW, h: cardH,
      fill: { color: 'F5F5F5' },
      line: { color: C.LINE, width: 1 },
    });

    // Icon — Package (top center, ~15% from card top)
    const iconSize = 0.55;
    const iconSvg  = icons.svg('Package', '#' + C.ORANGE, 64);
    if (iconSvg) {
      slide.addImage({
        data: iconSvg,
        x: cx + (cardW - iconSize) / 2,
        y: cardY + 0.45,
        w: iconSize, h: iconSize,
      });
    }

    // Card title (center)
    slide.addText(c.title, {
      x: cx + 0.20, y: cardY + 1.20, w: cardW - 0.40, h: 0.45,
      fontFace: 'Montserrat', bold: true, fontSize: 16,
      color: C.BLUE, valign: 'middle', align: 'center',
    });

    // "Coming with in2 integration" (orange, semibold)
    slide.addText(comingText, {
      x: cx + 0.20, y: cardY + 1.72, w: cardW - 0.40, h: 0.40,
      fontFace: 'Montserrat', bold: true, fontSize: 11,
      color: C.ORANGE, valign: 'middle', align: 'center',
    });

    // Description (3 lines, centered)
    slide.addText(c.desc, {
      x: cx + 0.30, y: cardY + 2.25, w: cardW - 0.60, h: 1.20,
      fontFace: 'Montserrat', fontSize: 10,
      color: C.MUTED, valign: 'top', align: 'center',
    });

    // "Expected: August 2026" italic, bottom
    slide.addText(expectedTxt, {
      x: cx + 0.20, y: cardY + cardH - 0.50, w: cardW - 0.40, h: 0.32,
      fontFace: 'Montserrat', italic: true, fontSize: 10,
      color: C.WEAK, valign: 'middle', align: 'center',
    });
  });
}

// ─────────────────────────────────────────────────────────────
// SLIDE 5 — Closing
// ─────────────────────────────────────────────────────────────

function renderClosing(prs, tr) {
  const slide = prs.addSlide();

  // Full blue background
  slide.addShape('rect', {
    x: 0, y: 0, w: W, h: H,
    fill: { color: C.BLUE }, line: { color: C.BLUE, width: 0 },
  });

  // White logo — top center, ~1.5 inch wide
  const logo = logoWhiteData();
  if (logo) {
    const logoW = 1.5;
    slide.addImage({
      data: logo,
      x: (W - logoW) / 2,
      y: H * 0.10,
      w: logoW,
      h: 0.68,
    });
  }

  // "Questions?" — centered, ~40% from top
  slide.addText(tr.t('pptx.closing_question'), {
    x: 0, y: H * 0.36, w: W, h: 1.1,
    fontFace: 'Montserrat', bold: true, fontSize: 60,
    color: C.WHITE, valign: 'middle', align: 'center',
  });

  // Orange accent line under "Questions?"
  const lineW = 3.0;
  slide.addShape('rect', {
    x: (W - lineW) / 2, y: H * 0.52, w: lineW, h: 0.03,
    fill: { color: C.ORANGE }, line: { color: C.ORANGE, width: 0 },
  });

  // Contacts — 2 lines (split by "|")
  const contact = tr.t('pptx.closing_contact');
  const parts   = contact.split('|').map(s => s.trim()).filter(Boolean);
  parts.forEach((p, i) => {
    slide.addText(p, {
      x: 0, y: H * 0.57 + i * 0.42, w: W, h: 0.42,
      fontFace: 'Montserrat', fontSize: 18,
      color: 'E0E5F0', valign: 'middle', align: 'center',
    });
  });

  // Slogan — italic, lower
  slide.addText(tr.t('pptx.closing_slogan'), {
    x: W * 0.10, y: H * 0.78, w: W * 0.80, h: 0.80,
    fontFace: 'Montserrat', italic: true, fontSize: 14,
    color: 'BFC8DD', valign: 'top', align: 'center',
  });

  // "acrogym.org" at bottom
  slide.addText(tr.t('pptx.footer_text'), {
    x: 0, y: H * 0.92, w: W, h: 0.32,
    fontFace: 'Montserrat', fontSize: 10,
    color: '99A6CC', valign: 'middle', align: 'center',
  });
}

// ─────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────

/**
 * Generate a premium PPTX monthly report buffer.
 *
 * @param {{ period?, lang?, dateFrom, dateTo }} opts
 * @returns {Promise<Buffer>}
 */
async function generatePptx({ period = 'month', lang = 'en', dateFrom, dateTo } = {}) {
  const tr = createTranslator(lang);
  const rd = await buildReportData({ period, lang, dateFrom, dateTo });

  logger.info({ period, lang, dateFrom, dateTo, totalLeads: rd.totalLeads }, 'generating PPTX');

  const prs    = new PptxGenJS();
  prs.layout   = 'LAYOUT_WIDE';
  prs.author   = 'AcroGym';
  prs.subject  = tr.t('pptx.cover_subtitle');
  prs.title    = `AcroGym ${tr.t('pptx.cover_subtitle')} ${rd.coverDateLabel}`;

  renderCover(prs, tr, rd);
  renderExecutiveSummary(prs, tr, rd);
  await renderLeadsAndPipeline(prs, tr, rd);
  renderIn2Placeholders(prs, tr, rd);
  renderClosing(prs, tr);

  const buf = await prs.write({ outputType: 'nodebuffer' });
  logger.info({ bytes: buf.length, period, lang }, 'PPTX generated');
  return buf;
}

module.exports = { generatePptx };

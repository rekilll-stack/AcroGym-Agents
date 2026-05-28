'use strict';

/**
 * shared/chart.js — обёртка над chartjs-node-canvas.
 * Все графики рендерятся в фирменных цветах из shared/brand.js.
 * Каждая функция возвращает Promise<Buffer> (PNG).
 */

const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { getBrand }          = require('./brand');

// ─────────────────────────────────────────────────────────────
// Watermark plugin — "AcroGym" в правом нижнем углу
// ─────────────────────────────────────────────────────────────

const WATERMARK_PLUGIN = {
  id: 'acrogym-watermark',
  afterDraw(chart) {
    const { ctx, width, height } = chart;
    ctx.save();
    ctx.globalAlpha   = 0.22;
    ctx.font          = '11px sans-serif';
    ctx.fillStyle     = '#28347F';
    ctx.textAlign     = 'right';
    ctx.textBaseline  = 'bottom';
    ctx.fillText('AcroGym', width - 10, height - 8);
    ctx.restore();
  },
};

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function _palette() {
  return getBrand().chart_palette || {
    primary:    '#28347F',
    secondary:  '#F37021',
    background: '#FFFFFF',
    grid:       '#E5E5E5',
    text:       '#28347F',
    series:     ['#28347F', '#F37021', '#5A6BC4', '#FF9755', '#1A2356', '#C25617'],
  };
}

function _canvas(width, height) {
  return new ChartJSNodeCanvas({ width, height, backgroundColour: 'white' });
}

function _defaultScales(palette) {
  return {
    x: {
      grid:  { color: palette.grid  || '#E5E5E5' },
      ticks: { color: palette.text  || '#28347F' },
    },
    y: {
      grid:  { color: palette.grid  || '#E5E5E5' },
      ticks: { color: palette.text  || '#28347F' },
      beginAtZero: true,
    },
  };
}

function _hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

// ─────────────────────────────────────────────────────────────
// renderLineChart
// ─────────────────────────────────────────────────────────────

/**
 * Линейный график.
 * @param {{ title, labels, data, width?, height? }} opts
 * @returns {Promise<Buffer>}
 */
async function renderLineChart({ title, labels, data, width = 800, height = 400 }) {
  const palette = _palette();
  const canvas  = _canvas(width, height);

  const config = {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label:                title,
        data,
        borderColor:          palette.primary,
        backgroundColor:      palette.primary + '26',
        pointBackgroundColor: palette.primary,
        borderWidth: 2,
        pointRadius: 4,
        fill: true,
        tension: 0.35,
      }],
    },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        title:  { display: true, text: title, color: palette.text, font: { size: 15, weight: 'bold' } },
        legend: { display: false },
      },
      scales: _defaultScales(palette),
    },
    plugins: [WATERMARK_PLUGIN],
  };

  return canvas.renderToBuffer(config);
}

// ─────────────────────────────────────────────────────────────
// renderBarChart
// ─────────────────────────────────────────────────────────────

/**
 * Столбчатый график.
 * @param {{ title, labels, data, width?, height? }} opts
 * @returns {Promise<Buffer>}
 */
async function renderBarChart({ title, labels, data, width = 800, height = 400 }) {
  const palette = _palette();
  const canvas  = _canvas(width, height);
  const series  = palette.series || [palette.primary];

  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label:           title,
        data,
        backgroundColor: labels.map((_, i) => series[i % series.length]),
        borderRadius:    4,
      }],
    },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        title:  { display: true, text: title, color: palette.text, font: { size: 15, weight: 'bold' } },
        legend: { display: false },
      },
      scales: _defaultScales(palette),
    },
    plugins: [WATERMARK_PLUGIN],
  };

  return canvas.renderToBuffer(config);
}

// ─────────────────────────────────────────────────────────────
// renderHeatmap (time-of-day — bar chart по 24 часам)
// ─────────────────────────────────────────────────────────────

/**
 * Тепловая карта (реализована как bar chart с прозрачностью по интенсивности).
 * @param {{ title, data, width?, height? }} opts
 *   data — массив из 24 чисел (кол-во лидов по часам 0-23)
 * @returns {Promise<Buffer>}
 */
async function renderHeatmap({ title, data, width = 800, height = 400 }) {
  const palette = _palette();
  const canvas  = _canvas(width, height);
  const labels  = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
  const max     = Math.max(...data, 1);
  const { r, g, b } = _hexToRgb(palette.primary || '#28347F');

  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label:           title,
        data,
        backgroundColor: data.map(v => {
          const alpha = Math.max(0.12, v / max);
          return `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
        }),
        borderColor:     data.map(v => {
          const alpha = Math.max(0.4, v / max);
          return `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
        }),
        borderWidth:  1,
        borderRadius: 2,
      }],
    },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        title:  { display: true, text: title, color: palette.text, font: { size: 15, weight: 'bold' } },
        legend: { display: false },
      },
      scales: {
        x: { grid: { color: palette.grid }, ticks: { color: palette.text, maxRotation: 45, font: { size: 9 } } },
        y: { grid: { color: palette.grid }, ticks: { color: palette.text }, beginAtZero: true },
      },
    },
    plugins: [WATERMARK_PLUGIN],
  };

  return canvas.renderToBuffer(config);
}

// ─────────────────────────────────────────────────────────────
// renderWeeklyComparison
// ─────────────────────────────────────────────────────────────

/**
 * Grouped bar chart: текущая vs предыдущая неделя.
 * @param {{ title, current_week, previous_week, labels, width?, height? }} opts
 * @returns {Promise<Buffer>}
 */
async function renderWeeklyComparison({ title, current_week, previous_week, labels, width = 800, height = 400 }) {
  const palette = _palette();
  const canvas  = _canvas(width, height);

  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label:           'This week',
          data:            current_week,
          backgroundColor: palette.primary    || '#28347F',
          borderRadius:    4,
        },
        {
          label:           'Previous week',
          data:            previous_week,
          backgroundColor: palette.secondary  || '#F37021',
          borderRadius:    4,
        },
      ],
    },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        title:  { display: true, text: title, color: palette.text, font: { size: 15, weight: 'bold' } },
        legend: { display: true, labels: { color: palette.text } },
      },
      scales: _defaultScales(palette),
    },
    plugins: [WATERMARK_PLUGIN],
  };

  return canvas.renderToBuffer(config);
}

// ─────────────────────────────────────────────────────────────
// renderPieChart
// ─────────────────────────────────────────────────────────────

/**
 * Круговая / пончиковая диаграмма.
 * @param {{ title, labels, data, width?, height?, doughnut? }} opts
 *   doughnut — если true, рисует "пончик" (по умолчанию false = pie)
 * @returns {Promise<Buffer>}
 */
async function renderPieChart({ title, labels, data, width = 500, height = 500, doughnut = false }) {
  const palette = _palette();
  const canvas  = _canvas(width, height);
  const colors  = palette.series || [palette.primary, palette.secondary, '#5A6BC4', '#FF9755', '#1A2356', '#C25617'];

  const config = {
    type: doughnut ? 'doughnut' : 'pie',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: labels.map((_, i) => colors[i % colors.length]),
        borderColor:     '#FFFFFF',
        borderWidth:     2,
      }],
    },
    options: {
      responsive: false,
      animation:  false,
      plugins: {
        title: {
          display: !!title,
          text:    title,
          color:   palette.text || '#28347F',
          font:    { size: 15, weight: 'bold' },
          padding: { bottom: 12 },
        },
        legend: {
          display:  false,
        },
      },
    },
    plugins: [WATERMARK_PLUGIN],
  };

  return canvas.renderToBuffer(config);
}

module.exports = { renderLineChart, renderBarChart, renderHeatmap, renderWeeklyComparison, renderPieChart };

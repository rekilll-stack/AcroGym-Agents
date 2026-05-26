'use strict';

// TODO ЭТАП 7: mid-tier PDF export via pdfkit
// Uses month_names / day_names from shared/i18n, brand colors from shared/brand.js

const { createLogger }    = require('../../../shared/logger');
const { getBrand }        = require('../../../shared/brand');
const { createTranslator } = require('../../../shared/i18n');

const logger = createLogger('owner-bot');

/**
 * Generate a PDF report buffer.
 *
 * @param {object} opts
 * @param {string} opts.period    - 'day' | 'week' | 'month' | 'custom'
 * @param {string} opts.lang      - 'en' | 'ru'
 * @param {object} opts.data      - report data from monthly-builder
 * @returns {Promise<Buffer>}
 */
async function generatePdf({ period, lang = 'en', data = {} } = {}) {
  const brand = getBrand();
  const tr    = createTranslator(lang);

  logger.warn('[pdf-exporter] Not yet implemented (ЭТАП 7)');

  // TODO: implement cover page, sections, charts, appendix
  // Fonts: @fontsource/montserrat or system Noto Sans (for Cyrillic)
  // pdfkit API: new PDFDocument({ size: 'A4', margins: {...} })

  throw new Error('PDF export not yet implemented — coming in ЭТАП 7');
}

module.exports = { generatePdf };

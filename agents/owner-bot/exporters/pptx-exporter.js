'use strict';

// TODO ЭТАП 8: premium PPTX export via pptxgenjs
// Uses month_names / day_names from shared/i18n, brand colors from shared/brand.js

const { createLogger }    = require('../../../shared/logger');
const { getBrand }        = require('../../../shared/brand');
const { createTranslator } = require('../../../shared/i18n');

const logger = createLogger('owner-bot');

/**
 * Generate a PPTX report buffer.
 *
 * @param {object} opts
 * @param {string} opts.period    - 'day' | 'week' | 'month' | 'custom'
 * @param {string} opts.lang      - 'en' | 'ru'
 * @param {object} opts.data      - report data from monthly-builder
 * @returns {Promise<Buffer>}
 */
async function generatePptx({ period, lang = 'en', data = {} } = {}) {
  const brand = getBrand();
  const tr    = createTranslator(lang);

  logger.warn('[pptx-exporter] Not yet implemented (ЭТАП 8)');

  // TODO: cover slide, executive summary, section dividers, content slides, closing slide
  // pptxgenjs API: new pptxgen(); prs.addSlide(); ...

  throw new Error('PPTX export not yet implemented — coming in ЭТАП 8');
}

module.exports = { generatePptx };

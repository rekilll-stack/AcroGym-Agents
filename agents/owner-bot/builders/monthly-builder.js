'use strict';

// TODO ЭТАП 5: full monthly report builder + PDF/PPTX generation
// Uses month_names / day_names from shared/i18n (NOT _months / _days_long)

const { createLogger }    = require('../../../shared/logger');
const { createTranslator } = require('../../../shared/i18n');

const logger = createLogger('owner-bot');

/**
 * Build monthly report payload (text + optional file buffers).
 * @param {object} opts
 * @param {string} [opts.lang='en']
 * @param {string} [opts.month]   - YYYY-MM, defaults to last month
 * @param {boolean}[opts.withPdf=false]
 * @param {boolean}[opts.withPptx=false]
 * @returns {Promise<{text: string, pdfBuffer: Buffer|null, pptxBuffer: Buffer|null}>}
 */
async function buildMonthlyReport({ lang = 'en', month, withPdf = false, withPptx = false } = {}) {
  const tr = createTranslator(lang);
  // TODO ЭТАП 5: implement full monthly report
  logger.warn('[monthly-builder] Not yet implemented — returning stub');
  return {
    text:       `${tr.t('monthly.title')}\n<i>Coming in ЭТАП 5</i>`,
    pdfBuffer:  null,
    pptxBuffer: null,
    lang,
  };
}

module.exports = { buildMonthlyReport };

'use strict';

// TODO ЭТАП 4: full weekly slice builder
// Uses month_names / day_names from shared/i18n (NOT _months / _days_long)

const { createLogger }    = require('../../../shared/logger');
const { createTranslator } = require('../../../shared/i18n');

const logger = createLogger('owner-bot');

/**
 * Build weekly slice payload.
 * @param {object} opts
 * @param {string} [opts.lang='en']
 * @param {string} [opts.weekStart]  - YYYY-MM-DD (Monday), defaults to last Monday
 * @returns {Promise<{text: string, chartBuffers: Buffer[]}>}
 */
async function buildWeeklySlice({ lang = 'en', weekStart } = {}) {
  const tr = createTranslator(lang);
  // TODO ЭТАП 4: implement full stats collection and text building
  logger.warn('[weekly-builder] Not yet implemented — returning stub');
  return {
    text:         `${tr.t('weekly.title')}\n<i>Coming in ЭТАП 4</i>`,
    chartBuffers: [],
    lang,
  };
}

module.exports = { buildWeeklySlice };

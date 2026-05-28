'use strict';

const { createLogger }         = require('../../../shared/logger');
const { t }                    = require('../../../shared/i18n');
const { setState, clearState } = require('../../../shared/state');
const { getPreferredLanguage } = require('../../../shared/preferences');

const logger = createLogger('owner-bot');

/**
 * /export command — Step 1/3: Choose period.
 * Also called from menu:export and month:export_pdf (with pre-fill).
 */
module.exports = async function handleExport(msg, bot) {
  const chatId = msg.chat.id;
  const lang   = getPreferredLanguage(chatId) || 'en';

  clearState(chatId);
  setState(chatId, 'export', 'period', {});

  const text = `${t('export.title', lang)}\n${t('export.step_1_period', lang)}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: t('export.btn_period_day',    lang), callback_data: 'export:period:day'    },
        { text: t('export.btn_period_week',   lang), callback_data: 'export:period:week'   },
      ],
      [
        { text: t('export.btn_period_month',  lang), callback_data: 'export:period:month'  },
        { text: t('export.btn_period_custom', lang), callback_data: 'export:period:custom' },
      ],
      [
        { text: `❌ ${t('common.cancel', lang)}`,   callback_data: 'export:cancel'         },
        { text: t('common.back_to_menu', lang),      callback_data: 'menu:back'             },
      ],
    ],
  };
  console.log('[KEYBOARD] /export period keyboard:', JSON.stringify(keyboard.inline_keyboard));

  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'MarkdownV2', reply_markup: keyboard });
  } catch (err) {
    logger.error({ err }, '/export sendMessage failed');
  }
};

'use strict';

/**
 * /broadcast — Step 1/3: choose audience segment.
 * Also reachable from the menu (menu:broadcast → same handler).
 * Owner-only by construction (registerOwnerCommand + the polling owner guard).
 * B3 is preview + dry-run only — NO sending, NO writes to the broadcasts table
 * (the draft lives in user_state; the row is created by B4 at dispatch).
 */

const { createLogger }         = require('../../../shared/logger');
const { t }                    = require('../../../shared/i18n');
const { setState, clearState } = require('../../../shared/state');
const { getPreferredLanguage } = require('../../../shared/preferences');

const logger = createLogger('owner-bot');

module.exports = async function handleBroadcast(msg, bot) {
  const chatId = msg.chat.id;
  const lang   = getPreferredLanguage(chatId) || 'en'; // 'both'/null → 'en'

  clearState(chatId);
  setState(chatId, 'broadcast', 'segment', { channel: 'telegram_test', body_kind: 'text' });

  const text = `${t('broadcast.title', lang)}\n${t('broadcast.choose_segment', lang)}`;
  const keyboard = {
    inline_keyboard: [
      [{ text: t('broadcast.btn_seg_all',   lang), callback_data: 'broadcast:seg:all'   }],
      [{ text: t('broadcast.btn_seg_age',   lang), callback_data: 'broadcast:seg:age'   }],
      [{ text: t('broadcast.btn_seg_ctype', lang), callback_data: 'broadcast:seg:ctype' }],
      [{ text: `❌ ${t('common.cancel', lang)}`,    callback_data: 'broadcast:cancel'    }],
    ],
  };

  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'MarkdownV2', reply_markup: keyboard });
  } catch (err) {
    logger.error({ err }, '/broadcast sendMessage failed');
  }
};

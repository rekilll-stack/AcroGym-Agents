'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const cron = require('node-cron');
const { createLogger }  = require('../../shared/logger');
const { sendToOwner }   = require('../../shared/notify');
const { buildDigest }   = require('./builder');

const logger = createLogger('morning-digest');

const TIMEZONE = process.env.TIMEZONE || 'Asia/Qatar';
const DRY_RUN  = process.argv.includes('--dry-run');

// ─────────────────────────────────────────────────────────────
// Отправка дайджеста
// ─────────────────────────────────────────────────────────────

async function sendDigest() {
  logger.info('Формируем утренний дайджест...');

  let digest;
  try {
    digest = await buildDigest({ dryRun: DRY_RUN });
  } catch (err) {
    logger.error({ err }, 'Ошибка формирования дайджеста');
    await sendToOwner(`🚨 Morning-digest: ошибка формирования\n<code>${err.message}</code>`).catch(() => {});
    return;
  }

  if (DRY_RUN) {
    // Только в консоль, без отправки в Telegram
    console.log('\n' + '═'.repeat(60));
    console.log('DRY RUN — текст дайджеста:');
    console.log('═'.repeat(60));
    // Убираем HTML-теги для читаемости в консоли
    const plainText = digest.text
      .replace(/<b>/g, '').replace(/<\/b>/g, '')
      .replace(/<i>/g, '').replace(/<\/i>/g, '')
      .replace(/<code>/g, '').replace(/<\/code>/g, '');
    console.log(plainText);
    console.log('═'.repeat(60));

    if (digest.topUnanswered.length > 0) {
      console.log('\nТоп неотвеченных лидов (raw data):');
      digest.topUnanswered.forEach((l, i) => {
        console.log(`  ${i+1}. #${l.sheet_row_number} ${l.parent_name} | ${l.language} | notified: ${l.notified_at}`);
      });
    }
    return;
  }

  // Отправляем владельцу через Owner Bot
  try {
    // Inline-кнопки для топ-3 неотвеченных (скопировать текст приветствия)
    let keyboard = undefined;
    if (digest.topUnanswered.length > 0) {
      keyboard = {
        inline_keyboard: [
          digest.topUnanswered.map((lead, i) => ({
            text: `📋 Скопировать #${i + 1}`,
            callback_data: `digest_copy:${lead.id}`,
          })),
        ],
      };
    }

    await sendToOwner(digest.text, keyboard ? { reply_markup: keyboard } : {});
    logger.info('Дайджест отправлен владельцу');
  } catch (err) {
    logger.error({ err }, 'Ошибка отправки дайджеста');
  }
}

// ─────────────────────────────────────────────────────────────
// Запуск
// ─────────────────────────────────────────────────────────────

async function start() {
  if (DRY_RUN) {
    logger.info('Режим DRY RUN — генерируем дайджест и выводим в консоль');
    await sendDigest();
    process.exit(0);
    return;
  }

  logger.info({ timezone: TIMEZONE }, 'Morning-digest запускается, ждём 08:00 Asia/Qatar');

  // Каждый день в 08:00 по времени Qatar
  cron.schedule('0 8 * * *', async () => {
    await sendDigest().catch(err => logger.error({ err }, 'sendDigest unhandled'));
  }, {
    timezone: TIMEZONE,
  });

  logger.info('Morning-digest запущен ✅ (следующий запуск — завтра в 08:00 AST)');
}

// ─────────────────────────────────────────────────────────────
// Process guards
// ─────────────────────────────────────────────────────────────

process.on('SIGTERM', () => { logger.info('SIGTERM'); process.exit(0); });
process.on('SIGINT',  () => { logger.info('SIGINT');  process.exit(0); });

process.on('uncaughtException', async (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  await sendToOwner(`🚨 Morning-digest упал: <code>${err.message}</code>`).catch(() => {});
  process.exit(1);
});

start().catch(async (err) => {
  logger.fatal({ err }, 'Ошибка запуска morning-digest');
  process.exit(1);
});

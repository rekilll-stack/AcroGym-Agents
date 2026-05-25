'use strict';

/**
 * WhatsApp Cloud API channel — ЗАГЛУШКА.
 *
 * TODO: При подключении WhatsApp Cloud API:
 * 1. Добавить в .env:
 *      WHATSAPP_PHONE_NUMBER_ID=...
 *      WHATSAPP_ACCESS_TOKEN=...
 *      WHATSAPP_API_VERSION=v20.0
 *
 * 2. Реализовать POST:
 *      https://graph.facebook.com/{WHATSAPP_API_VERSION}/{WHATSAPP_PHONE_NUMBER_ID}/messages
 *
 * 3. Для холодных сообщений (первый контакт или после 24-часового окна) —
 *    использовать pre-approved Templates (HSM).
 *    Templates создаются в Meta Business Manager и проходят модерацию.
 *
 * 4. Для service-сообщений (в течение 24ч после ответа клиента) —
 *    можно слать text body без шаблона.
 *
 * 5. Webhook для входящих ответов от клиентов — отдельный агент (whatsapp-inbox).
 *
 * 6. Нормализовать номер телефона: +974XXXXXXXX (убрать пробелы, скобки, тире).
 */

async function sendViaWhatsAppCloud(lead, messageText, messageType, metadata) {
  throw new Error(
    'WhatsApp Cloud API не настроен. Установите CLIENT_CHANNEL=telegram_draft в .env'
  );
}

module.exports = { sendViaWhatsAppCloud };

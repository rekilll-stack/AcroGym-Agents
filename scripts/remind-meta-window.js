#!/usr/bin/env node
'use strict';
// Одноразовое напоминание (08.08.2026 10:45): окно FAILED_RISK_CHECK истекло.
// После отправки вычищает свою строку из crontab — самоликвидация.
const { execSync } = require('child_process');
const { sendToOwner, ownerLangRecipients, escapeMd } = require('../shared/telegram');

const TEXTS = {
  ru: '⏰ Окно Meta (72ч) истекло в 10:44. Можно сделать РОВНО ОДНУ попытку добавить карту: Billing & Payments, стабильная сеть, без VPN, GPS включён. Если снова FAILED_RISK_CHECK — не повторять, а вернуться в открытый чат поддержки и запросить эскалацию (она предзаряжена).',
  en: '⏰ The Meta 72-hour window expired at 10:44. Make EXACTLY ONE payment-method attempt: Billing & Payments, stable network, no VPN, GPS on. If FAILED_RISK_CHECK returns — do not retry; go back to the open support chat and request the pre-arranged escalation.',
};

(async () => {
  for (const [lang, chatIds] of Object.entries(ownerLangRecipients())) {
    if (!chatIds.length) continue;
    await sendToOwner(escapeMd(TEXTS[lang]), { chatIds }).catch((e) => console.error('send failed:', e.message));
  }
  try {
    const cur = execSync('crontab -l', { encoding: 'utf8' });
    const cleaned = cur.split('\n').filter((l) => !l.includes('remind-meta-window')).join('\n');
    execSync('crontab -', { input: cleaned });
    console.log('reminder sent, cron line removed');
  } catch (e) { console.error('cron cleanup failed:', e.message); }
})();

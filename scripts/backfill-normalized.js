'use strict';

/**
 * One-time backfill: populate phone_normalized, whatsapp_normalized, email_normalized
 * for all existing leads where these fields are NULL.
 *
 * Safe to run multiple times (idempotent).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { getDb }                       = require('../shared/db');
const { normalizePhone, normalizeEmail } = require('../shared/normalize');

const db = getDb();

const leads = db.prepare(`
  SELECT id, parent_phone, parent_whatsapp, parent_email
  FROM leads
  WHERE phone_normalized IS NULL
    OR whatsapp_normalized IS NULL
    OR email_normalized IS NULL
`).all();

console.log(`Found ${leads.length} leads needing backfill`);
if (leads.length === 0) { console.log('Nothing to do.'); process.exit(0); }

const update = db.prepare(`
  UPDATE leads
  SET phone_normalized    = @phoneNorm,
      whatsapp_normalized = @whatsappNorm,
      email_normalized    = @emailNorm,
      updated_at          = datetime('now')
  WHERE id = @id
`);

const run = db.transaction(() => {
  let count = 0;
  for (const lead of leads) {
    update.run({
      id:            lead.id,
      phoneNorm:    normalizePhone(lead.parent_phone),
      whatsappNorm: normalizePhone(lead.parent_whatsapp),
      emailNorm:    normalizeEmail(lead.parent_email),
    });
    count++;
  }
  return count;
});

const updated = run();
console.log(`✅ Backfilled ${updated} leads`);

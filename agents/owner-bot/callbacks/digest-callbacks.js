'use strict';

const { registerOwnerCallback }                 = require('../../../shared/telegram');
const { markRespondedHandler, copyTextHandler } = require('../../../shared/callbacks');

/**
 * Register callbacks for inline buttons produced by the daily digest:
 *   mark_responded:<leadId>  — "✅ Done" button
 *   copy_text:<leadId>       — "📋 Copy text" button
 *   digest_copy:<leadId>     — legacy alias (kept for backward compat)
 */
function setupDigestCallbacks() {
  registerOwnerCallback('mark_responded', markRespondedHandler('owner'));
  registerOwnerCallback('copy_text',      copyTextHandler());
  registerOwnerCallback('digest_copy',    copyTextHandler()); // legacy alias
}

module.exports = { setupDigestCallbacks };

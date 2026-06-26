'use strict';

/**
 * One-time Canva OAuth (PKCE) — run on the VPS, no web server needed.
 *
 *   1) node scripts/canva-auth.js
 *        → prints an authorize URL. Open it in a browser (logged into the
 *          Canva account), approve. Canva redirects to your Redirect URL with
 *          ?code=XXXX in the address bar — copy XXXX.
 *   2) node scripts/canva-auth.js <code>
 *        → exchanges the code for tokens and saves the refresh token
 *          (data/canva-tokens.json, chmod 600).
 *   node scripts/canva-auth.js --check
 *        → verifies the saved token by minting an access token.
 *
 * Needs CANVA_CLIENT_ID / CANVA_CLIENT_SECRET / CANVA_REDIRECT_URL in ../.env.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const crypto = require('crypto');
const canva = require('../agents/content-bot/canva');

function need(v, name) { if (!v) { console.error(`❌ ${name} не задан в .env`); process.exit(1); } }

(async () => {
  need(process.env.CANVA_CLIENT_ID, 'CANVA_CLIENT_ID');
  need(process.env.CANVA_CLIENT_SECRET, 'CANVA_CLIENT_SECRET');
  need(process.env.CANVA_REDIRECT_URL, 'CANVA_REDIRECT_URL');

  const arg = process.argv[2];

  if (arg === '--check') {
    try {
      const tok = await canva.getAccessToken();
      console.log('✅ Авторизация работает — access token получен (длина ' + tok.length + ').');
    } catch (e) { console.error('❌ ' + e.message); process.exit(1); }
    return;
  }

  if (!arg) {
    // Step 1 — generate PKCE, print the authorize URL.
    const { verifier, challenge } = canva.newPkce();
    const state = crypto.randomBytes(8).toString('hex');
    fs.writeFileSync(canva.PKCE_PATH, JSON.stringify({ verifier, state }), { mode: 0o600 });
    const url = canva.buildAuthUrl({ challenge, state });
    console.log('\n1) Открой эту ссылку в браузере (войдя в нужный аккаунт Canva), разреши доступ:\n');
    console.log(url + '\n');
    console.log('2) После разрешения браузер уйдёт на твой Redirect URL вида:');
    console.log('   ' + process.env.CANVA_REDIRECT_URL + '?code=XXXXXX&state=...');
    console.log('   Скопируй значение code= и запусти:\n   node scripts/canva-auth.js <code>\n');
    return;
  }

  // Step 2 — exchange the code.
  let pkce;
  try { pkce = JSON.parse(fs.readFileSync(canva.PKCE_PATH, 'utf8')); }
  catch { console.error('❌ Нет сохранённого PKCE — сначала запусти без аргумента (шаг 1).'); process.exit(1); }
  try {
    await canva.exchangeCode(arg.trim(), pkce.verifier);
    fs.unlinkSync(canva.PKCE_PATH);
    console.log('✅ Готово — refresh token сохранён в data/canva-tokens.json (0600).');
    console.log('   Проверка: node scripts/canva-auth.js --check');
  } catch (e) { console.error('❌ ' + e.message); process.exit(1); }
})();

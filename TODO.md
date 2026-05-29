# AcroGym — Technical Debt

Engineering backlog. Items here have been consciously deferred — they are tracked, not forgotten.

---

## Known technical debt

### PDF exporter — i18n decoupling
- **File:** `agents/owner-bot/exporters/pdf-exporter.js`
- **Issue:** Contains hardcoded `TX` dictionary (~80 strings × EN + RU) instead of using `shared/i18n`
- **Lines:** ~30–119 (the `TX` object literal)
- **Impact:** PDF text won't auto-update when i18n is changed; risk of EN/RU divergence with other agents (digest, weekly, monthly Telegram messages)
- **Why deferred:** PDF text is accepted by stakeholder, PPTX is the priority. Refactor is non-trivial: ~30 new i18n keys needed because PDF phrasing differs from telegram-style `monthly.*` keys (e.g. `'NEW LEADS'` vs `monthly.exec_headline_leads: 'New leads'` — different case; `'Submitted'` vs `'Submitted form'` — different wording).
- **Future fix:**
  1. Create dedicated `pdf.*` i18n namespace with PDF-specific phrasing (separate from telegram-style `monthly.*`)
  2. Migrate `TX[lang][key]` → `t('pdf.<key>', lang)` key by key
  3. Visual verification (byte-diff + libreoffice PDF→preview) after each batch
- **Estimated effort:** 2–3 hours focused refactor

---

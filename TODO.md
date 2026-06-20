# AcroGym — Technical Debt

Engineering backlog. Items here have been consciously deferred — they are tracked, not forgotten.

---

## Known technical debt

### Logger — duplicate pretty + JSON output
- **File:** `shared/logger.js`
- **Issue:** Each log event is written twice to stdout — once pino-pretty (ANSI-coloured) and once raw JSON. Visible in `logs/backup.log` (cron redirect) and in every PM2 agent log.
- **Impact:** Cosmetic only — logs are noisier and ~2× larger; no functional effect. Grep/parse still works on the JSON lines.
- **Why deferred:** Pure log hygiene, zero runtime risk; not worth touching the shared logger mid-feature.
- **Future fix:** Configure pino so exactly one transport targets stdout (pretty in dev / JSON in prod), not both.
- **Estimated effort:** ~30 min.

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

### registrations migration (v21) — stale comment
- **File:** `shared/db.js` (migration v21, the `registrations` CREATE TABLE comment)
- **Issue:** The comment says "an edited submission upserts" / "updated_at is bumped explicitly on UPDATE". The implemented behaviour is variant A — `upsertRegistration` is INSERT ... ON CONFLICT DO NOTHING (no UPDATE branch). Comment misleads; behaviour is correct.
- **Impact:** Documentation only — no runtime effect.
- **Future fix:** Reword the v21 comment to DO-NOTHING (re-read is a no-op; a new submission gets a new hash → new row). One-line docs touch.
- **Estimated effort:** ~5 min.

### owner-bot poll_err — quantify the watch trigger
- **Where:** owner-bot heartbeat `detail` carries a cumulative `poll_err: N` (Telegram long-polling errors since process start). Currently watched "by eye" — no threshold.
- **Trigger:** if `poll_err` climbs **> +50 per day**, investigate (API throttle / network flap / long-polling churn). Slow drift (a few/hour) is normal and ignored.
- **Why deferred:** needs a small day-over-day delta tracker (store yesterday's count, diff on the daily ping) rather than the current absolute number; not worth a process touch mid-feature.
- **Estimated effort:** ~30 min.

---

# AcroGym — Technical Debt

Engineering backlog. Items here have been consciously deferred — they are tracked, not forgotten.

---

## Conventions (permanent rules — NOT deferred)

### Temp DB for test/harness runs: `sqlite3 .backup`, NEVER `cp`
- **Rule:** make a throwaway copy of the prod DB with `sqlite3 data/acrogym.db ".backup '/tmp/x.db'"`, never `cp data/acrogym.db /tmp/x.db`.
- **Why:** the prod DB runs in WAL mode. A plain `cp` of the `.db` file alone copies a **stale** snapshot — recent writes still living in `-wal` (seen: a 4 MB un-checkpointed WAL with all 8 `registrations` rows) are missing. The temp run then lies (e.g. "registrations empty"), giving false confidence right before a prod touch. `.backup` is a consistent snapshot that folds in the WAL (same mechanism `backup-db.js` uses).
- **Status:** applied to all `scripts/test-*.js` headers (cp → .backup). Keep new harnesses on `.backup`.

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

### ~~registrations migration (v21) — stale comment~~ ✅ RESOLVED 2026-06-21
- **File:** `shared/db.js` (migration v21 comment). Was: "an edited submission upserts / updated_at bumped on UPDATE" — wrong (upsertRegistration is INSERT ... ON CONFLICT DO NOTHING, no UPDATE branch). Reworded to state the DO-NOTHING behaviour. (The v22 comment was checked and is already correct — no drift there.)

### owner-bot poll_err — quantify the watch trigger
- **Where:** owner-bot heartbeat `detail` carries a cumulative `poll_err: N` (Telegram long-polling errors since process start). Currently watched "by eye" — no threshold.
- **Trigger:** if `poll_err` climbs **> +50 per day**, investigate (API throttle / network flap / long-polling churn). Slow drift (a few/hour) is normal and ignored.
- **Why deferred:** needs a small day-over-day delta tracker (store yesterday's count, diff on the daily ping) rather than the current absolute number; not worth a process touch mid-feature.
- **Estimated effort:** ~30 min.

### ~~registration/broadcast tests assume an empty table — make them self-isolating~~ ✅ RESOLVED 2026-06-20
- **Files:** `test-registrations-db.js`, `test-poll-registrations.js`, `test-broadcast-{resolver,preview,dispatch}.js`; `test-broadcast-migration.js` (tolerant count).
- **Was:** absolute-count assertions assumed an empty `registrations`/`broadcasts` slate, which only held while prod had no opted-in rows / no broadcasts. Once the B4 live test added an opted-in owner-test row + a real broadcast, a consistent `.backup` copy carried them in → false reds.
- **Fix shipped:** each test now clears its slate in the temp copy (`DELETE FROM client_messages; DELETE FROM broadcasts; DELETE FROM registrations;`) before seeding; migration test uses a tolerant `>= 8` (additive migration never drops). Suite is now self-verifying — no manual `clear` step needed.

---

## Planned — WhatsApp Activation Day (B6, DEFERRED)

The broadcast track is functionally complete for `telegram_test` at B5. **B6 (WhatsApp send branch) is deliberately NOT built** — decided 2026-06-21. The "can't reach real numbers" boundary holds by the **absence of send code** (the safest guarantee — a throw-stub can't be misconfigured). Building B6 now would replace that with "code exists, disabled by flag/token" → a new misconfig/guard-bug → real-send failure class, for ~zero benefit (template structure already in B1; payload would target a non-existent Meta template; activation is blocked on Meta App Review anyway). `shared/channels/whatsapp-cloud.js` and the dispatcher's `whatsapp_cloud` branch **stay pure throw-stubs**.

**Do ALL of this on activation day — понимание→ОК→code WITH Kirill, NO autonomy. Cost of error = an irreplaceable phone number + a Meta ban.**
1. Meta App Review approved → a real **UTILITY template** registered + approved (we'll know its exact param shape only then).
2. Cloud API token → `.env` via server (secret, never chat).
3. ONE pass against the REAL template shape: payload-builder + transport (HTTPS POST `graph.facebook.com`) + **feature-flag** + **token-guard** (no token → throw before network).
4. UI: add the WhatsApp channel option to `/broadcast` — it does **not** exist now, and that absence is part of what holds the boundary. Add ONLY on activation day.
5. `resumeBroadcast` edge: resume targets *current audience minus already-'sent'* → on WhatsApp verify an **opt-OUT between start and resume is excluded** (negligible on telegram_test's minute window; matters on real numbers).
6. Live controlled test on **ONE** real number (yours/test) BEFORE any rollout; respect tiered limits, ramp gradually.

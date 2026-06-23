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

### ~~Logger — duplicate pretty + JSON output~~ ✅ RESOLVED 2026-06-21 — NON-ISSUE, do NOT "fix"
- 🔴 **Do not "fix" this — it is working as intended.** The original premise ("each event written twice to stdout, pretty + JSON") is **wrong**.
- **File:** `shared/logger.js`
- **Reality (checked against the files):** the logger does NOT double to stdout. Two pino targets: `pino/file` → **JSON** to `logs/<agent>.log`; `pino-pretty` → **pretty** to stdout (captured by PM2 into `logs/<agent>-out.log`). JSON and pretty live in **separate files, each single-format** — not "twice to stdout". `logs/backup.log` (cron) is JSON-only.
- **Why left alone:** removing either target would *reduce* observability (lose the parseable JSON file, or lose the human-readable PM2 log). The only cost is ~2× storage (same event as JSON + as pretty) — a format choice, not a defect; pm2-logrotate handles rotation. Shared logger = 5-agent blast radius; not worth touching for a non-problem.

### ~~PDF exporter — i18n decoupling~~ ✅ RESOLVED 2026-06-21
- **File:** `agents/owner-bot/exporters/pdf-exporter.js`
- **Done:** the hardcoded `TX` dictionary (54 keys × EN+RU) moved verbatim into the `pdf.*` i18n namespace; `buildTx(lang)` rebuilds the exact shape the renderer expects (plain strings + parametrised functions) from `t('pdf.*', lang, vars)`, so call sites are unchanged. Parametrised entries became `{{var}}` templates; the RU "лид" plural + the met/not-met verdict are resolved in code (verbatim logic). A stale unused `pdf.*` namespace (7 keys from an abandoned TOC/appendix design) was replaced.
- **Verified:** `test-pdf-i18n.js` asserts new i18n output == old TX output for every key/arg (118/118, incl plurals & verdict branches); rendered PDFs are **byte-for-byte identical** to the pre-migration baseline (EN 144398, RU 149052, Δ0). Language picker unchanged (en/ru/both → per-lang PDF). PPTX was already on i18n (untouched).

### ~~registrations migration (v21) — stale comment~~ ✅ RESOLVED 2026-06-21
- **File:** `shared/db.js` (migration v21 comment). Was: "an edited submission upserts / updated_at bumped on UPDATE" — wrong (upsertRegistration is INSERT ... ON CONFLICT DO NOTHING, no UPDATE branch). Reworded to state the DO-NOTHING behaviour. (The v22 comment was checked and is already correct — no drift there.)

### owner-bot poll_err — quantify the watch trigger (DEFERRED — spec wrinkle found 2026-06-21)
- **Where:** owner-bot heartbeat `detail` carries `poll_err: N` from `_ownerPollErr.count` (telegram.js) — **in-memory, resets to 0 on every restart**. watchdog does NOT parse this detail (only displays it), so the detail format is free to change.
- **Wrinkle:** the planned "+50/day" trigger as a simple day-over-day diff is **ill-defined** — the counter resets on every deploy/restart (owner-bot restarts often), so `today − yesterday` goes negative / loses the day's accumulation after a restart. A correct version needs either **(A)** a cumulative count persisted across restarts (DB write per polling error + restore on startup — invasive, for a metric currently ~0), or **(B)** a rate metric (`poll_err / uptime_h`, flag on high rate — robust to restarts but NOT "+50/day").
- **Decision:** deferred — don't ship a tracker that reports "baseline reset" noise after every deploy. poll_err is currently ~0 and not climbing (watch by eye stays). Revisit (pick A or B) only if it actually starts rising.
- **Estimated effort:** ~30 min once a metric (A or B) is chosen.

### ~~registration/broadcast tests assume an empty table — make them self-isolating~~ ✅ RESOLVED 2026-06-20
- **Files:** `test-registrations-db.js`, `test-poll-registrations.js`, `test-broadcast-{resolver,preview,dispatch}.js`; `test-broadcast-migration.js` (tolerant count).
- **Was:** absolute-count assertions assumed an empty `registrations`/`broadcasts` slate, which only held while prod had no opted-in rows / no broadcasts. Once the B4 live test added an opted-in owner-test row + a real broadcast, a consistent `.backup` copy carried them in → false reds.
- **Fix shipped:** each test now clears its slate in the temp copy (`DELETE FROM client_messages; DELETE FROM broadcasts; DELETE FROM registrations;`) before seeding; migration test uses a tolerant `>= 8` (additive migration never drops). Suite is now self-verifying — no manual `clear` step needed.

---

## ~~Secret hygiene — Content-bot token in git history?~~ ✅ CHECKED CLEAN 2026-06-23

- **Context:** the Content-bot (`@AcroGym_Content_bot`) token was added to `.env`; during entry a `.env.bak.*` copy was made (plaintext secret). Question raised: could the token have leaked into git history?
- **Checked (read-only, all refs):** `git log --all -- .env` → never committed; `git log --all -- '.env.bak*'` → never committed; `git log --all --diff-filter=A` name-only → the ONLY `.env*` file ever in git is `.env.example` (a no-secret template). **Conclusion: the token never entered git history. No revoke needed.**
- **Hardened:** `.gitignore` now has `.env.*` + `!.env.example` (was only `.env`), so `.env`, `.env.bak.*`, and any future variants are ignored while the template stays tracked.
- **Residual:** two local `.env.bak.20260623_*` files still hold the token in plaintext on disk (gitignored, so safe from git). Owner may `rm .env.bak.*` once comfortable — token already verified working.
- **Fallback if ever in doubt:** @BotFather `/revoke` → reissue → put the new token on the server via `nano .env`.

---

## Pre-launch checklist — BEFORE real lead flow (Aug–Sep 2026)

### 🔴 Restart nurture agent on the drip code before leads start arriving
- **Why:** A.3 (097ee25) changed the daily-run code path — `lead-helper/index.js` now injects `buildDripContent` into `nurture.runDaily`, so the 08:00 Doha cron drafts REAL touch-2/3 content. The running PM2 process still holds the **pre-A.3 code** (placeholder path). It was intentionally NOT restarted now: prod has **0 eligible leads** and the drip is inert until real leads appear (~September 2026).
- **Risk if skipped:** once a real lead enrolls and the cron fires drip, a stale process would draft the `[NURTURE · touch N placeholder]` text to the admin instead of the approved content.
- **Action (before the lead flow opens, Aug–Sep):** `pm2 restart lead-helper` (and any other nurture-touching agents) so the runtime is on the drip code. Verify after: enroll one synthetic lead, force a due touch on a temp DB, confirm the draft is real content (not placeholder).
- **Status:** deferred by design — this is a "before launch" gate, not a "now" task.

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

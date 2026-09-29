# SRS Telegram Bot — MVP Implementation Plan (Cloudflare Workers)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chat-only Telegram bot that teaches English words to Russian speakers with FSRS-6 spaced repetition — card with spoilered answer and 4 grade buttons visible at once, cumulative progress, catalog/AI/custom decks with attached links, daily reminders — running on the free Cloudflare Workers + D1 tier.

**Architecture:** One Cloudflare Worker: `fetch` handles the Telegram webhook (grammY), `scheduled` runs every minute (reminders, step pings, job retries). D1 (SQLite) holds everything. Layered modules: `bot` → application services (`review`, `content`, `reminders`, `stats`, `users`, `entitlements`, `admin`) → pure `srs` → infra (`db`, `jobs`, `llm`, `dictionary`, `tg`). Layer rules enforced by dependency-cruiser.

**Tech Stack:** TypeScript 5 (strict), Cloudflare Workers + D1, wrangler 4, grammY (`webhookCallback(bot, "cloudflare-mod")`), ts-fsrs (FSRS-6), zod, Vitest + `@cloudflare/vitest-pool-workers`, dependency-cruiser, pnpm. Build-time only: Piper TTS + ffmpeg in GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-29-srs-telegram-bot-design.md`

## Global Constraints

- All times are epoch milliseconds (UTC) in the DB; services take `now: number` as a parameter — only `src/index.ts` reads `Date.now()`.
- FSRS: `generatorParameters({ request_retention, maximum_interval: 36500, enable_fuzz: true, enable_short_term: true, learning_steps: ['1m','10m'], relearning_steps: ['10m'] })`; retention ∈ {0.85, 0.9, 0.95}, default 0.9. Preview uses the same params with `enable_fuzz: false`.
- Day boundary 04:00 user-local. Quiet hours 23:00–08:00 local for pings. Evening push 20:00 local if not studied today and streak ≥ 2.
- Stages by `scheduled_days` (review) — `<7` 🌿 Учу, `7–20` 🌳 Знаю, `≥21` 🏆 Выучено; `new` 🌱 Новое; learning/relearning 🌿 Учу.
- Card: translation and example inside `<tg-spoiler>`; parse_mode HTML; link previews disabled on session messages.
- Grade keyboard 2×2: `[Снова, Трудно] / [Хорошо, Легко]`, text `"{label} {interval}"`, `style`: `danger` / none / `success` / `primary`; third row `🔊` (only if audio) and `↩️`. Callback `g:<cardId>:<reps>:<rating>` ≤ 64 bytes.
- Learn-ahead: if nothing else to show and a learning card is due within 60 000 ms, show it now.
- Limits: `/gen` 3 per user per local day; add-words ≤ 20 lines; AI deck 10–30 words; one link per note, `http(s)` only, ≤ 512 chars; pending link lives 10 min.
- Free-tier budget per invocation: webhook ≤ 8 D1 calls (use `db.batch`) and ≤ 3 Telegram calls; cron tick ≤ 35 Telegram sends and ≤ 10 D1 calls. Enforced by tests with a counting D1 wrapper.
- LLM/dictionary work runs in `ctx.waitUntil` with a 25 s overall timeout; the webhook answers first.
- i18n: all user-facing strings in `src/bot/i18n/{ru,en}.ts`; `en` is typed `typeof ru` so missing keys fail typecheck.
- Secrets: `BOT_TOKEN`, `WEBHOOK_SECRET`, `ADMIN_TG_ID`, `LLM_PROVIDERS` (JSON `[{baseUrl, apiKey, model}]`, default order Groq `https://api.groq.com/openai/v1`, then OpenRouter `https://openrouter.ai/api/v1`).
- Coverage ≥ 90 % for `src/srs` and `src/review`, ≥ 70 % overall.

## Review Focus

1. **Words + links in one message with odd layout** (URL first then words; two URLs on one line; a `text_link` entity on a word; URL with trailing punctuation `https://x.com/a).`) → each word gets the right link, punctuation trimmed, no crash. Test in Task 8.
2. **Stale button** after undo or after a newer card was shown → never grades twice. Test in Task 6.
3. **“Снова” on a learned word, then relearned** → interval after relearning is larger than a brand-new card’s, and the feedback line says memory was kept. Test in Task 2 and Task 6.
4. **Reminder tick missed** (Worker cron skipped 09:00, runs 09:01) → exactly one push. Test in Task 10.
5. **Free-tier D1 limit hit mid-day** (D1 throws “exceeded … daily row write limit”) → user gets the “технический перерыв” message, no unhandled 500 that makes Telegram retry-storm. Test in Task 11.

---

## File Structure

```
package.json, pnpm-lock.yaml, tsconfig.json, wrangler.toml, vitest.config.ts, .dependency-cruiser.cjs
.github/workflows/{ci.yml, deploy.yml, voice-decks.yml, backup.yml}
migrations/0001_init.sql, 0002_seed_catalog.sql (generated)
src/
  index.ts              # export default { fetch, scheduled }
  env.ts                # Env type + parseEnv (zod)
  srs/fsrs.ts           # preview, grade, stage, memoryDays, formatInterval
  db/client.ts          # Db wrapper over D1 (counts calls), row mappers
  db/repo.ts            # typed queries used by services
  jobs/queue.ts         # enqueue/claim/complete/fail on D1
  users/service.ts      # getOrCreate, onboarding, tz, localDay, settings
  users/placement.ts
  review/pick.ts        # pure queue selection
  review/service.ts     # show, grade, undo, feedback, day summary
  content/links.ts      # parse words + URLs from text & entities
  content/dictionary.ts
  content/llm.ts
  content/service.ts    # catalog subscribe, add words, AI decks, previews
  entitlements/service.ts
  reminders/service.ts  # tick
  stats/service.ts
  admin/service.ts
  tg/client.ts          # thin Bot API wrapper used outside grammY context (cron)
  bot/i18n/{ru,en,index}.ts
  bot/views.ts
  bot/handlers/{start,learn,words,decks,settings,stats,admin}.ts
  bot/bot.ts            # grammY Bot factory, router, error boundary
scripts/{build-decks.ts, voice-decks.ts, set-webhook.ts, csv-to-sql.ts}
data/decks/*.csv, data/decks/index.json
test/ (mirrors src/, plus test/helpers/{fakeTelegram.ts, countingDb.ts, clock.ts})
```

CSV header: `word,ipa,pos,translation,example_en,example_ru,audio_file_id`.

---

### Task 1: Skeleton, env, CI

**Files:** Create `package.json`, `tsconfig.json`, `wrangler.toml`, `vitest.config.ts`, `.dependency-cruiser.cjs`, `.github/workflows/ci.yml`, `src/env.ts`, `src/index.ts` (returns 200 “ok” on `GET /`), `test/env.test.ts`, `test/helpers/*`.

**Interfaces:**
- Produces: `interface Env { DB: D1Database; BOT_TOKEN: string; WEBHOOK_SECRET: string; ADMIN_TG_ID: string; LLM_PROVIDERS: string }`; `parseEnv(env: Env): Config` with `llmProviders: {baseUrl, apiKey, model}[]`, `adminTgId: number`. Test helpers: `countingDb(db: D1Database): D1Database & { calls: number }`, `fakeTelegram()` (records Bot API calls, returns canned `Message` objects with incrementing `message_id`).
- `wrangler.toml`: `compatibility_date = "2026-09-01"`, `compatibility_flags = ["nodejs_compat"]`, `[[d1_databases]] binding = "DB"`, `[triggers] crons = ["* * * * *"]`.

- [ ] **Step 1:** `test/env.test.ts::parses LLM_PROVIDERS json` — expect `parseEnv({...,LLM_PROVIDERS:'[{"baseUrl":"https://api.groq.com/openai/v1","apiKey":"k","model":"m"}]'}).llmProviders[0].model === "m"`; invalid JSON throws.
- [ ] **Step 2:** `pnpm test` → FAIL.
- [ ] **Step 3:** Implement. dependency-cruiser rules: `src/srs` may not import anything from `src/` except itself; `src/bot` is the only layer importing `grammy`; services may not import `src/bot`.
- [ ] **Step 4:** `pnpm typecheck && pnpm test && pnpm depcruise` → pass.
- [ ] **Step 5:** Commit `chore: worker skeleton, env, CI`.

### Task 2: SRS domain

**Files:** Create `src/srs/fsrs.ts`, `test/srs/fsrs.test.ts`.

**Interfaces:**
- Produces:
  - `type CardState = "new"|"learning"|"review"|"relearning"`
  - `interface Mem { state: CardState; step: number|null; stability: number|null; difficulty: number|null; due: number; lastReview: number|null; scheduledDays: number; reps: number; lapses: number }`
  - `newMem(now: number): Mem`
  - `grade(m: Mem, rating: 1|2|3|4, now: number, retention: number): Mem`
  - `preview(m: Mem, now: number, retention: number): Record<1|2|3|4, number>` (due ms, no fuzz)
  - `formatInterval(ms: number, lang: "ru"|"en"): string` — `<60s` → `<1м`/`<1m`; minutes → `<Nм`/`<Nm`; hours `Nч`/`Nh`; days `<30` `Nд`/`Nd`; months `2,3мес`/`2.3mo`; years `1,1г`/`1.1y`.
  - `stage(m: Mem): "new"|"learning"|"known"|"learned"` (per Global Constraints).
  - `memoryDays(m: Mem): number` — review: `scheduledDays`; relearning: `Math.round(stability)`; else 0.
- Map `Mem` ↔ ts-fsrs `Card` in two private functions (`State.New=0…Relearning=3`, `learning_steps` → `step`).

- [ ] **Step 1:** Tests:
  - `new card preview matches reference`: labels `["<1м","<6м","<10м","8д"]`.
  - `good good graduates to 2 days`; `third good gives > 7 days` (interval grows: each successive Good on time strictly increases `scheduledDays`).
  - `again on learned keeps memory` (Review Focus 3): take card to `scheduledDays ≥ 21` by repeated on-time Good; Again → `state=="relearning"`, `lapses==1`, `memoryDays > 1`; then Good after 10 min → `scheduledDays` > scheduledDays of a new card after Good,Good (2).
  - `higher retention → shorter interval` (0.95 < 0.85 for same history).
  - `stage thresholds` 6→learning, 7→known, 21→learned.
  - `formatInterval ru/en` table from the signature.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `pnpm test test/srs --coverage` → pass, ≥ 90 %.
- [ ] **Step 5:** Commit `feat(srs): FSRS-6 wrapper, stages, interval formatting`.

### Task 3: D1 schema and repo

**Files:** Create `migrations/0001_init.sql`, `src/db/client.ts`, `src/db/repo.ts`, `test/db/repo.test.ts`.

**Interfaces:**
- Schema as spec §4 (with indexes) plus columns later tasks rely on: `review_log.streak_before`, `review_log.last_study_day_before` (Task 6 undo), `sessions.last_voice_message_id` (Task 9), `users.mix_counter` (Task 6 interleaving).
- Produces `Repo` class constructed with `D1Database`: `getUserByTg(tgId)`, `insertUser(u)`, `updateUser(id, patch)`, `getSession(userId)`, `saveSession(s)`, `subscribe(userId, deckId, now)`, `userDeckIds(userId)`, `candidateCards(userId, now, dayEndMs, limitEach=50) -> {learning: CardRow[], review: CardRow[], newNotes: NoteRow[]}` (single `batch` of 3 selects; `newNotes` = notes in subscribed decks without a card for that direction, ordered by note id), `countsForUser(userId, now, dayEndMs, newLeft)`, `insertCard`, `gradeBatch(stmts)`, `lastReviewLog(userId)`, `markUndone(logId)`, `findNoteForUser(userId, wordLower) -> {note, deckId} | null`, `insertNotes(deckId, rows) -> ids`, `setNoteSourceUrl(noteId, url)`, `setNoteAudio(noteId, fileId)`, `bumpUsage(day, reviews, rows)`.

- [ ] **Step 1:** Tests on vitest-pool-workers D1 (migrations applied via `applyD1Migrations`): `unique card per user/note/direction`; `candidateCards returns due learning, due-today reviews and unseen notes in one batch` (assert `countingDb.calls === 1`); `findNoteForUser is case-insensitive and trims`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(db): D1 schema and repository`.

### Task 4: Job queue on D1

**Files:** Create `src/jobs/queue.ts`, `test/jobs/queue.test.ts`.

**Interfaces:**
- Produces: `enqueue(db, kind, payload, runAt, dedupKey?) -> number|null`; `claim(db, now, limit) -> Job[]` (atomic via `UPDATE jobs SET locked_at=? WHERE id IN (SELECT id … LIMIT ?) AND locked_at IS NULL RETURNING *`; locks older than 5 min are reclaimable); `complete(db, id)`; `fail(db, id, error, now)` — retry at `now + 30s·2^attempts`, give up after 3.
- Job kinds used later: `push` (send a message), `voice` (sendVoice by URL and store file_id).

- [ ] **Step 1:** Tests: `dedup key blocks second pending job`; `future job not claimed`; `failed job retried then abandoned after 3`; `claim twice returns disjoint sets`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(jobs): D1 job queue`.

### Task 5: i18n and views

**Files:** Create `src/bot/i18n/{ru,en,index}.ts`, `src/bot/views.ts`, `test/bot/views.test.ts`.

**Interfaces:**
- Consumes: `preview`, `formatInterval`, `stage`, `memoryDays` (Task 2).
- Produces:
  - `t(lang, key, vars?)`.
  - `interface CardView { cardId; reps; direction: "en_ru"|"ru_en"; word; ipa; pos; translation; exampleEn; exampleRu; hasAudio: boolean; sourceUrl: string|null; mem: Mem }`
  - `type Feedback = { word: string; kind: "grow"|"step"|"lapse"|"first"; beforeDays: number; afterMs: number; keptDays?: number }`
  - `renderCard(v: CardView, counts: {n,l,r}, intervals: Record<1|2|3|4,string>, feedback: Feedback|null, canUndo: boolean, lang) -> { text: string; keyboard: InlineKeyboardButton[][] }` — layout from spec §2.2; source link rendered as `🔗 <a href="{url}">{hostname without www}</a>`.
  - `renderDone(summary: DaySummary, lang)` where `DaySummary = { reviewsToday; learnedToday; totals: {learned, known, learning, new}; nextLearningInMs: number|null; streak }`.
  - `renderAddPreview(items: {word; ipa; pos; translation; exampleEn; exampleRu; sourceUrl|null}[], previewId, lang)`.
- Feedback copy (RU): grow `✅ {word} → через {after} (было {before})`; step `{word} → через {after}`; lapse `↻ {word} → через {after} · память сохранена ~{kept} дн.`; first (new graduated or Easy) `✅ {word} → через {after}`.

- [ ] **Step 1:** Tests: `translation and example are inside tg-spoiler`; `keyboard is 2x2 with styles danger/none/success/primary and callbacks g:7:3:1..4 each ≤ 64 bytes`; `🔊 button only when hasAudio`; `html in word is escaped`; `source link shows hostname`; `feedback lapse line mentions kept days`; `ru and en have the same keys` (compile-time; plus runtime check of `Object.keys`).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(bot): views with spoiler card, 2x2 grades, progress and feedback`.

### Task 6: Review service

**Files:** Create `src/review/pick.ts`, `src/review/service.ts`, `test/review/pick.test.ts`, `test/review/service.test.ts`.

**Interfaces:**
- Consumes: `Repo` (Task 3), `srs` (Task 2), `views` types (Task 5), `localDay/dayEndMs` from `src/users/service.ts` (if Task 7 not done yet, implement those two pure functions first in that file: `localDay(offsetMin, now) -> "YYYY-MM-DD"` with 04:00 boundary; `dayEndMs(offsetMin, now) -> number`).
- Produces:
  - `pick(c: Candidates, newLeft: number, now: number, mixCounter: number) -> {kind:"card", card} | {kind:"new", note} | null` — learning due first; then reviews/new interleaved (new every `ceil(reviews/newLeft)`-th slot); learn-ahead ≤ 60 000 ms when otherwise empty.
  - `class ReviewService { constructor(repo, now) ; nextScreen(user) -> Screen ; grade(user, cardId, reps, rating) -> Screen ; undo(user) -> Screen ; daySummary(user) -> DaySummary }`
  - `type Screen = { kind: "card"; view: CardView; counts; intervals; feedback: Feedback|null; canUndo } | { kind: "done"; summary: DaySummary } | { kind: "stale" } | { kind: "nothing" }` (`nothing` = no decks).
  - `grade`: `reps` mismatch → `stale`; one `gradeBatch` with card update, review_log insert (`state_before` = full `Mem` JSON, `interval_before_days`, `interval_after_ms`), user update (streak: +1 if last day was yesterday-local, 1 if older, unchanged if today; `last_review_at`), `usage_daily` bump, sibling bury when direction `both`. Returns next screen with `feedback` computed from before/after `Mem`.
  - `undo`: restore last non-undone log’s `state_before`, mark undone, restore streak fields saved in the log (`streak_before`, `last_study_day_before`, created in Task 3), return card screen for that card with `feedback: null`.
- Budget: `grade` ≤ 4 D1 calls total (1 load, 1 batch write, 1–2 for next screen).

- [ ] **Step 1:** Pick tests: `learning due first`; `new spread among reviews`; `learn-ahead within 60s`; `no learn-ahead beyond 60s → null`.
- [ ] **Step 2:** Service tests (fake clock):
  - `first card intervals are <1м <6м <10м 8д`.
  - `again then card comes back immediately via learn-ahead when nothing else` (only one card in deck).
  - `stale callback ignored` (Review Focus 2): grade reps=0 twice → second `stale`, one log row; after `undo`, old button (reps=1) → `stale`.
  - `feedback grow shows before and after days` (card at 2d, Good on due → feedback `grow`, `beforeDays=2`, after ≥ 7d).
  - `lapse feedback keeps memory` (Review Focus 3).
  - `daily new limit uses 04:00 local boundary`.
  - `day summary counts learned today and totals by stage`.
  - `grade uses ≤ 4 D1 calls` (countingDb).
- [ ] **Step 3–5:** FAIL → implement → PASS with coverage ≥ 90 %.
- [ ] **Step 6:** Commit `feat(review): queue, grading, undo, feedback, day summary`.

### Task 7: Users, onboarding, settings

**Files:** Create `src/users/service.ts`, `src/users/placement.ts`, `test/users/*.test.ts`.

**Interfaces:**
- Produces: `langFromTelegram(code?: string): "ru"|"en"`; `offsetFromReported(h: number, m: number, now: number): number` (minutes, range [-720, 840], rounded to 30, midnight-safe); `localDay`, `dayEndMs`, `localMinutes(offset, now)`; `getOrCreate(repo, tgId, tgLang, now)`; onboarding steps `"lang"→"placement"→"goal"→"remind"→"tz"→"deck"→null` with `advance(repo, user, answer, now) -> OnboardingScreen`; `setSetting(repo, userId, key: "lang"|"retention"|"newPerDay"|"remindAt"|"direction"|"autoplay", value)` validated (retention ∈ {0.85,0.9,0.95}; newPerDay ∈ {5,10,20}; remindAt `HH:MM`; direction ∈ {en_ru, ru_en, both}); `placementLevel(known: number)`.
- [ ] **Step 1:** Tests: `offset across midnight` (now 21:30 UTC, user 00:30 → 180); `negative offset` (10:00 UTC, user 05:00 → −300); `4am day boundary`; `lang detection`; `invalid retention rejected`; `placement levels 2/5/8/10 → A1/A2/B1/B2`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(users): onboarding, timezone, settings`.

### Task 8: Content — links, dictionary, LLM, add words, AI decks, limits

**Files:** Create `src/content/{links,dictionary,llm,service}.ts`, `src/entitlements/service.ts`, `test/content/*.test.ts`, `test/fixtures/dictionary-serendipity.json`.

**Interfaces:**
- Produces:
  - `parseWordsAndLinks(text: string, entities: MessageEntity[]) -> { items: {word: string; url: string|null}[]; orphanUrl: string|null }` — rules from spec §2.4: URLs from `url` entities (and raw `https?://` fallback), `text_link` on a word attaches its `url` to that word; same-line URL → that line’s word; standalone URL lines → applied to all words without a URL; message with only URLs → `items=[]`, `orphanUrl` = first; trailing `.,;:!?)` trimmed; non-http(s) or > 512 chars dropped; ≤ 20 items.
  - `DictionaryClient.lookup(word) -> {ipa, pos, exampleEn, audioUrl} | null` (`https://api.dictionaryapi.dev/api/v2/entries/en/{word}`, 5 s timeout, 404 → null).
  - `WordCardSchema` (zod): `word`, `ipa?`, `pos`, `translation` (non-empty, has Cyrillic), `exampleEn` (no Cyrillic), `exampleRu` (has Cyrillic).
  - `LlmClient.completeJson<T>(system, user, schema) -> T` — providers in order; HTTP error / timeout 20 s / bad JSON / schema fail → next; all fail → `LlmUnavailable`.
  - `ContentService.prepareAdd(user, text, entities, now) -> {kind:"ask-words"} | {kind:"preview"; previewId; items; duplicates: {word, deckTitle, linkAdded: boolean}[]; manual: string[]}` — uses pending URL if `items` came without links and pending is < 10 min old; duplicates get the link if they had none (no progress change).
  - `ContentService.confirmAdd(user, previewId)`, `editPreviewTranslation(user, previewId, text)`, `generateDeck(user, topic, n, now)` (n clamped 10..30, requires `entitlements.consume("gen")`), `confirmDeck(user, previewId)`.
  - `entitlements.consume(repo, user, "gen", now) -> boolean` (3 per local day).
- [ ] **Step 1:** Link tests (Review Focus 1): `same-line url attaches to that word`; `standalone url attaches to all words`; `text_link on word`; `url-only message returns orphanUrl`; `trailing punctuation trimmed`; `ftp and javascript: dropped`; `two urls on one line → first wins`.
- [ ] **Step 2:** Service tests (fetch mocked with `fetchMock` from vitest-pool-workers): `dictionary parses fixture`; `llm falls back on malformed json`; `llm rejects cyrillic in exampleEn`; `duplicate word in catalog deck not duplicated but gets link`; `pending url applied to next message words within 10 min, not after`; `gen limit 3 per local day`; `generateDeck clamps n`.
- [ ] **Step 3–5:** FAIL → implement → PASS.
- [ ] **Step 6:** Commit `feat(content): links, dictionary, LLM chain, custom words, AI decks`.

### Task 9: Audio

**Files:** Create `scripts/voice-decks.ts`, `.github/workflows/voice-decks.yml`, `scripts/csv-to-sql.ts`, `test/content/audio.test.ts`; Modify `src/content/service.ts` (enqueue `voice` job for custom words with `audioUrl`), `src/jobs/` handler registration.

**Interfaces:**
- `voice-decks.ts` (runs in GitHub Actions, manual dispatch): for each CSV row without `audio_file_id`: Piper → wav → `ffmpeg -c:a libopus -b:a 24k` → `sendVoice` to `ADMIN_TG_ID` → write `file_id` back to CSV; rate ≤ 20/s; resumable. `csv-to-sql.ts` → `migrations/0002_seed_catalog.sql` (idempotent `INSERT OR IGNORE`).
- Runtime job `voice {noteId, audioUrl}` → `sendVoice(ADMIN_TG_ID, audioUrl)` → `setNoteAudio(noteId, voice.file_id)`; on failure after 3 attempts note stays without audio.
- 🔊 callback `v:<noteId>` → `sendVoice(chat, file_id)`; bot deletes the previous voice message it sent in this chat (`sessions.last_voice_message_id`, created in Task 3) to keep the chat clean.
- [ ] **Step 1:** Tests: `voice job stores file_id`; `voice button sends by file_id and deletes previous voice`; `csv-to-sql escapes quotes`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(audio): prebuilt catalog voices and dictionary audio`.

### Task 10: Reminders (cron)

**Files:** Create `src/reminders/service.ts`, `src/tg/client.ts`, `test/reminders/service.test.ts`.

**Interfaces:**
- Produces: `tick(env, now) -> {sent: number}`:
  - Daily: active user, `localMinutes >= remindAt`, `last_daily_push_day != localDay`, due+new-left > 0 → send `⏰ …` with `▶ Начать` (`learn`), set `last_daily_push_day`. Missed ticks catch up; the mark prevents doubles.
  - Evening, step ping — rules from Global Constraints and spec §2.6 / §2.2.
  - At most 35 sends per tick, users ordered by `remind_at`, remainder next minute; claim and run due `jobs` within the same budget.
  - `TgClient.send(method, body)`: on 429 → enqueue `push` at `now + retry_after*1000`; on 403 → `users.active = 0`.
- [ ] **Step 1:** Tests: `missed tick sends exactly one daily push` (Review Focus 4: ticks at 08:58 and 09:01 local, then 09:02 → total 1); `no push when nothing due`; `evening only with streak ≥ 2`; `step ping once, not in quiet hours`; `35 sends cap, rest next tick`; `403 deactivates`; `429 reschedules`; `tick uses ≤ 10 D1 calls`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(reminders): cron reminders within free-tier budget`.

### Task 11: Bot wiring, stats, admin

**Files:** Create `src/bot/bot.ts`, `src/bot/handlers/*.ts`, `src/stats/service.ts`, `src/admin/service.ts`, `scripts/set-webhook.ts`, `test/bot/handlers.test.ts`, `test/stats/service.test.ts`; Modify `src/index.ts`.

**Interfaces:**
- `index.ts`: `fetch` — `POST /tg/<any>` with header `X-Telegram-Bot-Api-Secret-Token === WEBHOOK_SECRET` else 401; `webhookCallback(bot, "cloudflare-mod")`; `scheduled` → `reminders.tick`. Bot instance and FSRS schedulers created once per isolate.
- Commands: `/start /learn /decks /gen /stats /settings /undo /help`, `setMyCommands` for ru/en in `set-webhook.ts`.
- Callbacks: `learn`, `g:…`, `u`, `v:<noteId>`, `ob:<step>:<value>`, `set:<key>`, `sub:<deckId>`, `add:ok|edit|no:<previewId>`, `gen:ok|no:<previewId>`.
- Text (onboarding finished, not a command) → `prepareAdd` (reply “Ищу…”, heavy work in `ctx.waitUntil`, then edit that message with the preview).
- Session message: edit `sessions.message_id`; “message is not modified” ignored; “message to edit not found” → send new and save id; when other messages were sent after it, send a new session message and edit the old one to `Сессия продолжается ниже ↓`.
- Error boundary: any D1 error whose message contains `daily row` → reply `t("maintenance")` and return 200 (Review Focus 5); other errors logged, 200 returned (Telegram must not retry).
- `stats.cumulative(repo, user, now) -> { streak; learned; known; learning; new; reviewsTotal; reviews30; retention30; forecast7: number[] }`; view renders it as text.
- `admin`: `/admin stats` (active today, reviews today, `usage_daily` vs limits in %), CSV document upload with caption `deck: <title_ru> | <title_en> | <level>`; when `rows_written_est` crosses 80 % of 100 000, one message to admin per day.
- [ ] **Step 1:** Handler tests (grammY with `fakeTelegram` transformer): `start runs onboarding to first card`; `grade edits same message and shows feedback`; `text with link → preview shows 🔗 host`; `url-only message asks for words`; `stale button answers callback with toast`; `D1 limit error → maintenance reply and 200`; `bad secret → 401`.
- [ ] **Step 2:** Stats test: `cumulative totals by stage and retention30`.
- [ ] **Step 3–5:** FAIL → implement → PASS.
- [ ] **Step 6:** Commit `feat(bot): webhook, handlers, stats, admin`.

### Task 12: Decks, deploy, backups, end-to-end

**Files:** Create `scripts/build-decks.ts`, `data/decks/*.csv`, `data/decks/index.json`, `.github/workflows/{deploy.yml,backup.yml}`, `README.md`, `test/e2e/scenario.test.ts`.

**Interfaces:**
- `build-decks.ts --deck a1 --n 500` — frequency list + `LlmClient` + `DictionaryClient`, resumable, rows validated with `WordCardSchema`. Sizes: A1 500, A2 500, B1 600, B2 600, travel 250, it_work 300, phrases 250.
- `deploy.yml` on push to `main`: `pnpm test`, `wrangler d1 migrations apply DB --remote`, `wrangler deploy` (secret `CLOUDFLARE_API_TOKEN`). `backup.yml` weekly: `wrangler d1 export DB --remote --output backup.sql` → upload artifact (retention 90 days).
- README (Russian): create Cloudflare account (free, no card), create D1, `wrangler secret put …`, get bot token from @BotFather, Groq and OpenRouter keys, `pnpm set-webhook`, run `voice-decks` workflow once.
- [ ] **Step 1:** E2E `first day and next day`: onboarding → 10 grades (mix Good/Again) → Again card returns → done screen shows `Сегодня:` and totals → next day 09:00 local exactly one push → `/learn` card shows larger `память` than yesterday for a word graded Good twice.
- [ ] **Step 2:** FAIL → implement glue → PASS; `pnpm test --coverage` overall ≥ 70 %.
- [ ] **Step 3:** Build decks, spot-check 30 random rows per deck (translation correct, example natural), commit CSV and generated seed SQL.
- [ ] **Step 4:** Deploy to a test bot; smoke: onboarding, one card shows spoiler + 2×2 buttons `Снова <1м / Трудно <6м / Хорошо <10м / Легко 8д`, add `resilient https://example.com/article` → card shows `🔗 example.com`.
- [ ] **Step 5:** Commit `feat: decks, deploy pipeline, backups, e2e`.

# SRS Telegram Bot — MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chat-only Telegram bot that teaches English words to Russian speakers with FSRS-6 spaced repetition, 4 Anki-style buttons, learning steps, catalog/AI/custom decks and daily reminders, running on one 2 GB VPS.

**Architecture:** One asyncio Python process (aiogram 3 long polling + minute-tick scheduler + Postgres-backed job runner) plus PostgreSQL 16, in Docker Compose. Layered modules: `bot` (handlers/views) → application services (`review`, `content`, `reminders`, `stats`, `users`, `entitlements`) → pure domain `srs` → infra adapters (`db`, `jobs`, `llm`, `dictionary`, `tts`). Layer rules enforced by import-linter.

**Tech Stack:** Python 3.12, aiogram 3.x (Bot API ≥ 9.4), `fsrs` (py-fsrs, FSRS-6), SQLAlchemy 2 async + asyncpg, Alembic, pydantic 2 + pydantic-settings, httpx, piper-tts, fluent.runtime (i18n), pytest + pytest-asyncio + testcontainers[postgres], ruff, import-linter, uv.

**Spec:** `docs/superpowers/specs/2026-09-29-srs-telegram-bot-design.md`

## Global Constraints

- Python 3.12; all datetimes are timezone-aware UTC (`datetime.now(UTC)`); py-fsrs is UTC-only.
- Every service function that reads "now" takes `now: datetime` as a parameter — no `datetime.now()` outside `app/main.py` and `app/clock.py`.
- FSRS: default FSRS-6 parameters; `learning_steps=(1m, 10m)`, `relearning_steps=(10m,)`, `maximum_interval=36500`, `enable_fuzzing=True`; `desired_retention` ∈ {0.85, 0.90, 0.95}, default 0.90.
- Day boundary: 04:00 user-local time.
- Quiet hours 23:00–08:00 local: no pings except the user's own `remind_at` push.
- Evening streak push at 20:00 local, only if not studied today and `streak >= 2`.
- Button colors (Bot API `style`): Again=`danger`, Hard=no style, Good=`success`, Easy=`primary`; label prefix emoji fallback 🟥⬛🟩🟦 is always present in text.
- Callback data grade format: `g:<card_id>:<reps>:<rating>` (≤ 64 bytes).
- Limits: `/gen` 3 per user per day; add-word list ≤ 20 lines; AI deck 10–30 words; broadcast ≤ 25 msg/s.
- Performance: grade → next card ≤ 300 ms p95 (excluding Telegram network).
- i18n: every user-facing string lives in `app/locales/{ru,en}/main.ftl`; no literals in handlers.
- LLM: OpenAI-compatible chat API; providers tried in order from `LLM_PROVIDERS` (default: Groq `https://api.groq.com/openai/v1`, then OpenRouter `https://openrouter.ai/api/v1` free model). Response must validate against a pydantic schema or it counts as failure.
- Config via `.env`: `BOT_TOKEN`, `DATABASE_URL`, `ADMIN_TG_ID`, `LLM_PROVIDERS` (JSON list of `{base_url, api_key, model}`), `PIPER_VOICE=en_US-lessac-medium`.
- Coverage: ≥ 90% for `app/srs` and `app/review`, ≥ 70% overall.

## Review Focus

1. **User answers "what time is it now" across midnight** (e.g. user local 00:30, server UTC 21:30 previous day) → offset must come out as +03:00, not −21:00. Test in Task 7.
2. **Stale button on an old message after a session restarted or after `/undo`** → must be ignored, never grade the card twice. Test in Task 6.
3. **User adds a word that already exists in "Мои слова" or in a subscribed catalog deck** → no duplicate card; bot says it's already being learned. Test in Task 8.
4. **LLM returns malformed JSON / Russian text in the English field / empty translation** → treated as provider failure, next provider tried, then manual-input fallback. Test in Task 8.
5. **Scheduler tick missed (process restart at 08:59, back at 09:02)** → the 09:00 reminder is still sent once, not zero or twice. Test in Task 10.

---

## File Structure

```
pyproject.toml, uv.lock, .env.example, Dockerfile, docker-compose.yml, deploy.sh, README.md
.importlinter, .github/workflows/ci.yml
alembic.ini, migrations/env.py, migrations/versions/0001_initial.py
app/
  main.py            # wiring: bot, dispatcher, scheduler loop, job runner
  config.py          # Settings (pydantic-settings)
  clock.py           # now() -> datetime (UTC); patched in tests
  srs/scheduler.py   # FSRS wrapper: preview, grade, format_interval
  db/models.py       # SQLAlchemy models (spec §4)
  db/session.py      # engine + async_sessionmaker
  jobs/queue.py      # enqueue, claim, complete, fail (SKIP LOCKED)
  jobs/runner.py     # registry + run loop
  users/service.py   # onboarding state, tz offset, settings, local-day helpers
  users/placement.py # 10-word level test
  review/queue.py    # choose next card (pure, given candidate lists)
  review/service.py  # start/show/grade/undo, session persistence
  content/catalog.py # load CSV decks, subscribe user
  content/dictionary.py # Free Dictionary API adapter
  content/llm.py     # provider-chain OpenAI-compatible client + schemas
  content/service.py # add words, AI deck generation
  entitlements/service.py # per-day limits
  tts/piper.py       # synth(text) -> ogg bytes
  tts/jobs.py        # job: synth + sendVoice + store file_id
  reminders/service.py # due computations per tick
  reminders/jobs.py  # send push jobs, 429/403 handling
  stats/service.py   # text stats
  admin/service.py   # /admin stats, CSV deck upload, backup job
  bot/views.py       # render card/front/back/keyboards/menus
  bot/i18n.py        # fluent loader, t(lang, key, **kw)
  bot/handlers/{start,learn,words,decks,settings,stats,admin}.py
  locales/ru/main.ftl, locales/en/main.ftl
data/decks/{a1,a2,b1,b2,travel,it_work,phrases}.csv
scripts/build_decks.py
tests/  (mirrors app/; tests/conftest.py provides pg container, session, fake_bot, frozen clock)
```

CSV deck format (header): `word,ipa,pos,translation,example_en,example_ru`. Deck metadata in `data/decks/index.json`: `[{"file","title_ru","title_en","level"}]`.

---

### Task 1: Project skeleton, config, CI

**Files:**
- Create: `pyproject.toml`, `.env.example`, `Dockerfile`, `docker-compose.yml`, `.importlinter`, `.github/workflows/ci.yml`, `app/config.py`, `app/clock.py`, `tests/conftest.py`, `tests/test_config.py`

**Interfaces:**
- Produces: `Settings` with fields `bot_token: str`, `database_url: str`, `admin_tg_id: int`, `llm_providers: list[LLMProvider]` (`base_url`, `api_key`, `model`), `piper_voice: str = "en_US-lessac-medium"`; `get_settings() -> Settings` (cached). `clock.now() -> datetime` (UTC). Fixtures: `pg_url` (session-scoped testcontainers Postgres 16), `db` (AsyncSession, rolled back per test), `frozen_now` (monkeypatches `app.clock.now`).

- [ ] **Step 1:** Write `tests/test_config.py::test_llm_providers_parsed_from_json_env` — set `LLM_PROVIDERS='[{"base_url":"https://api.groq.com/openai/v1","api_key":"k","model":"m"}]'`, assert `get_settings().llm_providers[0].model == "m"`.
- [ ] **Step 2:** Run `uv run pytest tests/test_config.py -v` → FAIL (module missing).
- [ ] **Step 3:** Implement `app/config.py`, `app/clock.py`; `pyproject.toml` with deps from Tech Stack, ruff, pytest (`asyncio_mode=auto`), coverage config. `.importlinter` layers contract: `app.bot` > `app.review | app.content | app.reminders | app.stats | app.users | app.entitlements | app.admin | app.tts` > `app.srs` ; `app.srs` must not import `app.db`, `aiogram`, `httpx`. `docker-compose.yml`: services `db` (postgres:16, volume, healthcheck) and `app` (build ., `restart: always`, `depends_on: db healthy`, command `sh -c "alembic upgrade head && python -m app.main"`). CI: `uv sync`, `ruff check`, `lint-imports`, `pytest --cov`.
- [ ] **Step 4:** Run `uv run pytest -v && uv run ruff check . && uv run lint-imports` → all pass.
- [ ] **Step 5:** Commit `chore: project skeleton, config, CI`.

### Task 2: SRS domain (FSRS wrapper)

**Files:**
- Create: `app/srs/scheduler.py`, `tests/srs/test_scheduler.py`

**Interfaces:**
- Produces:
  - `@dataclass(frozen=True) class MemoryState: state: str  # "new"|"learning"|"review"|"relearning"; step: int | None; stability: float | None; difficulty: float | None; due: datetime; last_review: datetime | None; reps: int; lapses: int`
  - `new_state(now: datetime) -> MemoryState`
  - `grade(s: MemoryState, rating: int, now: datetime, retention: float) -> MemoryState` (rating 1..4; increments `reps`; `lapses += 1` when rating==1 from `review`)
  - `preview(s: MemoryState, now: datetime, retention: float) -> dict[int, datetime]` (due for each rating; fuzz disabled for preview so labels are stable)
  - `format_interval(delta: timedelta, lang: str) -> str`
- "new" maps to a py-fsrs `Card()` that has never been reviewed; after first grade state is taken from py-fsrs `State`.

- [ ] **Step 1:** Write tests:
  - `test_new_card_preview_matches_anki_screenshot`: `preview(new_state(T), T, 0.9)`; assert `format_interval(due[1]-T,"en")=="<1m"`, `due[2]-T == 6min` → `"<6m"`, `due[3]-T == 10min` → `"<10m"`, `format_interval(due[4]-T,"en")` ends with `"d"` and `(due[4]-T).days` in range(1, 6).
  - `test_good_twice_graduates_to_days`: Good at T, Good at T+10m → `state=="review"`, `due - now >= timedelta(days=1)`.
  - `test_again_on_review_card_goes_relearning_10m`: build review state (Good, Good, advance to due, Good), then Again → `state=="relearning"`, `lapses==1`, preview/`due-now == 10min`.
  - `test_higher_retention_gives_shorter_interval`: same history, interval at 0.95 < at 0.85.
  - `test_format_interval_ru`: 45s→`"<1м"`, 6min→`"6м"`, 1d→`"1д"`, 70d→`"2,3мес"`, 400d→`"1,1г"`; en: `"<1m","6m","1d","2.3mo","1.1y"`. Rule: `<1m` below 60s; minutes rounded; hours `"ч"/"h"` below 1 day; days below 30; months = days/30 one decimal; years = days/365 one decimal.
  - `test_preview_labels_learning_minutes_use_lt_prefix`: for state "new"/"learning" minute labels are prefixed `<` (Anki style), for "review" they are not. (`format_interval` takes `approx: bool = False`; `views` passes `approx=True` for learning states.)
- [ ] **Step 2:** Run `uv run pytest tests/srs -v` → FAIL.
- [ ] **Step 3:** Implement with `fsrs.Scheduler(desired_retention=r, learning_steps=(timedelta(minutes=1), timedelta(minutes=10)), relearning_steps=(timedelta(minutes=10),), maximum_interval=36500, enable_fuzzing=...)`; cache one scheduler per `(retention, fuzz)`. Convert `MemoryState` ↔ `fsrs.Card` in two private functions. If py-fsrs "Hard" on first learning step returns something other than 6 min, the test is the source of truth for the Anki behavior: Hard on step 0 = average of step 0 and step 1 = 5.5 → labelled `<6m`; assert the label, not the exact minute.
- [ ] **Step 4:** Run `uv run pytest tests/srs -v --cov=app/srs` → PASS, coverage ≥ 90%.
- [ ] **Step 5:** Commit `feat(srs): FSRS-6 wrapper with Anki learning steps`.

### Task 3: Database schema

**Files:**
- Create: `app/db/models.py`, `app/db/session.py`, `alembic.ini`, `migrations/env.py`, `migrations/versions/0001_initial.py`, `tests/db/test_schema.py`

**Interfaces:**
- Produces: models `User, Deck, Note, UserDeck, Card, ReviewLog, Session, Job` exactly as spec §4, plus `users.onboarding_step: str | None`, `users.gens_today: int`, `users.gens_date: date | None`, `users.autoplay: bool = False`, `cards.hidden_until_day: date | None` (sibling burying), `review_log.undone: bool = False`. `get_sessionmaker(url) -> async_sessionmaker`. Enums as `String` with CHECK constraints (keeps migrations simple).

- [ ] **Step 1:** Tests: `test_migration_upgrade_downgrade` (alembic upgrade head → downgrade base → upgrade head on the container); `test_card_unique_per_user_note_direction` (second insert raises `IntegrityError`); `test_note_unique_per_deck_word`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement models + hand-written migration `0001_initial` with the indexes from spec §4.
- [ ] **Step 4:** Run `uv run pytest tests/db -v` → PASS.
- [ ] **Step 5:** Commit `feat(db): initial schema`.

### Task 4: Postgres job queue

**Files:**
- Create: `app/jobs/queue.py`, `app/jobs/runner.py`, `tests/jobs/test_queue.py`

**Interfaces:**
- Produces: `async enqueue(db, kind: str, payload: dict, run_at: datetime, dedup_key: str | None = None) -> int | None` (returns None if a not-done job with same `dedup_key` exists; add `jobs.dedup_key` unique partial index `WHERE done_at IS NULL` in migration 0002). `async claim(db, now, limit=10) -> list[Job]` (`FOR UPDATE SKIP LOCKED`, sets `locked_at`, skips jobs locked < 5 min ago). `async complete(db, job_id)`; `async fail(db, job_id, error: str, now)` (retry with backoff 30s·2^attempts, give up after 3 attempts → `done_at` set, `error` kept). `Runner.register(kind: str, handler: Callable[[dict], Awaitable[None]])`; `async Runner.run_once(now) -> int` (jobs processed).

- [ ] **Step 1:** Tests: `test_two_concurrent_claimers_never_get_same_job` (two sessions claim concurrently, disjoint ids); `test_failed_job_retried_then_abandoned_after_3`; `test_dedup_key_prevents_duplicate_pending_job`; `test_future_job_not_claimed`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement + migration `0002_jobs_dedup`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(jobs): postgres-backed job queue`.

### Task 5: i18n and views

**Files:**
- Create: `app/bot/i18n.py`, `app/bot/views.py`, `app/locales/{ru,en}/main.ftl`, `tests/bot/test_i18n.py`, `tests/bot/test_views.py`

**Interfaces:**
- Consumes: `srs.preview`, `srs.format_interval`.
- Produces: `t(lang: str, key: str, **kw) -> str`. `@dataclass class CardView: word, ipa, pos, translation, example_en, example_ru, has_audio: bool, card_id: int, reps: int, state: str`. `render_front(v: CardView, lang, counts: tuple[int,int,int]) -> tuple[str, InlineKeyboardMarkup]` (counts = new/learning/review, shown as `🔵 3 · 🔴 1 · 🟢 12` like AnkiDroid). `render_back(v, lang, intervals: dict[int, str], counts) -> tuple[str, InlineKeyboardMarkup]` — one row of 4 buttons, text `"🟥 <1м\nСнова"` style (`"{emoji} {interval} · {label}"`), `style` per Global Constraints, callback `g:{card_id}:{reps}:{rating}`; second row `🔊` (if has_audio) and `↩️` undo. `render_wait(seconds: int, lang) -> (text, kb)` with `now:` button "Показать сейчас". `render_session_done(lang, reviewed: int, next_due_label: str | None)`.

- [ ] **Step 1:** Tests: `test_all_keys_present_in_both_locales` (parse both ftl files, key sets equal); `test_back_keyboard_styles_and_callbacks` (4 buttons, styles `["danger", None, "success", "primary"]`, callback `g:7:3:1`…`g:7:3:4`, each ≤ 64 bytes); `test_front_escapes_html` (word `"<b>"` rendered escaped, parse_mode HTML).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. aiogram's `InlineKeyboardButton` accepts `style` in versions supporting Bot API 9.4; if the pinned aiogram lacks it, subclass `InlineKeyboardButton` with `style: str | None = None` (pydantic extra field) — decide at implementation, test asserts the serialized JSON contains `"style":"danger"`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(bot): i18n and card views`.

### Task 6: Review service (session, queue, grading, undo)

**Files:**
- Create: `app/review/queue.py`, `app/review/service.py`, `tests/review/test_queue.py`, `tests/review/test_service.py`

**Interfaces:**
- Consumes: models (Task 3), `srs.grade/preview/new_state` (Task 2), `users.service.local_day(user, now) -> date` (Task 7 — implement `local_day` here first if Task 7 not done; it lives in `app/users/service.py`: `local_day(tz_offset_min: int, now: datetime) -> date` with 04:00 boundary).
- Produces:
  - `pick_next(learning_due: list[CardRow], review_due: list[CardRow], new: list[NoteRow], new_left: int, rng: Random) -> Pick | None` (pure). Order: learning with `due <= now` first (earliest due); then interleave review and new so new cards are spread evenly (one new per `ceil(len(review)/new_left)` reviews); `Pick(kind: "card"|"new", id: int)`.
  - `next_learning_due(db, user_id) -> datetime | None`
  - `async start_or_resume(db, user_id, now) -> Screen`
  - `async show_answer(db, user_id, card_id, now) -> Screen`
  - `async grade(db, user_id, card_id, reps: int, rating: int, now, duration_ms: int) -> Screen` — ignores (returns `Screen(kind="stale")`) when `reps` ≠ current; single transaction: srs.grade → insert ReviewLog → update Card → update `users.streak/last_study_date` (streak +1 if last day was yesterday-local, reset to 1 if gap, unchanged if today) → sibling bury: other direction card of same note gets `hidden_until_day = local_day + 1` when both directions enabled.
  - `async undo(db, user_id, now) -> Screen` — restores card fields from the last non-undone ReviewLog's `state_before` (store full `MemoryState` JSON in `review_log.state_before`), marks log `undone=True`; only the last one (repeated undo → "nothing to undo").
  - `Screen(kind: "front"|"back"|"wait"|"done"|"stale"|"empty", view: CardView | None, intervals: dict[int,str] | None, wait_seconds: int | None, counts: tuple[int,int,int])`.
  - New cards: row in `cards` created on first pick (`new_state(now)`), counts toward daily `new_per_day` (count ReviewLog of state_before=="new" for local day).
  - Wait rule: nothing to show and `next_learning_due - now < 60s` → `wait`; else `done`.

- [ ] **Step 1:** Queue tests (pure): `test_due_learning_first`; `test_new_spread_among_reviews` (10 reviews, new_left 5 → new at every 2nd position); `test_respects_new_limit_zero`.
- [ ] **Step 2:** Service tests with `frozen_now`:
  - `test_full_learning_cycle`: start → front new card → show_answer intervals `{1:"<1м",2:"<6м",3:"<10м",4:"4д"}`-shaped (assert first three exactly, fourth endswith `"д"`) → grade Again → next screen is `wait` if no other cards (wait ≈ 60s) → advance clock 61s → same card front again.
  - `test_stale_callback_ignored` (Review Focus 2): grade with reps=0 twice → second returns `stale`, exactly one ReviewLog; after `undo`, pressing the old button with reps=1 → `stale`.
  - `test_undo_restores_previous_state_and_streak_not_double_counted`.
  - `test_sibling_buried_next_day` (direction both).
  - `test_daily_new_limit_counts_local_day_with_4am_boundary`: user +03:00, new_per_day=2; 2 new at 03:30 local, at 03:50 local no new; at 04:10 local new allowed again.
  - `test_grade_transaction_rolls_back_on_error` (monkeypatch ReviewLog insert to raise → card unchanged).
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Run `uv run pytest tests/review -v --cov=app/review` → PASS, ≥ 90%.
- [ ] **Step 6:** Commit `feat(review): session queue, grading, undo`.

### Task 7: Users, onboarding, placement, settings

**Files:**
- Create: `app/users/service.py`, `app/users/placement.py`, `tests/users/test_service.py`, `tests/users/test_placement.py`

**Interfaces:**
- Produces: `local_day(tz_offset_min, now) -> date`; `local_time(tz_offset_min, now) -> time`; `offset_from_reported_hour(reported_hour: int, reported_minute_bucket: int, now: datetime) -> int` (returns minutes in [-720, +840], rounded to 30 min, choosing the offset that is closest to zero modulo 24h — handles midnight wrap); `async get_or_create(db, tg_id, tg_lang: str | None, now) -> User` (lang "ru" if tg_lang startswith "ru" or "uk"/"be"/"kk", else "en"); `async set_setting(db, user_id, key: Literal["lang","retention","new_per_day","remind_at","direction","autoplay"], value)` with validation (autoplay: bool — when true, `views`/handlers send the voice together with the front side; column `users.autoplay` is part of Task 3's initial schema) (retention ∈ {0.85,0.9,0.95}; new_per_day ∈ {5,10,20}; direction ∈ {"en_ru","ru_en","both"}); onboarding steps `"lang" → "placement" → "goal" → "remind" → "tz" → "deck" → None`, `async advance_onboarding(db, user, answer: str, now) -> str | None`. `placement.WORDS: list[tuple[str, int]]` (10 words, frequency rank), `placement.level(known: set[str]) -> Literal["A1","A2","B1","B2"]` (known count 0–2 A1, 3–5 A2, 6–8 B1, 9–10 B2).
- [ ] **Step 1:** Tests: `test_offset_midnight_wrap` (Review Focus 1: now 21:30 UTC, user says 00:30 → +180); `test_offset_negative` (now 10:00 UTC, user says 05:00 → −300); `test_local_day_4am_boundary`; `test_lang_detection`; `test_setting_validation_rejects_bad_retention`; `test_placement_levels`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(users): onboarding, timezone, settings`.

### Task 8: Content — catalog, dictionary, LLM, add word, AI decks, limits

**Files:**
- Create: `app/content/catalog.py`, `app/content/dictionary.py`, `app/content/llm.py`, `app/content/service.py`, `app/entitlements/service.py`, `tests/content/test_*.py`, `tests/entitlements/test_service.py`, `tests/fixtures/dictionary_serendipity.json`

**Interfaces:**
- Produces:
  - `async load_catalog(db, dir: Path) -> int` — idempotent upsert of decks/notes from `data/decks` (by `(deck title_en)` and `(deck_id, word)`).
  - `async subscribe(db, user_id, deck_id)`.
  - `class DictionaryClient: async lookup(word: str) -> DictEntry | None` (`https://api.dictionaryapi.dev/api/v2/entries/en/{word}`; `DictEntry(ipa, pos, example_en, audio_url)`; 404 → None; 5s timeout).
  - `class WordCard(BaseModel): word: str; ipa: str | None; pos: str; translation: str (non-empty, contains Cyrillic); example_en: str (no Cyrillic); example_ru: str (contains Cyrillic)`.
  - `class LLMClient(providers): async complete_json(system: str, user: str, schema: type[T]) -> T` — tries providers in order; any HTTP error, timeout (20s), JSON parse error or validation error → next provider; all fail → `LLMUnavailable`.
  - `async build_word_cards(words: list[str], dict_client, llm) -> list[WordCard | ManualNeeded]` — one LLM call for the whole batch (`{"cards":[WordCard...]}`), dictionary fills ipa/pos when LLM omits.
  - `async add_words(db, user_id, cards: list[WordCard]) -> AddResult(added: list[str], duplicates: list[str])` — dedupe against user's "Мои слова" and every subscribed deck (case-insensitive, trimmed).
  - `async generate_deck(db, user_id, topic: str, n: int, llm, now) -> DeckPreview` — n clamped to 10..30; creates `Deck(kind="ai", owner_id=user)` only on confirm via `confirm_ai_deck(db, user_id, preview_id) -> int`. Previews (both AI decks and add-word previews) are stored in table `previews(id, user_id, kind, payload JSONB, created_at)` — migration `0003_previews`; previews older than 24 h are ignored.
  - `entitlements.check_and_consume(db, user_id, feature: Literal["gen"], now) -> bool` (3/day per local day).
- [ ] **Step 1:** Tests (httpx mocked with `respx`): `test_dictionary_parses_fixture`; `test_llm_falls_back_on_malformed_json` (Review Focus 4: provider 1 returns `"not json"`, provider 2 valid → result from 2); `test_llm_rejects_cyrillic_in_example_en`; `test_llm_all_fail_raises`; `test_add_word_duplicate_in_catalog_deck` (Review Focus 3: user subscribed to A1 containing "apple", adds " Apple " → duplicates==["apple"], no new note); `test_load_catalog_idempotent`; `test_gen_limit_3_per_day_resets_at_local_4am`; `test_generate_deck_clamps_n`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(content): catalog, dictionary, LLM chain, add words, AI decks`.

### Task 9: TTS

**Files:**
- Create: `app/tts/piper.py`, `app/tts/jobs.py`, `tests/tts/test_jobs.py`
- Modify: `Dockerfile` (download Piper voice `en_US-lessac-medium` into `/models` at build), `app/review/service.py` (enqueue `tts` job with `dedup_key=f"tts:{note_id}"` when showing a note with `audio_file_id IS NULL`)

**Interfaces:**
- Produces: `class Synth(Protocol): def synth(text: str) -> bytes` (OGG/Opus); `PiperSynth(model_path)` (wav via piper → ogg via `ffmpeg -c:a libopus`); job handler `tts_job(payload={"note_id", "chat_id"})` → `bot.send_voice(ADMIN_TG_ID or chat, BufferedInputFile)` → store `voice.file_id` in `notes.audio_file_id`. Uploading once to the admin chat keeps user chats clean; afterwards `🔊` sends by `file_id`.
- [ ] **Step 1:** Tests with fake synth + fake bot: `test_tts_job_stores_file_id`; `test_tts_job_skips_if_already_has_audio`; `test_showing_card_enqueues_tts_once`.
- [ ] **Step 2–4:** FAIL → implement → PASS. Manual check: `docker compose run app python -c "from app.tts.piper import PiperSynth; open('/tmp/x.ogg','wb').write(PiperSynth('/models/en_US-lessac-medium.onnx').synth('serendipity'))"` produces a playable file.
- [ ] **Step 5:** Commit `feat(tts): piper voice with file_id caching`.

### Task 10: Reminders

**Files:**
- Create: `app/reminders/service.py`, `app/reminders/jobs.py`, `tests/reminders/test_service.py`, `tests/reminders/test_jobs.py`
- Modify: migration `0004_reminder_marks` adds `users.last_daily_push_day: date | None`, `users.last_evening_push_day: date | None`, `users.last_step_ping_at: timestamptz | None`

**Interfaces:**
- Produces: `async tick(db, now) -> int` (enqueues push jobs; returns count). Rules:
  - Daily: user active, `local_time >= remind_at`, `last_daily_push_day != local_day`, due count (learning+review due by end of local day + min(new_left, available new)) > 0 → enqueue `push_daily` with `dedup_key=f"daily:{user_id}:{local_day}"`, set `last_daily_push_day`. Catch-up: if tick missed, the condition `>=` still fires on next tick, and the mark prevents a second send (Review Focus 5).
  - Evening: `local_time >= 20:00`, not studied today, `streak >= 2`, `last_evening_push_day != local_day`, not in quiet hours.
  - Step ping: user has learning/relearning cards with `due <= now`, last review > 3 min ago, `last_step_ping_at` is None or < last_review, not quiet hours → one ping.
  - `push_*` job handlers: send message with `Начать` button (`learn:start`); on `TelegramRetryAfter` re-enqueue at `now + retry_after`; on `TelegramForbiddenError` set `users.active=False`. Runner processes at most 25 push jobs per second (token bucket in `Runner`).
- [ ] **Step 1:** Tests: `test_daily_push_sent_once_after_missed_tick` (ticks at 08:58 and 09:02 local, remind_at 09:00 → exactly one job; third tick 09:03 → none); `test_no_daily_push_when_nothing_due`; `test_evening_push_only_with_streak`; `test_step_ping_once_and_not_in_quiet_hours`; `test_forbidden_deactivates_user`; `test_retry_after_reschedules`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(reminders): daily, evening and learning-step pushes`.

### Task 11: Handlers and app wiring

**Files:**
- Create: `app/bot/handlers/{start,learn,words,decks,settings,stats}.py`, `app/stats/service.py`, `app/main.py`, `tests/bot/test_handlers.py`

**Interfaces:**
- Consumes: all services above.
- Produces:
  - Commands: `/start`, `/learn`, `/decks`, `/gen <тема>`, `/stats`, `/settings`, `/undo`, `/help`; bot menu commands set via `set_my_commands` for ru and en.
  - Callback prefixes: `learn:start`, `a:<card_id>` (show answer), `g:…` (grade), `u` (undo), `v:<note_id>` (voice), `now` (show waiting card), `ob:<step>:<value>` (onboarding), `set:<key>:<value>`, `deck:sub:<id>`, `add:ok|edit|no:<preview_id>`, `gen:ok|no:<preview_id>`.
  - Plain text (not a command, onboarding finished) → add-words flow (split lines, ≤ 20).
  - Session message: always edit `sessions.message_id`; on `TelegramBadRequest` ("message is not modified" → ignore; "message to edit not found" / older than 48h → send new message and store its id).
  - `stats.text_stats(db, user_id, now) -> Stats(streak, learned (state review with stability ≥ 21d), due_today, reviews_30d, retention_30d (share of rating>1 on review-state logs))`.
  - `main.py`: build Bot/Dispatcher, register routers, `load_catalog` at startup, background tasks `scheduler_loop` (every 60 s aligned to minute: `reminders.tick`) and `runner_loop` (every 1 s `Runner.run_once`), `dp.start_polling(allowed_updates=["message","callback_query"])`, graceful shutdown on SIGTERM.
- [ ] **Step 1:** Tests using aiogram test utilities with a fake session (`MockedBot` pattern: capture requests, return canned responses): `test_start_runs_onboarding_to_first_card`; `test_grade_callback_edits_same_message`; `test_text_message_triggers_add_words_preview`; `test_edit_failure_sends_new_message`; `test_stats_text`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(bot): handlers and application wiring`.

### Task 12: Admin, backups, deck data, deploy

**Files:**
- Create: `app/admin/service.py`, `app/bot/handlers/admin.py`, `scripts/build_decks.py`, `data/decks/*.csv`, `data/decks/index.json`, `deploy.sh`, `README.md`, `tests/admin/test_service.py`, `tests/e2e/test_scenario.py`

**Interfaces:**
- Produces: admin-only (tg_id == ADMIN_TG_ID) `/admin stats` (DAU, reviews 24h, new users 24h, failed jobs 24h); document upload of `*.csv` with caption `deck: <title_ru> | <title_en> | <level>` → `load_deck_csv`; daily 03:00 UTC `backup` job: `pg_dump --format=custom | gzip` → `send_document` to admin (Telegram 50 MB bot upload limit — if larger, split into 45 MB parts). `scripts/build_decks.py --level A1 --n 500 --out data/decks/a1.csv` uses `LLMClient` + `DictionaryClient`, resumes from existing CSV, writes rows that validate as `WordCard`.
- Deck sizes: A1 500, A2 500, B1 600, B2 600, travel 250, it_work 300, phrases 250 (≈ 3 000).
- [ ] **Step 1:** Tests: `test_non_admin_cannot_use_admin_commands`; `test_csv_upload_loads_deck`; `test_backup_splits_large_dump` (fake dump 100 MB → 3 parts).
- [ ] **Step 2:** E2E scenario `tests/e2e/test_scenario.py::test_first_day_and_next_day` (spec §8): onboarding → 10 cards graded Good/Again mix → Again card reappears after 61 s → next day 09:00 local exactly one push → `/learn` shows due reviews.
- [ ] **Step 3–4:** FAIL → implement → PASS; run `uv run pytest --cov` → overall ≥ 70%.
- [ ] **Step 5:** Generate decks: `uv run python scripts/build_decks.py --all`; spot-check 30 random rows per deck by hand (translation correct, example natural). Commit data.
- [ ] **Step 6:** `deploy.sh`: ssh-less, run on VPS — `git pull && docker compose up -d --build && docker compose logs --tail=50 app`. README: VPS setup (Ubuntu 24.04, Docker install, `.env` fill-in with @BotFather token, Groq key, OpenRouter key, admin id via @userinfobot).
- [ ] **Step 7:** Smoke on a real test bot: `/start` → full onboarding → 5 cards → buttons colored, intervals `<1м <6м <10м 4д` on a new card.
- [ ] **Step 8:** Commit `feat: admin, backups, decks, deploy`.

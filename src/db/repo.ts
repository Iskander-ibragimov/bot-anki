import type { CardState, Mem } from "../srs/fsrs";

export type Lang = "ru" | "en";
export type Direction = "en_ru" | "ru_en";
export type DirectionSetting = Direction | "both";
/** Order of new words: deck by deck, or mixed across all of the user's decks. */
export type NewOrder = "deck" | "random";

export interface User {
  id: number;
  tgId: number;
  chatId: number;
  lang: Lang;
  tzOffsetMin: number;
  remindAt: string;
  newPerDay: number;
  retention: number;
  direction: DirectionSetting;
  autoplay: boolean;
  level: string | null;
  streak: number;
  lastStudyDay: string | null;
  active: boolean;
  onboardingStep: string | null;
  onboardingData: string | null;
  gensDay: string | null;
  gensCount: number;
  pendingUrl: string | null;
  pendingUrlAt: number | null;
  pendingEdit: string | null;
  lastDailyPushDay: string | null;
  lastEveningPushDay: string | null;
  lastStepPingAt: number | null;
  lastReviewAt: number | null;
  mixCounter: number;
  createdAt: number;
  nextDailyAt: number | null;
  nextEveningAt: number | null;
  newOrder: NewOrder;
}

export interface NoteFields {
  word: string;
  ipa: string | null;
  pos: string;
  translation: string;
  exampleEn: string;
  exampleRu: string;
  audioFileId: string | null;
  audioUrl: string | null;
  sourceUrl: string | null;
  /** The user's own picture for this word (Telegram file_id); per user, never shared. */
  imageFileId: string | null;
}
export type NoteInput = Pick<NoteFields, "word" | "ipa" | "pos" | "translation" | "exampleEn" | "exampleRu"> &
  Partial<Pick<NoteFields, "audioFileId" | "audioUrl" | "sourceUrl">>;
export interface NoteRow extends NoteFields { id: number; deckId: number }
export interface CardRow extends NoteFields { id: number; noteId: number; direction: Direction; mem: Mem; buriedDay: string | null }
/** `own`: the note is from the user's dictionary ("My words") and is not limited by the daily number of new cards. */
export interface NewNote extends NoteFields { noteId: number; direction: Direction; own: boolean }
export interface QueueCounts { learning: number; review: number; newAvailable: number; /** part of newAvailable that is in "My words" */ newOwn: number; newDoneToday: number }
export interface Candidates { learning: CardRow[]; review: CardRow[]; newNotes: NewNote[]; counts: QueueCounts }
export interface DayWindow { dayStartMs: number; dayEndMs: number; today: string; directions: Direction[]; limitEach?: number; newOrder?: NewOrder }
export interface Session { userId: number; chatId: number; messageId: number | null; cardId: number | null; stale: boolean; lastVoiceMessageId: number | null }
export interface DeckRow { id: number; slug: string | null; ownerId: number | null; kind: "catalog" | "ai" | "custom"; titleRu: string; titleEn: string; level: string | null; total: number }
export interface ReviewLogRow {
  id: number; cardId: number; userId: number; rating: number; stateBefore: Mem; intervalBeforeDays: number; intervalAfterMs: number;
  reviewedAt: number; wasNew: boolean; learnedNow: boolean; streakBefore: number; lastStudyDayBefore: string | null; undone: boolean;
}

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const BOOL_USER = new Set(["autoplay", "active"]);

function rowToUser(r: Record<string, unknown>): User {
  const u: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) u[camel(k)] = BOOL_USER.has(camel(k)) ? v === 1 : v;
  return u as unknown as User;
}

const NOTE_COLS = "n.word, n.ipa, n.pos, n.translation, n.example_en, n.example_ru, n.audio_file_id, n.audio_url, n.source_url";
/** A note/direction is "new" unless its card was started, or any card of the note is buried today. Binds: userId, today. */
const NEW_FILTER = `NOT EXISTS (SELECT 1 FROM cards c WHERE c.user_id = ? AND c.note_id = n.id AND ((c.direction = d.value AND c.state != 'new') OR c.buried_day = ?))`;
/** Note columns with the user's own media (alias m = user_note_media) layered over the shared note. */
const NOTE_COLS_M = "n.word, n.ipa, n.pos, n.translation, n.example_en, n.example_ru, n.audio_file_id, n.audio_url, COALESCE(m.source_url, n.source_url) AS source_url, m.image_file_id";
/** Filter for notes n of a user's own dictionary; binds the user id. */
const OWN_NOTE = "n.deck_id IN (SELECT id FROM decks WHERE owner_id = ? AND kind = 'custom')";
const CARD_FROM = "FROM cards c JOIN notes n ON n.id = c.note_id LEFT JOIN user_note_media m ON m.note_id = n.id AND m.user_id = c.user_id";
const CARD_COLS = `c.id, c.note_id, c.direction, c.state, c.step, c.stability, c.difficulty, c.due, c.last_review, c.scheduled_days, c.reps, c.lapses, c.buried_day, ${NOTE_COLS_M}`;

function noteFields(r: Record<string, unknown>): NoteFields {
  return {
    word: r.word as string, ipa: (r.ipa as string) ?? null, pos: (r.pos as string) ?? "", translation: r.translation as string,
    exampleEn: (r.example_en as string) ?? "", exampleRu: (r.example_ru as string) ?? "",
    audioFileId: (r.audio_file_id as string) ?? null, audioUrl: (r.audio_url as string) ?? null, sourceUrl: (r.source_url as string) ?? null,
    imageFileId: (r.image_file_id as string) ?? null,
  };
}
function rowToCard(r: Record<string, unknown>): CardRow {
  return {
    ...noteFields(r),
    id: r.id as number, noteId: r.note_id as number, direction: r.direction as Direction, buriedDay: (r.buried_day as string) ?? null,
    mem: {
      state: r.state as CardState, step: (r.step as number) ?? null, stability: (r.stability as number) ?? null,
      difficulty: (r.difficulty as number) ?? null, due: r.due as number, lastReview: (r.last_review as number) ?? null,
      scheduledDays: r.scheduled_days as number, reps: r.reps as number, lapses: r.lapses as number,
    },
  };
}
export const wordKey = (w: string) => w.trim().toLowerCase().replace(/\s+/g, " ");

export class Repo {
  constructor(readonly db: D1Database) {}

  batch(stmts: D1PreparedStatement[]) { return this.db.batch(stmts); }

  /* users */
  async insertUser(u: { tgId: number; chatId: number; lang: Lang; now: number }): Promise<number> {
    const r = await this.db.prepare("INSERT INTO users (tg_id, chat_id, lang, created_at) VALUES (?, ?, ?, ?) RETURNING id")
      .bind(u.tgId, u.chatId, u.lang, u.now).first<{ id: number }>();
    return r!.id;
  }
  async getUserByTg(tgId: number): Promise<User | null> {
    const r = await this.db.prepare("SELECT * FROM users WHERE tg_id = ?").bind(tgId).first<Record<string, unknown>>();
    return r ? rowToUser(r) : null;
  }
  async getUser(id: number): Promise<User | null> {
    const r = await this.db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<Record<string, unknown>>();
    return r ? rowToUser(r) : null;
  }
  updateUserStmt(id: number, patch: Partial<Omit<User, "id">>): D1PreparedStatement {
    const keys = Object.keys(patch);
    if (!keys.length) throw new Error("empty patch");
    const vals = keys.map((k) => {
      const v = (patch as Record<string, unknown>)[k];
      return typeof v === "boolean" ? (v ? 1 : 0) : (v ?? null);
    });
    return this.db.prepare(`UPDATE users SET ${keys.map((k) => `${snake(k)} = ?`).join(", ")} WHERE id = ?`).bind(...vals, id);
  }
  async updateUser(id: number, patch: Partial<Omit<User, "id">>): Promise<void> { await this.updateUserStmt(id, patch).run(); }
  /** True for the first photo of an album; the other photos of the same album are not handled on their own. */
  async claimMediaGroup(id: number, group: string): Promise<boolean> {
    const r = await this.db.prepare("UPDATE users SET last_media_group = ?1 WHERE id = ?2 AND last_media_group IS NOT ?1").bind(group, id).run();
    return r.meta.changes > 0;
  }
  /** Changes the add-flow state only if it is still what the caller last saw (the user may have moved on meanwhile). */
  async swapPendingEdit(id: number, from: string | null, to: string | null): Promise<boolean> {
    const r = await this.db.prepare("UPDATE users SET pending_edit = ? WHERE id = ? AND pending_edit IS ?").bind(to, id, from).run();
    return r.meta.changes > 0;
  }

  /* decks and notes */
  async insertDeck(d: { slug: string | null; kind: DeckRow["kind"]; titleRu: string; titleEn: string; level: string | null; ownerId: number | null }): Promise<number> {
    const r = await this.db.prepare("INSERT INTO decks (slug, kind, title_ru, title_en, level, owner_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(d.slug, d.kind, d.titleRu, d.titleEn, d.level, d.ownerId).first<{ id: number }>();
    return r!.id;
  }
  async getDeckBySlug(slug: string): Promise<DeckRow | null> {
    const r = await this.db.prepare("SELECT * FROM decks WHERE slug = ?").bind(slug).first<Record<string, unknown>>();
    return r ? this.rowToDeck(r) : null;
  }
  async getDeck(id: number): Promise<DeckRow | null> {
    const r = await this.db.prepare("SELECT * FROM decks WHERE id = ?").bind(id).first<Record<string, unknown>>();
    return r ? this.rowToDeck(r) : null;
  }
  /** Catalog decks plus the user's own decks, with subscription flag and per-user counters. */
  async listDecksForUser(userId: number, now: number): Promise<(DeckRow & { subscribed: boolean; newCount: number; dueCount: number })[]> {
    const { results } = await this.db.prepare(
      `SELECT d.*, (ud.user_id IS NOT NULL) AS subscribed,
         (SELECT COUNT(*) FROM notes n WHERE n.deck_id = d.id AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.user_id = ?1 AND c.note_id = n.id)) AS new_count,
         (SELECT COUNT(*) FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.user_id = ?1 AND n.deck_id = d.id AND c.state != 'new' AND c.due <= ?2) AS due_count
       FROM decks d LEFT JOIN user_decks ud ON ud.deck_id = d.id AND ud.user_id = ?1
       WHERE d.kind = 'catalog' OR d.owner_id = ?1 ORDER BY d.id`,
    ).bind(userId, now).all<Record<string, unknown>>();
    return results.map((r) => ({ ...this.rowToDeck(r), subscribed: r.subscribed === 1, newCount: r.new_count as number, dueCount: r.due_count as number }));
  }
  private rowToDeck(r: Record<string, unknown>): DeckRow {
    return { id: r.id as number, slug: (r.slug as string) ?? null, ownerId: (r.owner_id as number) ?? null, kind: r.kind as DeckRow["kind"],
      titleRu: r.title_ru as string, titleEn: r.title_en as string, level: (r.level as string) ?? null, total: r.total as number };
  }
  async insertNotes(deckId: number, rows: NoteInput[]): Promise<number[]> {
    if (!rows.length) return [];
    const stmts = rows.map((n) =>
      this.db.prepare(
        `INSERT INTO notes (deck_id, word, word_key, ipa, pos, translation, example_en, example_ru, audio_file_id, audio_url, source_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (deck_id, word_key) DO UPDATE SET word = excluded.word RETURNING id`,
      ).bind(deckId, n.word.trim(), wordKey(n.word), n.ipa ?? null, n.pos, n.translation, n.exampleEn, n.exampleRu,
        n.audioFileId ?? null, n.audioUrl ?? null, n.sourceUrl ?? null),
    );
    stmts.push(this.db.prepare("UPDATE decks SET total = (SELECT COUNT(*) FROM notes WHERE deck_id = ?1) WHERE id = ?1").bind(deckId));
    const res = await this.db.batch<{ id: number }>(stmts);
    return res.slice(0, rows.length).map((r) => r.results[0]!.id);
  }
  async subscribe(userId: number, deckId: number, now: number): Promise<void> {
    await this.db.prepare("INSERT OR IGNORE INTO user_decks (user_id, deck_id, added_at) VALUES (?, ?, ?)").bind(userId, deckId, now).run();
  }
  async userDeckIds(userId: number): Promise<number[]> {
    const { results } = await this.db.prepare("SELECT deck_id FROM user_decks WHERE user_id = ? ORDER BY added_at, deck_id").bind(userId).all<{ deck_id: number }>();
    return results.map((r) => r.deck_id);
  }
  /** A note with this word in any deck the user is subscribed to. */
  async findNoteForUser(userId: number, word: string): Promise<(NoteRow & { deckTitleRu: string; deckTitleEn: string }) | null> {
    const r = await this.db.prepare(
      `SELECT n.id, n.deck_id, ${NOTE_COLS_M}, d.title_ru, d.title_en FROM notes n
       JOIN user_decks ud ON ud.deck_id = n.deck_id AND ud.user_id = ? JOIN decks d ON d.id = n.deck_id
       LEFT JOIN user_note_media m ON m.note_id = n.id AND m.user_id = ud.user_id
       WHERE n.word_key = ? LIMIT 1`,
    ).bind(userId, wordKey(word)).first<Record<string, unknown>>();
    return r ? { ...noteFields(r), id: r.id as number, deckId: r.deck_id as number, deckTitleRu: r.title_ru as string, deckTitleEn: r.title_en as string } : null;
  }
  /** Batch version of findNoteForUser: one D1 call for many words, keyed by wordKey. */
  async findNotesForUser(userId: number, words: string[]): Promise<Map<string, NoteRow & { deckTitleRu: string; deckTitleEn: string }>> {
    const keys = [...new Set(words.map(wordKey))];
    const out = new Map<string, NoteRow & { deckTitleRu: string; deckTitleEn: string }>();
    if (!keys.length) return out;
    const { results } = await this.db.prepare(
      `SELECT n.id, n.deck_id, n.word_key, ${NOTE_COLS_M}, d.title_ru, d.title_en FROM notes n
       JOIN user_decks ud ON ud.deck_id = n.deck_id AND ud.user_id = ? JOIN decks d ON d.id = n.deck_id
       LEFT JOIN user_note_media m ON m.note_id = n.id AND m.user_id = ud.user_id
       WHERE n.word_key IN (SELECT value FROM json_each(?)) ORDER BY n.id`,
    ).bind(userId, JSON.stringify(keys)).all<Record<string, unknown>>();
    for (const r of results) {
      const k = r.word_key as string;
      if (!out.has(k)) out.set(k, { ...noteFields(r), id: r.id as number, deckId: r.deck_id as number, deckTitleRu: r.title_ru as string, deckTitleEn: r.title_en as string });
    }
    return out;
  }
  async getNote(id: number): Promise<NoteRow | null> {
    const r = await this.db.prepare(`SELECT n.id, n.deck_id, ${NOTE_COLS} FROM notes n WHERE n.id = ?`).bind(id).first<Record<string, unknown>>();
    return r ? { ...noteFields(r), id: r.id as number, deckId: r.deck_id as number } : null;
  }
  /** A note only if it is in one of the user's decks (never another user's private word). */
  async getNoteForUser(userId: number, noteId: number): Promise<NoteRow | null> {
    const r = await this.db.prepare(
      `SELECT n.id, n.deck_id, ${NOTE_COLS_M} FROM notes n JOIN user_decks ud ON ud.deck_id = n.deck_id AND ud.user_id = ?
       LEFT JOIN user_note_media m ON m.note_id = n.id AND m.user_id = ud.user_id WHERE n.id = ?`,
    ).bind(userId, noteId).first<Record<string, unknown>>();
    return r ? { ...noteFields(r), id: r.id as number, deckId: r.deck_id as number } : null;
  }
  /** The user's own picture/link for a word; a given value replaces the stored one, a missing one keeps it. */
  setUserMediaStmt(userId: number, noteId: number, m: { imageFileId?: string | null; sourceUrl?: string | null }): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO user_note_media (user_id, note_id, image_file_id, source_url) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, note_id) DO UPDATE SET image_file_id = COALESCE(excluded.image_file_id, image_file_id), source_url = COALESCE(excluded.source_url, source_url)`,
    ).bind(userId, noteId, m.imageFileId ?? null, m.sourceUrl ?? null);
  }
  async setUserMedia(userId: number, noteId: number, m: { imageFileId?: string | null; sourceUrl?: string | null }): Promise<void> {
    await this.setUserMediaStmt(userId, noteId, m).run();
  }
  async clearUserImage(userId: number, noteId: number): Promise<void> {
    await this.db.prepare("UPDATE user_note_media SET image_file_id = NULL WHERE user_id = ? AND note_id = ?").bind(userId, noteId).run();
  }
  async setNoteAudio(noteId: number, fileId: string): Promise<void> {
    await this.db.prepare("UPDATE notes SET audio_file_id = ? WHERE id = ?").bind(fileId, noteId).run();
  }

  /* cards */
  async insertCard(userId: number, noteId: number, direction: Direction, m: Mem, buriedDay: string | null = null): Promise<number> {
    const r = await this.insertCardStmt(userId, noteId, direction, m, buriedDay).first<{ id: number }>();
    return r!.id;
  }
  insertCardStmt(userId: number, noteId: number, direction: Direction, m: Mem, buriedDay: string | null = null): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO cards (user_id, note_id, direction, state, step, stability, difficulty, due, last_review, scheduled_days, reps, lapses, buried_day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    ).bind(userId, noteId, direction, m.state, m.step, m.stability, m.difficulty, m.due, m.lastReview, m.scheduledDays, m.reps, m.lapses, buriedDay);
  }
  updateCardStmt(cardId: number, m: Mem): D1PreparedStatement {
    return this.db.prepare(
      `UPDATE cards SET state = ?, step = ?, stability = ?, difficulty = ?, due = ?, last_review = ?, scheduled_days = ?, reps = ?, lapses = ? WHERE id = ?`,
    ).bind(m.state, m.step, m.stability, m.difficulty, m.due, m.lastReview, m.scheduledDays, m.reps, m.lapses, cardId);
  }
  /** Card update that only applies when reps still matches (first statement of a guarded grade batch). */
  gradeCardStmt(cardId: number, expectedReps: number, m: Mem): D1PreparedStatement {
    return this.db.prepare(
      `UPDATE cards SET state = ?, step = ?, stability = ?, difficulty = ?, due = ?, last_review = ?, scheduled_days = ?, reps = ?, lapses = ? WHERE id = ? AND reps = ?`,
    ).bind(m.state, m.step, m.stability, m.difficulty, m.due, m.lastReview, m.scheduledDays, m.reps, m.lapses, cardId, expectedReps);
  }
  /** Following statements of a guarded batch run only if the previous one changed a row (SQLite changes()). */
  guardedLogStmt(l: Omit<ReviewLogRow, "id" | "undone">): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO review_log (card_id, user_id, rating, state_before, interval_before_days, interval_after_ms, reviewed_at, was_new, learned_now, streak_before, last_study_day_before)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
    ).bind(l.cardId, l.userId, l.rating, JSON.stringify(l.stateBefore), l.intervalBeforeDays, l.intervalAfterMs, l.reviewedAt,
      l.wasNew ? 1 : 0, l.learnedNow ? 1 : 0, l.streakBefore, l.lastStudyDayBefore);
  }
  guardedUserStmt(id: number, patch: Partial<Omit<User, "id">>): D1PreparedStatement {
    const keys = Object.keys(patch);
    const vals = keys.map((k) => { const v = (patch as Record<string, unknown>)[k]; return typeof v === "boolean" ? (v ? 1 : 0) : (v ?? null); });
    return this.db.prepare(`UPDATE users SET ${keys.map((k) => `${snake(k)} = ?`).join(", ")} WHERE id = ? AND changes() = 1`).bind(...vals, id);
  }
  guardedUsageStmt(day: string, reviews: number, rows: number): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO usage_daily (day, reviews, rows_written_est, requests) SELECT ?, ?, ?, 0 WHERE changes() = 1
       ON CONFLICT (day) DO UPDATE SET reviews = reviews + excluded.reviews, rows_written_est = rows_written_est + excluded.rows_written_est`,
    ).bind(day, reviews, rows);
  }
  guardedSiblingStmt(userId: number, noteId: number, siblingDir: Direction, day: string, now: number): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO cards (user_id, note_id, direction, state, due, scheduled_days, reps, lapses, buried_day) SELECT ?, ?, ?, 'new', ?, 0, 0, 0, ? WHERE changes() = 1
       ON CONFLICT (user_id, note_id, direction) DO UPDATE SET buried_day = excluded.buried_day WHERE cards.state NOT IN ('learning','relearning')`,
    ).bind(userId, noteId, siblingDir, now, day);
  }

  /** Returns the id of the (possibly pre-created) new card for this note and direction. */
  async ensureNewCard(userId: number, noteId: number, direction: Direction, m: Mem): Promise<number> {
    const r = await this.db.prepare(
      `INSERT INTO cards (user_id, note_id, direction, state, due, scheduled_days, reps, lapses) VALUES (?, ?, ?, 'new', ?, 0, 0, 0)
       ON CONFLICT (user_id, note_id, direction) DO UPDATE SET due = cards.due RETURNING id`,
    ).bind(userId, noteId, direction, m.due).first<{ id: number }>();
    return r!.id;
  }
  /** Hide the other-direction card of a note until tomorrow, creating it as new if needed. */
  siblingBuryStmt(userId: number, noteId: number, siblingDir: Direction, day: string, now: number): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO cards (user_id, note_id, direction, state, due, scheduled_days, reps, lapses, buried_day) VALUES (?, ?, ?, 'new', ?, 0, 0, 0, ?)
       ON CONFLICT (user_id, note_id, direction) DO UPDATE SET buried_day = excluded.buried_day WHERE cards.state NOT IN ('learning','relearning')`,
    ).bind(userId, noteId, siblingDir, now, day);
  }
  /** Today's activity and cumulative totals by stage for one display direction. */
  async summary(userId: number, dayStartMs: number, direction: Direction): Promise<{ reviewsToday: number; learnedToday: number; learned: number; known: number; learning: number; new: number }> {
    const r = await this.db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM review_log WHERE user_id = ?1 AND undone = 0 AND reviewed_at >= ?2) AS reviews_today,
         (SELECT COALESCE(SUM(learned_now), 0) FROM review_log WHERE user_id = ?1 AND undone = 0 AND reviewed_at >= ?2) AS learned_today,
         COALESCE(SUM(CASE WHEN c.id IS NULL OR c.state = 'new' THEN 1 ELSE 0 END), 0) AS new_n,
         COALESCE(SUM(CASE WHEN c.state IN ('learning','relearning') OR (c.state = 'review' AND c.scheduled_days < 7) THEN 1 ELSE 0 END), 0) AS learning_n,
         COALESCE(SUM(CASE WHEN c.state = 'review' AND c.scheduled_days BETWEEN 7 AND 20 THEN 1 ELSE 0 END), 0) AS known_n,
         COALESCE(SUM(CASE WHEN c.state = 'review' AND c.scheduled_days >= 21 THEN 1 ELSE 0 END), 0) AS learned_n
       FROM notes n LEFT JOIN cards c ON c.note_id = n.id AND c.user_id = ?1 AND c.direction = ?3
       WHERE n.deck_id IN (SELECT deck_id FROM user_decks WHERE user_id = ?1)`,
    ).bind(userId, dayStartMs, direction).first<Record<string, number>>();
    return { reviewsToday: r!.reviews_today!, learnedToday: r!.learned_today!, learned: r!.learned_n!, known: r!.known_n!, learning: r!.learning_n!, new: r!.new_n! };
  }
  async getCard(userId: number, cardId: number): Promise<CardRow | null> {
    const r = await this.db.prepare(`SELECT ${CARD_COLS} ${CARD_FROM} WHERE c.id = ? AND c.user_id = ?`)
      .bind(cardId, userId).first<Record<string, unknown>>();
    return r ? rowToCard(r) : null;
  }
  async getCardByNote(userId: number, noteId: number, direction: Direction): Promise<CardRow | null> {
    const r = await this.db.prepare(`SELECT ${CARD_COLS} ${CARD_FROM} WHERE c.user_id = ? AND c.note_id = ? AND c.direction = ?`)
      .bind(userId, noteId, direction).first<Record<string, unknown>>();
    return r ? rowToCard(r) : null;
  }

  /** Everything the session queue needs, in one D1 call. */
  async candidateCards(userId: number, now: number, w: DayWindow): Promise<Candidates> {
    const lim = w.limitEach ?? 50;
    const dirs = JSON.stringify(w.directions);
    const inDirs = "c.direction IN (SELECT value FROM json_each(?))";
    const notBuried = "(c.buried_day IS NULL OR c.buried_day != ?)";
    const inDecks = "n.deck_id IN (SELECT deck_id FROM user_decks WHERE user_id = ?)";
    // "random" is a fixed scatter (Knuth multiplicative hash of the note id, offset per user), stable between calls.
    const random = w.newOrder === "random";
    // The user's dictionary comes first, then their AI decks, then catalog words.
    const ownFirst = "(SELECT CASE dk.kind WHEN 'custom' THEN 0 WHEN 'catalog' THEN 2 ELSE 1 END FROM decks dk WHERE dk.id = n.deck_id)";
    const isOwn = "n.deck_id IN (SELECT id FROM decks WHERE kind = 'custom')";
    const newOrderBy = `${ownFirst}, ${random ? "((n.id + ? * 977) * 2654435761) % 4294967296, d.value" : "n.deck_id, n.id, d.value"}`;
    const [learning, review, fresh, counts] = await this.db.batch<Record<string, unknown>>([
      this.db.prepare(`SELECT ${CARD_COLS} ${CARD_FROM}
        WHERE c.user_id = ? AND c.state IN ('learning','relearning') AND ${inDirs} AND ${inDecks} ORDER BY c.due LIMIT ?`).bind(userId, dirs, userId, lim),
      this.db.prepare(`SELECT ${CARD_COLS} ${CARD_FROM}
        WHERE c.user_id = ? AND c.state = 'review' AND c.due < ? AND ${inDirs} AND ${notBuried} AND ${inDecks} ORDER BY c.due LIMIT ?`)
        .bind(userId, w.dayEndMs, dirs, w.today, userId, lim),
      this.db.prepare(`SELECT n.id AS note_id, d.value AS direction, ${isOwn} AS own, ${NOTE_COLS_M} FROM notes n JOIN json_each(?) d
        LEFT JOIN user_note_media m ON m.note_id = n.id AND m.user_id = ?
        WHERE ${inDecks} AND ${NEW_FILTER} ORDER BY ${newOrderBy} LIMIT ?`).bind(dirs, userId, userId, userId, w.today, ...(random ? [userId] : []), lim),
      this.db.prepare(`SELECT
          (SELECT COUNT(*) FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.user_id = ?1 AND c.state IN ('learning','relearning') AND c.direction IN (SELECT value FROM json_each(?2)) AND n.deck_id IN (SELECT deck_id FROM user_decks WHERE user_id = ?1)) AS learning,
          (SELECT COUNT(*) FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.user_id = ?1 AND c.state = 'review' AND c.due < ?3 AND c.direction IN (SELECT value FROM json_each(?2)) AND (c.buried_day IS NULL OR c.buried_day != ?4) AND n.deck_id IN (SELECT deck_id FROM user_decks WHERE user_id = ?1)) AS review,
          (SELECT COUNT(*) FROM notes n JOIN json_each(?2) d WHERE n.deck_id IN (SELECT deck_id FROM user_decks WHERE user_id = ?1) AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.user_id = ?1 AND c.note_id = n.id AND ((c.direction = d.value AND c.state != 'new') OR c.buried_day = ?4))) AS new_available,
          (SELECT COUNT(*) FROM notes n JOIN json_each(?2) d WHERE n.deck_id IN (SELECT deck_id FROM user_decks WHERE user_id = ?1) AND ${isOwn} AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.user_id = ?1 AND c.note_id = n.id AND ((c.direction = d.value AND c.state != 'new') OR c.buried_day = ?4))) AS new_own,
          (SELECT COUNT(*) FROM review_log WHERE user_id = ?1 AND was_new = 1 AND undone = 0 AND reviewed_at >= ?5) AS new_done_today`)
        .bind(userId, dirs, w.dayEndMs, w.today, w.dayStartMs),
    ]);
    const c = counts!.results[0]!;
    return {
      learning: learning!.results.map(rowToCard),
      review: review!.results.map(rowToCard),
      newNotes: fresh!.results.map((r) => ({ ...noteFields(r), noteId: r.note_id as number, direction: r.direction as Direction, own: !!r.own })),
      counts: { learning: c.learning as number, review: c.review as number, newAvailable: c.new_available as number, newOwn: c.new_own as number, newDoneToday: c.new_done_today as number },
    };
    void now;
  }

  /** Cumulative numbers for /stats in one D1 call. */
  async statsExtra(userId: number, now: number, dayStartMs: number, direction: Direction): Promise<{ memory: number; total: number; r30: number; rev30: number; ok30: number; forecast: { d: number; n: number }[] }> {
    const since = now - 30 * 86_400_000;
    const [a, f] = await this.db.batch<Record<string, number>>([
      this.db.prepare(`SELECT
          (SELECT COALESCE(SUM(CASE WHEN state = 'review' THEN scheduled_days WHEN state = 'relearning' THEN MAX(1, CAST(ROUND(stability) AS INTEGER)) ELSE 0 END), 0)
             FROM cards WHERE user_id = ?1 AND direction = ?2) AS memory,
          (SELECT COUNT(*) FROM review_log WHERE user_id = ?1 AND undone = 0) AS total,
          (SELECT COUNT(*) FROM review_log WHERE user_id = ?1 AND undone = 0 AND reviewed_at >= ?3) AS r30,
          (SELECT COUNT(*) FROM review_log WHERE user_id = ?1 AND undone = 0 AND reviewed_at >= ?3 AND json_extract(state_before, '$.state') = 'review') AS rev30,
          (SELECT COUNT(*) FROM review_log WHERE user_id = ?1 AND undone = 0 AND reviewed_at >= ?3 AND json_extract(state_before, '$.state') = 'review' AND rating > 1) AS ok30`)
        .bind(userId, direction, since),
      this.db.prepare(`SELECT MAX(0, CAST((due - ?2) / 86400000 AS INTEGER)) AS d, COUNT(*) AS n FROM cards
          WHERE user_id = ?1 AND state != 'new' AND due < ?2 + 7 * 86400000 GROUP BY d`).bind(userId, dayStartMs),
    ]);
    const r = a!.results[0]!;
    return { memory: r.memory!, total: r.total!, r30: r.r30!, rev30: r.rev30!, ok30: r.ok30!, forecast: f!.results.map((x) => ({ d: x.d!, n: x.n! })) };
  }

  /* review log */
  insertLogStmt(l: Omit<ReviewLogRow, "id" | "undone">): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO review_log (card_id, user_id, rating, state_before, interval_before_days, interval_after_ms, reviewed_at, was_new, learned_now, streak_before, last_study_day_before)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(l.cardId, l.userId, l.rating, JSON.stringify(l.stateBefore), l.intervalBeforeDays, l.intervalAfterMs, l.reviewedAt,
      l.wasNew ? 1 : 0, l.learnedNow ? 1 : 0, l.streakBefore, l.lastStudyDayBefore);
  }
  async lastReviewLog(userId: number): Promise<ReviewLogRow | null> {
    const r = await this.db.prepare("SELECT * FROM review_log WHERE user_id = ? AND undone = 0 ORDER BY id DESC LIMIT 1").bind(userId).first<Record<string, unknown>>();
    if (!r) return null;
    return {
      id: r.id as number, cardId: r.card_id as number, userId: r.user_id as number, rating: r.rating as number,
      stateBefore: JSON.parse(r.state_before as string) as Mem, intervalBeforeDays: r.interval_before_days as number,
      intervalAfterMs: r.interval_after_ms as number, reviewedAt: r.reviewed_at as number, wasNew: r.was_new === 1,
      learnedNow: r.learned_now === 1, streakBefore: r.streak_before as number, lastStudyDayBefore: (r.last_study_day_before as string) ?? null, undone: false,
    };
  }
  markUndoneStmt(logId: number): D1PreparedStatement { return this.db.prepare("UPDATE review_log SET undone = 1 WHERE id = ?").bind(logId); }

  /* sessions */
  async getSession(userId: number): Promise<Session | null> {
    const r = await this.db.prepare("SELECT * FROM sessions WHERE user_id = ?").bind(userId).first<Record<string, unknown>>();
    return r ? { userId, chatId: r.chat_id as number, messageId: (r.message_id as number) ?? null, cardId: (r.card_id as number) ?? null,
      stale: r.stale === 1, lastVoiceMessageId: (r.last_voice_message_id as number) ?? null } : null;
  }
  saveSessionStmt(s: Session): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO sessions (user_id, chat_id, message_id, card_id, stale, last_voice_message_id) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET chat_id = excluded.chat_id, message_id = excluded.message_id, card_id = excluded.card_id,
       stale = excluded.stale, last_voice_message_id = excluded.last_voice_message_id`,
    ).bind(s.userId, s.chatId, s.messageId, s.cardId, s.stale ? 1 : 0, s.lastVoiceMessageId);
  }
  async saveSession(s: Session): Promise<void> { await this.saveSessionStmt(s).run(); }
  /** Points the session at a message/card without touching the voice message id. */
  async setSessionMessage(userId: number, chatId: number, messageId: number, cardId: number | null): Promise<void> {
    await this.db.prepare(
      `INSERT INTO sessions (user_id, chat_id, message_id, card_id) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET chat_id = excluded.chat_id, message_id = excluded.message_id, card_id = excluded.card_id, stale = 0`,
    ).bind(userId, chatId, messageId, cardId).run();
  }
  /** Moves the session to a freshly sent message and forgets the old voice message; returns that voice id so it can be deleted. One D1 call. */
  async replaceSessionMessage(userId: number, chatId: number, messageId: number, cardId: number | null): Promise<number | null> {
    const [prev] = await this.db.batch<{ last_voice_message_id: number | null }>([
      this.db.prepare("SELECT last_voice_message_id FROM sessions WHERE user_id = ?").bind(userId),
      this.db.prepare(
        `INSERT INTO sessions (user_id, chat_id, message_id, card_id) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET chat_id = excluded.chat_id, message_id = excluded.message_id, card_id = excluded.card_id, stale = 0, last_voice_message_id = NULL`,
      ).bind(userId, chatId, messageId, cardId),
    ]);
    return prev?.results[0]?.last_voice_message_id ?? null;
  }
  /** Remembers the last voice message without touching which card the session points at. */
  async setLastVoice(userId: number, chatId: number, messageId: number): Promise<void> {
    await this.db.prepare(
      `INSERT INTO sessions (user_id, chat_id, last_voice_message_id) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET last_voice_message_id = excluded.last_voice_message_id`,
    ).bind(userId, chatId, messageId).run();
  }
  async markSessionStale(userId: number): Promise<void> {
    await this.db.prepare("UPDATE sessions SET stale = 1 WHERE user_id = ?").bind(userId).run();
  }

  /* previews */
  async insertPreview(userId: number, kind: "add" | "gen", payload: unknown, now: number): Promise<number> {
    const r = await this.db.prepare("INSERT INTO previews (user_id, kind, payload, created_at) VALUES (?, ?, ?, ?) RETURNING id")
      .bind(userId, kind, JSON.stringify(payload), now).first<{ id: number }>();
    return r!.id;
  }
  async getPreview<T>(userId: number, id: number, kind: "add" | "gen", notBefore: number): Promise<T | null> {
    const r = await this.db.prepare("SELECT payload FROM previews WHERE id = ? AND user_id = ? AND kind = ? AND created_at >= ?")
      .bind(id, userId, kind, notBefore).first<{ payload: string }>();
    return r ? (JSON.parse(r.payload) as T) : null;
  }
  async updatePreview(id: number, payload: unknown): Promise<void> {
    await this.db.prepare("UPDATE previews SET payload = ? WHERE id = ?").bind(JSON.stringify(payload), id).run();
  }
  async deletePreview(userId: number, id: number): Promise<boolean> {
    const r = await this.db.prepare("DELETE FROM previews WHERE id = ? AND user_id = ?").bind(id, userId).run();
    return (r.meta.changes ?? 0) > 0;
  }
  /** The user's own "My words" deck, created and subscribed on first use. */
  async customDeck(userId: number, now: number): Promise<number> {
    const r = await this.db.prepare("SELECT id FROM decks WHERE owner_id = ? AND kind = 'custom' LIMIT 1").bind(userId).first<{ id: number }>();
    if (r) return r.id;
    const id = await this.insertDeck({ slug: null, kind: "custom", titleRu: "Мои слова", titleEn: "My words", level: null, ownerId: userId });
    await this.subscribe(userId, id, now);
    return id;
  }

  /** The user's own dictionary ("My words"): total and one page of cards, newest first. */
  async listCustomNotes(userId: number, limit: number, offset = 0): Promise<{ total: number; items: { id: number; word: string; translation: string }[] }> {
    const [count, rows] = await this.db.batch<Record<string, unknown>>([
      this.db.prepare(`SELECT COUNT(*) AS total FROM notes n WHERE ${OWN_NOTE}`).bind(userId),
      this.db.prepare(`SELECT n.id, n.word, n.translation FROM notes n WHERE ${OWN_NOTE} ORDER BY n.id DESC LIMIT ? OFFSET ?`).bind(userId, limit, offset),
    ]);
    return {
      total: (count!.results[0]!.total as number) ?? 0,
      items: rows!.results.map((r) => ({ id: r.id as number, word: r.word as string, translation: r.translation as string })),
    };
  }
  /** One card of the user's own dictionary, with their picture and link. */
  async getCustomNote(userId: number, noteId: number): Promise<NoteRow | null> {
    const r = await this.db.prepare(
      `SELECT n.id, n.deck_id, ${NOTE_COLS_M} FROM notes n LEFT JOIN user_note_media m ON m.note_id = n.id AND m.user_id = ?1
       WHERE n.id = ?2 AND ${OWN_NOTE.replace("?", "?1")}`,
    ).bind(userId, noteId).first<Record<string, unknown>>();
    return r ? { ...noteFields(r), id: r.id as number, deckId: r.deck_id as number } : null;
  }
  /** A new spelling drops what was looked up for the old one (transcription, part of speech, recorded audio). */
  async updateCustomNote(userId: number, noteId: number, patch: { word?: string; translation?: string; dropExample?: boolean }): Promise<void> {
    const word = patch.word?.trim() ?? null;
    const renamed = "?1 IS NOT NULL AND ?2 != word_key";
    await this.db.prepare(
      `UPDATE notes SET
         ipa = CASE WHEN ${renamed} THEN NULL ELSE ipa END,
         pos = CASE WHEN ${renamed} THEN '' ELSE pos END,
         audio_file_id = CASE WHEN ${renamed} THEN NULL ELSE audio_file_id END,
         audio_url = CASE WHEN ${renamed} THEN NULL ELSE audio_url END,
         example_en = CASE WHEN ?6 THEN '' ELSE example_en END,
         example_ru = CASE WHEN ?6 THEN '' ELSE example_ru END,
         word = COALESCE(?1, word), word_key = COALESCE(?2, word_key), translation = COALESCE(?3, translation)
       WHERE id = ?4 AND deck_id IN (SELECT id FROM decks WHERE owner_id = ?5 AND kind = 'custom')`,
    ).bind(word, word === null ? null : wordKey(word), patch.translation ?? null, noteId, userId, patch.dropExample ? 1 : 0).run();
  }
  /** Removes a card of the user's own dictionary with its progress and picture. The review history stays for statistics. */
  async deleteCustomNote(userId: number, noteId: number): Promise<boolean> {
    const mine = "(SELECT n.id FROM notes n WHERE n.id = ?1 AND n.deck_id IN (SELECT id FROM decks WHERE owner_id = ?2 AND kind = 'custom'))";
    const res = await this.db.batch([
      this.db.prepare(`DELETE FROM cards WHERE note_id IN ${mine}`).bind(noteId, userId),
      this.db.prepare(`DELETE FROM user_note_media WHERE note_id IN ${mine}`).bind(noteId, userId),
      this.db.prepare(`DELETE FROM notes WHERE id IN ${mine}`).bind(noteId, userId),
      this.db.prepare("UPDATE decks SET total = (SELECT COUNT(*) FROM notes WHERE deck_id = decks.id) WHERE owner_id = ? AND kind = 'custom'").bind(userId),
    ]);
    return (res[2]?.meta.changes ?? 0) > 0;
  }

  /* usage */
  bumpUsageStmt(day: string, reviews: number, rows: number): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO usage_daily (day, reviews, rows_written_est, requests) VALUES (?, ?, ?, 0)
       ON CONFLICT (day) DO UPDATE SET reviews = reviews + excluded.reviews, rows_written_est = rows_written_est + excluded.rows_written_est`,
    ).bind(day, reviews, rows);
  }
}

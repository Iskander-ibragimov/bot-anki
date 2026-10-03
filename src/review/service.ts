import type { CardRow, Direction, NewNote, Repo, User } from "../db/repo";
import { type Mem, type Rating, formatInterval, grade as fsrsGrade, memoryDays, newMem, preview, stage } from "../srs/fsrs";
import { dayWindow, localDay } from "../users/service";
import { pick } from "./pick";

/** View-model types shared with the bot layer (kept here so services never import the bot). */
export interface CardView {
  cardId: number; noteId: number; reps: number; direction: Direction;
  word: string; ipa: string | null; pos: string; translation: string; exampleEn: string; exampleRu: string;
  sourceUrl: string | null; imageFileId: string | null; mem: Mem;
}
export interface Feedback { word: string; kind: "grow" | "step" | "lapse" | "first"; beforeDays: number; afterMs: number; keptDays?: number }
export interface Counts { n: number; l: number; r: number }
export interface DaySummary {
  reviewsToday: number; learnedToday: number;
  totals: { learned: number; known: number; learning: number; new: number };
  nextLearningInMs: number | null; streak: number;
}
export type Screen =
  | { kind: "card"; view: CardView; counts: Counts; intervals: Record<Rating, string>; feedback: Feedback | null; canUndo: boolean }
  | { kind: "done"; summary: DaySummary; feedback: Feedback | null }
  | { kind: "stale" }
  | { kind: "noundo" }
  | { kind: "nothing" };

/** D1 rows written per grade, index updates included (card, log, user, usage). */
const ROWS_PER_REVIEW = 8;

export const directionsOf = (u: Pick<User, "direction">): Direction[] =>
  u.direction === "both" ? ["en_ru", "ru_en"] : [u.direction];
export const displayDirection = (u: Pick<User, "direction">): Direction => (u.direction === "ru_en" ? "ru_en" : "en_ru");

function toView(row: CardRow | (NewNote & { id: number; mem: Mem })): CardView {
  return {
    cardId: row.id, noteId: row.noteId, reps: row.mem.reps, direction: row.direction, word: row.word, ipa: row.ipa, pos: row.pos,
    translation: row.translation, exampleEn: row.exampleEn, exampleRu: row.exampleRu,
    sourceUrl: row.sourceUrl, imageFileId: row.imageFileId, mem: row.mem,
  };
}

function feedbackOf(word: string, before: Mem, after: Mem, now: number): Feedback {
  const afterMs = after.due - now;
  const beforeDays = before.state === "review" ? before.scheduledDays : 0;
  if (before.state === "review" && after.state === "relearning") return { word, kind: "lapse", beforeDays, afterMs, keptDays: memoryDays(after) };
  if (after.state === "review" && before.state === "review") return { word, kind: "grow", beforeDays, afterMs };
  if (after.state === "review") return { word, kind: "first", beforeDays, afterMs };
  return { word, kind: "step", beforeDays, afterMs };
}

export class ReviewService {
  constructor(private readonly repo: Repo, private readonly now: number) {}

  async nextScreen(user: User, feedback: Feedback | null = null): Promise<Screen> {
    const w = dayWindow(user.tzOffsetMin, this.now);
    const c = await this.repo.candidateCards(user.id, this.now, { ...w, directions: directionsOf(user), newOrder: user.newOrder });
    const newLeft = Math.max(0, user.newPerDay - c.counts.newDoneToday);
    const p = pick(c, newLeft, this.now, user.mixCounter);
    const counts: Counts = { n: Math.min(newLeft, c.counts.newAvailable), l: c.counts.learning, r: c.counts.review };
    if (!p) {
      const s = await this.repo.summary(user.id, w.dayStartMs, displayDirection(user));
      const totals = { learned: s.learned, known: s.known, learning: s.learning, new: s.new };
      if (!feedback && Object.values(totals).every((x) => x === 0)) return { kind: "nothing" };
      const nextDue = c.learning.length ? Math.min(...c.learning.map((x) => x.mem.due)) : null;
      return {
        kind: "done", feedback,
        summary: { reviewsToday: s.reviewsToday, learnedToday: s.learnedToday, totals, streak: user.streak,
          nextLearningInMs: nextDue == null ? null : Math.max(0, nextDue - this.now) },
      };
    }
    let row: CardRow;
    if (p.kind === "new") {
      const mem = newMem(this.now);
      const id = await this.repo.ensureNewCard(user.id, p.note.noteId, p.note.direction, mem);
      row = { ...p.note, id, mem, buriedDay: null };
    } else row = p.card;
    const pv = preview(row.mem, this.now, user.retention);
    const intervals = { 1: 0, 2: 0, 3: 0, 4: 0 } as Record<Rating, string | number>;
    for (const g of [1, 2, 3, 4] as Rating[]) intervals[g] = formatInterval(pv[g] - this.now, user.lang);
    return { kind: "card", view: toView(row), counts, intervals: intervals as Record<Rating, string>, feedback, canUndo: feedback != null };
  }

  async grade(user: User, cardId: number, reps: number, rating: Rating): Promise<Screen> {
    const card = await this.repo.getCard(user.id, cardId);
    if (!card || card.mem.reps !== reps) return { kind: "stale" };
    const before = card.mem;
    const after = fsrsGrade(before, rating, this.now, user.retention);
    const today = localDay(user.tzOffsetMin, this.now);
    const yesterday = localDay(user.tzOffsetMin, this.now - 86_400_000);
    const streak = user.lastStudyDay === today ? user.streak : user.lastStudyDay === yesterday ? user.streak + 1 : 1;
    const learnedNow = stage(before) !== "learned" && stage(after) === "learned";
    const stmts = [
      this.repo.gradeCardStmt(card.id, reps, after),
      this.repo.guardedLogStmt({
        cardId: card.id, userId: user.id, rating, stateBefore: before, intervalBeforeDays: before.scheduledDays,
        intervalAfterMs: after.due - this.now, reviewedAt: this.now, wasNew: before.state === "new", learnedNow,
        streakBefore: user.streak, lastStudyDayBefore: user.lastStudyDay,
      }),
      this.repo.guardedUserStmt(user.id, { streak, lastStudyDay: today, lastReviewAt: this.now, mixCounter: user.mixCounter + 1 }),
      this.repo.guardedUsageStmt(new Date(this.now).toISOString().slice(0, 10), 1, ROWS_PER_REVIEW),
    ];
    if (user.direction === "both") {
      const sibling: Direction = card.direction === "en_ru" ? "ru_en" : "en_ru";
      stmts.push(this.repo.guardedSiblingStmt(user.id, card.noteId, sibling, today, this.now));
    }
    const res = await this.repo.batch(stmts);
    if (!res[0]?.meta.changes) return { kind: "stale" };
    const updated: User = { ...user, streak, lastStudyDay: today, lastReviewAt: this.now, mixCounter: user.mixCounter + 1 };
    return this.nextScreen(updated, feedbackOf(card.word, before, after, this.now));
  }

  /** Restores the last graded card (one level, like Anki’s undo). */
  async undo(user: User): Promise<Screen> {
    const log = await this.repo.lastReviewLog(user.id);
    if (!log) return { kind: "noundo" };
    await this.repo.batch([
      this.repo.updateCardStmt(log.cardId, log.stateBefore),
      this.repo.markUndoneStmt(log.id),
      this.repo.updateUserStmt(user.id, { streak: log.streakBefore, lastStudyDay: log.lastStudyDayBefore }),
    ]);
    const card = await this.repo.getCard(user.id, log.cardId);
    if (!card) return { kind: "noundo" };
    const pv = preview(card.mem, this.now, user.retention);
    const intervals = {} as Record<Rating, string>;
    for (const g of [1, 2, 3, 4] as Rating[]) intervals[g] = formatInterval(pv[g] - this.now, user.lang);
    const w = dayWindow(user.tzOffsetMin, this.now);
    const c = await this.repo.candidateCards(user.id, this.now, { ...w, directions: directionsOf(user), newOrder: user.newOrder });
    const newLeft = Math.max(0, user.newPerDay - c.counts.newDoneToday);
    return { kind: "card", view: toView(card), intervals, feedback: null, canUndo: false,
      counts: { n: Math.min(newLeft, c.counts.newAvailable), l: c.counts.learning, r: c.counts.review } };
  }
}

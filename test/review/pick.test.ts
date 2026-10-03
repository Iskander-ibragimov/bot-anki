import { describe, expect, it } from "vitest";
import { pick } from "../../src/review/pick";
import type { Candidates, CardRow, NewNote } from "../../src/db/repo";
import { newMem } from "../../src/srs/fsrs";

const T = Date.UTC(2026, 8, 30, 6);
const note = { word: "w", ipa: null, pos: "", translation: "т", exampleEn: "", exampleRu: "", audioFileId: null, audioUrl: null, sourceUrl: null, imageFileId: null };
const card = (id: number, state: CardRow["mem"]["state"], due: number): CardRow => ({ ...note, id, noteId: id, direction: "en_ru", buriedDay: null, mem: { ...newMem(T), state, due } });
const fresh = (id: number, own = false): NewNote => ({ ...note, noteId: 100 + id, direction: "en_ru", own });
const cands = (learning: CardRow[], review: CardRow[], newNotes: NewNote[]): Candidates => ({ learning, review, newNotes, counts: { learning: learning.length, review: review.length, newAvailable: newNotes.length, newOwn: newNotes.filter((n) => n.own).length, newDoneToday: 0 } });

describe("pick", () => {
  it("due learning card comes first", () => {
    const p = pick(cands([card(1, "learning", T - 1)], [card(2, "review", T - 5)], [fresh(1)]), 5, T, 0);
    expect(p).toEqual({ kind: "card", card: expect.objectContaining({ id: 1 }) });
  });

  it("new cards are spread among reviews", () => {
    const reviews = Array.from({ length: 10 }, (_, i) => card(10 + i, "review", T - 1000));
    const seq = [0, 1, 2, 3, 4, 5].map((mix) => pick(cands([], reviews, [fresh(1)]), 5, T, mix)!.kind);
    expect(seq).toEqual(["card", "card", "new", "card", "card", "new"]);
  });

  it("learn-ahead shows a learning card due within 60s when nothing else", () => {
    const p = pick(cands([card(1, "learning", T + 59_000)], [], []), 0, T, 0);
    expect(p?.kind).toBe("card");
  });

  it("no learn-ahead beyond 60s", () => {
    expect(pick(cands([card(1, "learning", T + 61_000)], [], [fresh(1)]), 0, T, 0)).toBeNull();
  });

  it("the user's own new words come before reviews and do not depend on the daily limit", () => {
    const reviews = [card(10, "review", T - 1000)];
    expect(pick(cands([], reviews, [fresh(1, true), fresh(2)]), 0, T, 0)).toEqual({ kind: "new", note: expect.objectContaining({ noteId: 101 }) });
    expect(pick(cands([card(1, "learning", T - 1)], reviews, [fresh(1, true)]), 5, T, 0)).toEqual({ kind: "card", card: expect.objectContaining({ id: 1 }) });
    expect(pick(cands([], reviews, [fresh(2)]), 0, T, 0)).toEqual({ kind: "card", card: expect.objectContaining({ id: 10 }) });
  });

  it("respects zero new left", () => {
    expect(pick(cands([], [], [fresh(1)]), 0, T, 0)).toBeNull();
  });
});

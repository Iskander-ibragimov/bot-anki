import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Repo } from "../../src/db/repo";
import { countingDb } from "../helpers/countingDb";
import { newMem } from "../../src/srs/fsrs";

const T = Date.UTC(2026, 8, 30, 6, 0, 0);
const DAY = 86_400_000;

async function seed(repo: Repo) {
  const deckId = await repo.insertDeck({ slug: "a2", kind: "catalog", titleRu: "A2", titleEn: "A2", level: "A2", ownerId: null });
  const ids = await repo.insertNotes(deckId, [
    { word: "borrow", ipa: "/ˈbɒrəʊ/", pos: "verb", translation: "брать взаймы", exampleEn: "Can I borrow it?", exampleRu: "Можно взять?" },
    { word: "Apple", ipa: null, pos: "noun", translation: "яблоко", exampleEn: "An apple.", exampleRu: "Яблоко." },
    { word: "quiet", ipa: null, pos: "adj", translation: "тихий", exampleEn: "Be quiet.", exampleRu: "Тише." },
  ]);
  const userId = await repo.insertUser({ tgId: 1, chatId: 1, lang: "ru", now: T });
  await repo.subscribe(userId, deckId, T);
  return { deckId, ids, userId };
}

describe("repo", () => {
  let repo: Repo;
  beforeEach(() => { repo = new Repo(env.DB); });

  it("unique card per user note direction", async () => {
    const { ids, userId } = await seed(repo);
    await repo.insertCard(userId, ids[0]!, "en_ru", newMem(T));
    await expect(repo.insertCard(userId, ids[0]!, "en_ru", newMem(T))).rejects.toThrow();
    await repo.insertCard(userId, ids[0]!, "ru_en", newMem(T));
  });

  it("candidateCards returns due learning, due-today reviews, unseen notes and counts in one batch", async () => {
    const { ids, userId } = await seed(repo);
    await repo.insertCard(userId, ids[0]!, "en_ru", { ...newMem(T), state: "learning", step: 1, due: T - 1000, reps: 1, lastReview: T - 600_000, stability: 2, difficulty: 5 });
    await repo.insertCard(userId, ids[1]!, "en_ru", { ...newMem(T), state: "review", due: T + 3 * 3_600_000, scheduledDays: 2, reps: 2, lastReview: T - 2 * DAY, stability: 2, difficulty: 5 });
    const db = countingDb(env.DB);
    const r = new Repo(db);
    const c = await r.candidateCards(userId, T, { dayStartMs: T - 3_600_000, dayEndMs: T + 20 * 3_600_000, today: "2026-09-30", directions: ["en_ru"] });
    expect(db.calls).toBe(1);
    expect(c.learning.map((x) => x.word)).toEqual(["borrow"]);
    expect(c.review.map((x) => x.word)).toEqual(["Apple"]);
    expect(c.newNotes.map((x) => x.word)).toEqual(["quiet"]);
    expect(c.counts).toEqual({ learning: 1, review: 1, newAvailable: 1, newDoneToday: 0 });
    expect(c.learning[0]!.mem.state).toBe("learning");
  });

  it("findNoteForUser is case-insensitive and trims", async () => {
    const { userId } = await seed(repo);
    const hit = await repo.findNoteForUser(userId, "  apple ");
    expect(hit?.word).toBe("Apple");
    expect(await repo.findNoteForUser(userId, "pear")).toBeNull();
  });

  it("updateUser patches only given fields", async () => {
    const { userId } = await seed(repo);
    await repo.updateUser(userId, { streak: 3, lastStudyDay: "2026-09-30" });
    const u = await repo.getUserByTg(1);
    expect(u?.streak).toBe(3);
    expect(u?.lastStudyDay).toBe("2026-09-30");
    expect(u?.lang).toBe("ru");
  });
});

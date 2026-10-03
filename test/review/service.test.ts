import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo } from "../../src/db/repo";
import { ReviewService, type Screen } from "../../src/review/service";
import { newMem } from "../../src/srs/fsrs";
import { countingDb } from "../helpers/countingDb";
import { seedUser } from "../helpers/seed";

const MIN = 60_000, DAY = 86_400_000;
const T = Date.UTC(2026, 8, 30, 6, 0); // 09:00 local (+03:00)
const asCard = (s: Screen) => { if (s.kind !== "card") throw new Error(`expected card, got ${s.kind}`); return s; };

describe("review service", () => {
  it("first card shows reference intervals", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T });
    const s = asCard(await new ReviewService(repo, T).nextScreen(user));
    expect(s.intervals).toEqual({ 1: "<1м", 2: "<6м", 3: "<10м", 4: "8д" });
    expect(s.view.word).toBe("borrow");
    expect(s.counts).toEqual({ n: 5, l: 0, r: 0 });
    expect(s.feedback).toBeNull();
  });

  it("again brings the card back via learn-ahead when nothing else is left", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const first = asCard(await new ReviewService(repo, T).nextScreen(user));
    const u = (await repo.getUser(user.id))!;
    const next = asCard(await new ReviewService(repo, T + 1000).grade(u, first.view.cardId, 0, 1));
    expect(next.view.cardId).toBe(first.view.cardId);
    expect(next.feedback).toMatchObject({ kind: "step", word: "borrow" });
    expect(next.canUndo).toBe(true);
  });

  it("stale callback is ignored, also after undo", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 2 });
    const svc = new ReviewService(repo, T);
    const s = asCard(await svc.nextScreen(user));
    expect((await svc.grade(user, s.view.cardId, 0, 3)).kind).toBe("card");
    expect((await svc.grade((await repo.getUser(user.id))!, s.view.cardId, 0, 3)).kind).toBe("stale");
    const logs = await env.DB.prepare("SELECT COUNT(*) AS n FROM review_log").first<{ n: number }>();
    expect(logs!.n).toBe(1);
    const undone = asCard(await svc.undo((await repo.getUser(user.id))!));
    expect(undone.view.cardId).toBe(s.view.cardId);
    expect((await svc.grade((await repo.getUser(user.id))!, s.view.cardId, 1, 3)).kind).toBe("stale");
    expect((await svc.undo((await repo.getUser(user.id))!)).kind).toBe("noundo");
  });

  it("grow feedback shows before and after days", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 1 });
    const id = await repo.insertCard(user.id, noteIds[0]!, "en_ru", { ...newMem(T), state: "review", due: T, lastReview: T - 2 * DAY, scheduledDays: 2, stability: 2.3, difficulty: 5, reps: 2 });
    const s = await new ReviewService(repo, T).grade(user, id, 2, 3);
    expect(s.kind === "done" || s.kind === "card").toBe(true);
    const fb = s.kind === "done" || s.kind === "card" ? s.feedback : null;
    expect(fb).toMatchObject({ kind: "grow", beforeDays: 2 });
    expect(fb!.afterMs).toBeGreaterThan(2 * DAY);
  });

  it("lapse keeps memory", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 1 });
    const id = await repo.insertCard(user.id, noteIds[0]!, "en_ru", { ...newMem(T), state: "review", due: T, lastReview: T - 30 * DAY, scheduledDays: 30, stability: 30, difficulty: 5, reps: 5 });
    const s = await new ReviewService(repo, T).grade(user, id, 5, 1);
    const fb = s.kind === "done" || s.kind === "card" ? s.feedback : null;
    expect(fb).toMatchObject({ kind: "lapse", beforeDays: 30 });
    expect(fb!.keptDays).toBeGreaterThan(1);
    expect(fb!.afterMs).toBe(10 * MIN);
  });

  it("daily new limit uses the 04:00 local boundary", async () => {
    const local = (h: number, m: number) => Date.UTC(2026, 8, 30, h, m) - 180 * MIN;
    const { repo, user } = await seedUser(env.DB, { now: local(3, 0), words: 4, patch: { newPerDay: 2 } });
    let now = local(3, 30);
    for (let i = 0; i < 2; i++) {
      const s = asCard(await new ReviewService(repo, now).nextScreen((await repo.getUser(user.id))!));
      await new ReviewService(repo, now).grade((await repo.getUser(user.id))!, s.view.cardId, 0, 4);
    }
    now = local(3, 50);
    expect((await new ReviewService(repo, now).nextScreen((await repo.getUser(user.id))!)).kind).toBe("done");
    now = local(4, 10);
    const s = asCard(await new ReviewService(repo, now).nextScreen((await repo.getUser(user.id))!));
    expect(s.counts.n).toBe(2);
  });

  it("a word added to My words is shown at once, even when today's new-card limit is used up", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 3, patch: { newPerDay: 1 } });
    const first = asCard(await new ReviewService(repo, T).nextScreen(user));
    await new ReviewService(repo, T).grade(user, first.view.cardId, 0, 4);
    const u = async () => (await repo.getUser(user.id))!;
    expect((await new ReviewService(repo, T).nextScreen(await u())).kind).toBe("done");
    const mine = await repo.customDeck(user.id, T);
    await repo.insertNotes(mine, [{ word: "cozy", ipa: null, pos: "", translation: "уютный", exampleEn: "", exampleRu: "" }]);
    const s = asCard(await new ReviewService(repo, T).nextScreen(await u()));
    expect(s.view.word).toBe("cozy");
    expect(s.counts.n).toBe(1);
    await new ReviewService(repo, T).grade(await u(), s.view.cardId, 0, 4);
    expect((await new ReviewService(repo, T).nextScreen(await u())).kind).toBe("done");
  });

  it("when today's new-card limit is used up, the summary says how many new words are waiting", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 3, patch: { newPerDay: 2 } });
    const u = async () => (await repo.getUser(user.id))!;
    for (let i = 0; i < 2; i++) {
      const s = asCard(await new ReviewService(repo, T).nextScreen(await u()));
      await new ReviewService(repo, T).grade(await u(), s.view.cardId, 0, 4);
    }
    const done = await new ReviewService(repo, T).nextScreen(await u());
    if (done.kind !== "done") throw new Error(done.kind);
    expect(done.summary.newLimit).toEqual({ limit: 2, waiting: 1 });
    expect(await new ReviewService(repo, T).newLimit(await u())).toEqual({ limit: 2, waiting: 1 });
    // a deck added now does not "not work": its words wait for tomorrow, and the summary says so
    const more = await repo.insertDeck({ slug: "it", kind: "catalog", titleRu: "IT", titleEn: "IT", level: null, ownerId: null });
    await repo.insertNotes(more, [{ word: "deploy", ipa: null, pos: "", translation: "выкатывать", exampleEn: "", exampleRu: "" }]);
    await repo.subscribe(user.id, more, T);
    expect(await new ReviewService(repo, T).newLimit(await u())).toEqual({ limit: 2, waiting: 2 });
    // a higher limit in settings takes effect at once
    await repo.updateUser(user.id, { newPerDay: 5 });
    expect(await new ReviewService(repo, T).newLimit(await u())).toBeNull();
    expect((await new ReviewService(repo, T).nextScreen(await u())).kind).toBe("card");
  });

  it("no limit note when nothing new is left to learn", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1, patch: { newPerDay: 1 } });
    const s = asCard(await new ReviewService(repo, T).nextScreen(user));
    const done = await new ReviewService(repo, T).grade(user, s.view.cardId, 0, 4);
    if (done.kind !== "done") throw new Error(done.kind);
    expect(done.summary.newLimit).toBeNull();
  });

  it("day summary counts learned today and totals by stage", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 3 });
    const id = await repo.insertCard(user.id, noteIds[0]!, "en_ru", { ...newMem(T), state: "review", due: T, lastReview: T - 15 * DAY, scheduledDays: 15, stability: 15, difficulty: 4, reps: 4 });
    await repo.updateUser(user.id, { newPerDay: 0 });
    const s = await new ReviewService(repo, T).grade((await repo.getUser(user.id))!, id, 4, 3);
    if (s.kind !== "done") throw new Error(s.kind);
    expect(s.summary.reviewsToday).toBe(1);
    expect(s.summary.learnedToday).toBe(1);
    expect(s.summary.totals).toEqual({ learned: 1, known: 0, learning: 0, new: 2 });
    expect(s.summary.streak).toBe(1);
  });

  it("streak grows on consecutive days and resets after a gap", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 5, patch: { streak: 4, lastStudyDay: "2026-09-29" } });
    const s = asCard(await new ReviewService(repo, T).nextScreen(user));
    await new ReviewService(repo, T).grade(user, s.view.cardId, 0, 4);
    expect((await repo.getUser(user.id))!.streak).toBe(5);
    const later = T + 3 * DAY;
    const u = (await repo.getUser(user.id))!;
    const s2 = asCard(await new ReviewService(repo, later).nextScreen(u));
    await new ReviewService(repo, later).grade(u, s2.view.cardId, s2.view.reps, 3);
    expect((await repo.getUser(user.id))!.streak).toBe(1);
  });

  it("sibling in the other direction is hidden until tomorrow", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1, patch: { direction: "both" } });
    const s = asCard(await new ReviewService(repo, T).nextScreen(user));
    expect(s.view.direction).toBe("en_ru");
    const after = await new ReviewService(repo, T).grade(user, s.view.cardId, 0, 4);
    expect(after.kind).toBe("done");
    const tomorrow = asCard(await new ReviewService(repo, T + DAY).nextScreen((await repo.getUser(user.id))!));
    expect(tomorrow.view.direction).toBe("ru_en");
  });

  it("grade uses at most 4 D1 calls", async () => {
    const { user } = await seedUser(env.DB, { now: T, words: 5 });
    const s = asCard(await new ReviewService(new Repo(env.DB), T).nextScreen(user));
    const db = countingDb(env.DB);
    await new ReviewService(new Repo(db), T).grade(user, s.view.cardId, 0, 3);
    expect(db.calls).toBeLessThanOrEqual(4);
  });

  it("two parallel taps on the same button grade once", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 3, patch: { streak: 2, lastStudyDay: "2026-09-29" } });
    const s = asCard(await new ReviewService(repo, T).nextScreen(user));
    const results = await Promise.all([
      new ReviewService(repo, T).grade(user, s.view.cardId, 0, 3),
      new ReviewService(repo, T).grade(user, s.view.cardId, 0, 3),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual(["card", "stale"]);
    const logs = await env.DB.prepare("SELECT COUNT(*) AS n FROM review_log").first<{ n: number }>();
    expect(logs!.n).toBe(1);
    const u = (await repo.getUser(user.id))!;
    expect(u.streak).toBe(3);
    expect(u.mixCounter).toBe(1);
  });

  it("new words come deck by deck by default and mixed across decks in random order", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 8, patch: { newPerDay: 20 } });
    const second = await repo.insertDeck({ slug: "b2-x", kind: "catalog", titleRu: "B2", titleEn: "B2", level: "B2", ownerId: null });
    await repo.insertNotes(second, Array.from({ length: 8 }, (_, i) => ({ word: `hard${i}`, ipa: null, pos: "adj", translation: "трудный", exampleEn: "", exampleRu: "" })));
    await repo.subscribe(user.id, second, T);
    const firstEight = async (u: typeof user) => {
      const c = await repo.candidateCards(u.id, T, { dayStartMs: T - 3_600_000, dayEndMs: T + 20 * 3_600_000, today: "2026-09-30", directions: ["en_ru"], newOrder: u.newOrder, limitEach: 8 });
      return c.newNotes.map((n) => n.word);
    };
    const byDeck = await firstEight(user);
    expect(byDeck.every((w) => !w.startsWith("hard"))).toBe(true);
    await repo.updateUser(user.id, { newOrder: "random" });
    const u = (await repo.getUser(user.id))!;
    const mixed = await firstEight(u);
    expect(mixed.some((w) => w.startsWith("hard"))).toBe(true);
    expect(mixed.some((w) => !w.startsWith("hard"))).toBe(true);
    expect(await firstEight(u)).toEqual(mixed);
    const s = asCard(await new ReviewService(repo, T).nextScreen(u));
    expect(s.view.word).toBe(mixed[0]);
  });
});

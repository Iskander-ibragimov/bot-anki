import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ReviewService } from "../../src/review/service";
import { cumulative } from "../../src/stats/service";
import { newMem } from "../../src/srs/fsrs";
import { seedUser } from "../helpers/seed";

const T = Date.UTC(2026, 8, 30, 6);
const DAY = 86_400_000;

describe("stats", () => {
  it("cumulative totals by stage, memory, retention and forecast", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 4, patch: { newPerDay: 0 } });
    const a = await repo.insertCard(user.id, noteIds[0]!, "en_ru", { ...newMem(T), state: "review", due: T, lastReview: T - 25 * DAY, scheduledDays: 25, stability: 25, difficulty: 5, reps: 5 });
    const b = await repo.insertCard(user.id, noteIds[1]!, "en_ru", { ...newMem(T), state: "review", due: T + 2 * DAY, lastReview: T - 8 * DAY, scheduledDays: 10, stability: 10, difficulty: 5, reps: 3 });
    await new ReviewService(repo, T).grade(user, a, 5, 3);
    await new ReviewService(repo, T + 1000).grade((await repo.getUser(user.id))!, b, 3, 1);
    const s = await cumulative(repo, (await repo.getUser(user.id))!, T + 2000);
    expect(s.learned).toBe(1);
    expect(s.learning).toBe(1);
    expect(s.fresh).toBe(2);
    expect(s.total).toBe(2);
    expect(s.r30).toBe(2);
    expect(s.retention30).toBe(0.5);
    expect(s.memory).toBeGreaterThan(25);
    expect(s.forecast7).toHaveLength(7);
    expect(s.forecast7[0]).toBe(1);
    expect(s.streak).toBe(1);
  });
});

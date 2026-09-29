import { describe, expect, it } from "vitest";
import { formatInterval, grade, memoryDays, newMem, preview, stage, type Mem } from "../../src/srs/fsrs";

const T = Date.UTC(2026, 8, 30, 6, 0, 0);
const MIN = 60_000, H = 3_600_000, D = 86_400_000;
const labels = (m: Mem, now: number, r = 0.9) => {
  const p = preview(m, now, r);
  return ([1, 2, 3, 4] as const).map((g) => formatInterval(p[g] - now, "ru"));
};
/** Grade Good on the due date repeatedly; returns history of scheduledDays. */
function goodOnTime(m: Mem, times: number, r = 0.9): { m: Mem; days: number[] } {
  const days: number[] = [];
  for (let i = 0; i < times; i++) { m = grade(m, 3, m.due, r); days.push(m.scheduledDays); }
  return { m, days };
}

describe("srs", () => {
  it("new card preview matches reference", () => {
    expect(labels(newMem(T), T)).toEqual(["<1м", "<6м", "<10м", "8д"]);
  });

  it("good good graduates to 2 days", () => {
    const a = grade(newMem(T), 3, T, 0.9);
    expect(a.state).toBe("learning");
    const b = grade(a, 3, T + 10 * MIN, 0.9);
    expect(b.state).toBe("review");
    expect(b.scheduledDays).toBe(2);
  });

  it("each on-time good grows the interval", () => {
    const start = grade(grade(newMem(T), 3, T, 0.9), 3, T + 10 * MIN, 0.9);
    const { days } = goodOnTime(start, 4);
    for (let i = 1; i < days.length; i++) expect(days[i]!).toBeGreaterThan(days[i - 1]!);
    expect(days[0]!).toBeGreaterThan(7);
  });

  it("again on learned keeps memory instead of resetting", () => {
    let m = grade(grade(newMem(T), 3, T, 0.9), 3, T + 10 * MIN, 0.9);
    while (m.scheduledDays < 21) m = grade(m, 3, m.due, 0.9);
    const lapse = grade(m, 1, m.due, 0.9);
    expect(lapse.state).toBe("relearning");
    expect(lapse.lapses).toBe(1);
    expect(lapse.due - m.due).toBe(10 * MIN);
    expect(memoryDays(lapse)).toBeGreaterThan(1);
    const back = grade(lapse, 3, lapse.due, 0.9);
    expect(back.state).toBe("review");
    expect(back.scheduledDays).toBeGreaterThanOrEqual(2);
  });

  it("deeply learned word relearns to a longer interval than a new card", () => {
    let m = grade(grade(newMem(T), 3, T, 0.9), 3, T + 10 * MIN, 0.9);
    while (m.scheduledDays < 100) m = grade(m, 3, m.due, 0.9);
    const lapse = grade(m, 1, m.due, 0.9);
    const back = grade(lapse, 3, lapse.due, 0.9);
    const fresh = grade(grade(newMem(T), 3, T, 0.9), 3, T + 10 * MIN, 0.9);
    expect(back.scheduledDays).toBeGreaterThan(fresh.scheduledDays);
  });

  it("higher retention gives shorter interval", () => {
    const easy85 = preview(newMem(T), T, 0.85)[4] - T;
    const easy95 = preview(newMem(T), T, 0.95)[4] - T;
    expect(easy95).toBeLessThan(easy85);
  });

  it("stage thresholds", () => {
    const rev = (d: number): Mem => ({ ...newMem(T), state: "review", scheduledDays: d, stability: d, difficulty: 5, lastReview: T, reps: 3 });
    expect(stage(newMem(T))).toBe("new");
    expect(stage({ ...newMem(T), state: "learning", step: 0 })).toBe("learning");
    expect(stage(rev(6))).toBe("learning");
    expect(stage(rev(7))).toBe("known");
    expect(stage(rev(21))).toBe("learned");
    expect(memoryDays(rev(11))).toBe(11);
    expect(memoryDays(newMem(T))).toBe(0);
  });

  it("formatInterval ru and en", () => {
    const cases: [number, string, string][] = [
      [45_000, "<1м", "<1m"], [6 * MIN, "<6м", "<6m"], [3 * H, "3ч", "3h"],
      [D, "1д", "1d"], [70 * D, "2,3мес", "2.3mo"], [400 * D, "1,1г", "1.1y"],
    ];
    for (const [ms, ru, en] of cases) {
      expect(formatInterval(ms, "ru")).toBe(ru);
      expect(formatInterval(ms, "en")).toBe(en);
    }
  });
});

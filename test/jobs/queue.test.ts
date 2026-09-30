import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { claim, complete, enqueue, fail } from "../../src/jobs/queue";

const T = Date.UTC(2026, 8, 30, 6, 0, 0);

describe("job queue", () => {
  it("dedup key blocks second pending job", async () => {
    const a = await enqueue(env.DB, "push", { u: 1 }, T, "daily:1:2026-09-30");
    const b = await enqueue(env.DB, "push", { u: 1 }, T, "daily:1:2026-09-30");
    expect(a).toBeTypeOf("number");
    expect(b).toBeNull();
    await complete(env.DB, a!, T);
    expect(await enqueue(env.DB, "push", { u: 1 }, T, "daily:1:2026-09-30")).toBeTypeOf("number");
  });

  it("future job not claimed", async () => {
    await enqueue(env.DB, "push", {}, T + 60_000);
    expect(await claim(env.DB, T, 10)).toHaveLength(0);
    expect(await claim(env.DB, T + 60_000, 10)).toHaveLength(1);
  });

  it("claim twice returns disjoint sets", async () => {
    for (let i = 0; i < 5; i++) await enqueue(env.DB, "push", { i }, T);
    const a = await claim(env.DB, T, 3);
    const b = await claim(env.DB, T, 3);
    expect(a).toHaveLength(3);
    expect(b).toHaveLength(2);
    expect(new Set([...a, ...b].map((j) => j.id)).size).toBe(5);
    expect(a[0]!.payload).toEqual({ i: 0 });
  });

  it("stale lock is reclaimable after 5 minutes", async () => {
    await enqueue(env.DB, "push", {}, T);
    expect(await claim(env.DB, T, 1)).toHaveLength(1);
    expect(await claim(env.DB, T + 60_000, 1)).toHaveLength(0);
    expect(await claim(env.DB, T + 5 * 60_000 + 1, 1)).toHaveLength(1);
  });

  it("failed job retried with backoff then abandoned after 3", async () => {
    const id = (await enqueue(env.DB, "push", {}, T))!;
    let now = T;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const [job] = await claim(env.DB, now, 1);
      expect(job?.id).toBe(id);
      await fail(env.DB, id, "boom", now);
      now += 30_000 * 2 ** attempt;
    }
    expect(await claim(env.DB, now + 10 * 60_000, 1)).toHaveLength(0);
    const row = await env.DB.prepare("SELECT attempts, done_at, error FROM jobs WHERE id = ?").bind(id).first<{ attempts: number; done_at: number | null; error: string }>();
    expect(row).toMatchObject({ attempts: 3, error: "boom" });
    expect(row!.done_at).not.toBeNull();
  });
});

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import seed from "../seed/catalog.sql?raw";
import { applySeed } from "./helpers/seedSql";

describe("catalog seed", () => {
  it("loads seven decks and is idempotent", async () => {
    await applySeed(env.DB, seed);
    await applySeed(env.DB, seed);
    const decks = await env.DB.prepare("SELECT slug, total FROM decks ORDER BY id").all<{ slug: string; total: number }>();
    expect(decks.results.map((d) => d.slug)).toEqual(["a1", "a2", "b1", "b2", "travel", "it_work", "phrases"]);
    const notes = await env.DB.prepare("SELECT COUNT(*) AS n FROM notes").first<{ n: number }>();
    expect(notes!.n).toBe(decks.results.reduce((a, d) => a + d.total, 0));
    expect(notes!.n).toBeGreaterThan(550);
  });
});

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo } from "../../src/db/repo";
import { checkUsage, importDeckCsv } from "../../src/admin/service";
import { fakeTelegram } from "../helpers/fakeTelegram";
import { harness } from "../helpers/botHarness";

const T = Date.UTC(2026, 8, 30, 6);

describe("admin", () => {
  it("non-admin cannot use admin commands", async () => {
    const h = harness(env.DB, { now: T });
    await h.text("/start");
    const before = h.tg.calls.length;
    await h.text("/admin");
    expect(h.tg.calls.length).toBe(before);
  });

  it("csv upload creates a catalog deck", async () => {
    const repo = new Repo(env.DB);
    const msg = await importDeckCsv(repo, 'word,translation,example_en,example_ru\ncozy,уютный,"A cozy, warm room.","Уютная, тёплая комната."\n', "deck: Уют | Cozy home | A2", T);
    expect(msg).toContain("1");
    const deck = await repo.getDeckBySlug("cozy_home");
    expect(deck).toMatchObject({ titleRu: "Уют", kind: "catalog", total: 1 });
    expect(await importDeckCsv(repo, "x", "no caption", T)).toContain("deck:");
  });

  it("warns the admin once when D1 writes pass 80%", async () => {
    const repo = new Repo(env.DB);
    await repo.bumpUsageStmt("2026-09-30", 1000, 81_000).run();
    const tg = fakeTelegram();
    expect(await checkUsage(repo, tg, 999, T)).toBe(true);
    expect(await checkUsage(repo, tg, 999, T)).toBe(false);
    expect(tg.of("sendMessage")).toHaveLength(1);
  });
});

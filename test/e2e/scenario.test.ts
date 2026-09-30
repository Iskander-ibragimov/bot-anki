import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import seed from "../../seed/catalog.sql?raw";
import { Repo } from "../../src/db/repo";
import { tick } from "../../src/reminders/service";
import { harness } from "../helpers/botHarness";
import { fakeTelegram } from "../helpers/fakeTelegram";
import { applySeed } from "../helpers/seedSql";

const MIN = 60_000, DAY = 86_400_000;
const T = Date.UTC(2026, 8, 30, 6, 0); // 09:00 Moscow
const gradeButtons = (m: { inline_keyboard?: { callback_data: string }[][] }) => (m.inline_keyboard ?? []).flat().map((b) => b.callback_data).filter((c) => c.startsWith("g:"));

describe("first day and next day", () => {
  it("onboarding, a session, a reminder next morning and grown memory", async () => {
    await applySeed(env.DB, seed);
    const h = harness(env.DB, { now: T });
    await h.text("/start");
    await h.press("ob:ru");
    for (let i = 0; i < 10; i++) await h.press(i < 4 ? "ob:1" : "ob:0");
    await h.press("ob:10");
    await h.press("ob:09:00");
    await h.press("ob:180");
    await h.press("ob:a2");
    await h.press("learn");
    let t = T;
    let sessionMsg = 100;
    for (let i = 0; i < 10; i++) {
      const g = gradeButtons(h.lastMarkup());
      expect(g).toHaveLength(4);
      t += 20_000;
      h.setNow(t);
      await h.press(i % 4 === 0 ? g[0]! : g[2]!, sessionMsg);
    }
    // finish learning steps
    for (let i = 0; i < 30 && gradeButtons(h.lastMarkup()).length; i++) {
      t += 11 * MIN;
      h.setNow(t);
      await h.press("learn", 700 + i);
      const g = gradeButtons(h.lastMarkup());
      if (!g.length) break;
      await h.press(g[2]!, sessionMsg);
    }
    expect(h.lastText()).toMatch(/Сегодня: \d+ повт\./);
    expect(h.lastText()).toContain("Всего:");

    const repo = new Repo(env.DB);
    const u = (await repo.getUserByTg(42))!;
    expect(u.streak).toBe(1);
    const tg = fakeTelegram();
    const nextMorning = T + DAY + MIN;
    await tick({ repo, tg, adminChatId: 999, now: nextMorning });
    await tick({ repo, tg, adminChatId: 999, now: nextMorning + MIN });
    const pushes = tg.of("sendMessage").filter((c) => String(c.payload.text).includes("Пора повторить"));
    expect(pushes).toHaveLength(1);

    h.setNow(nextMorning + 5 * MIN);
    await h.press("learn", 900);
    let grew = false;
    for (let i = 0; i < 25 && !grew; i++) {
      const g = gradeButtons(h.lastMarkup());
      if (!g.length) break;
      await h.press(g[2]!, 900);
      grew = /\(было \d+ дн\.\)/.test(h.lastText());
    }
    expect(grew).toBe(true);
    void sessionMsg;
  });
});

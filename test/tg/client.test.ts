import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DictionaryClient } from "../../src/content/dictionary";
import { LlmClient } from "../../src/content/llm";
import { Repo } from "../../src/db/repo";
import { tick } from "../../src/reminders/service";
import { TgClient } from "../../src/tg/client";
import { seedUser } from "../helpers/seed";
import { z } from "zod";

/** Behaves like the Workers runtime: fetch throws when called as a method of another object. */
function strictFetch(respond: (url: string, body: unknown) => unknown) {
  const calls: { url: string; body: unknown }[] = [];
  const f = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    return Promise.resolve(new Response(JSON.stringify(respond(url, body)), { headers: { "content-type": "application/json" } }));
  };
  vi.stubGlobal("fetch", f);
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe("clients with the default fetch (as in the cron handler)", () => {
  it("TgClient calls Telegram", async () => {
    const calls = strictFetch(() => ({ ok: true, result: { message_id: 5 } }));
    const res = await new TgClient("1:token").call<{ message_id: number }>("sendMessage", { chat_id: 1, text: "hi" });
    expect(res.message_id).toBe(5);
    expect(calls[0]!.url).toBe("https://api.telegram.org/bot1:token/sendMessage");
  });

  it("the cron tick delivers the daily reminder through the real TgClient", async () => {
    const MIN = 60_000;
    const at = (h: number, m: number) => Date.UTC(2026, 9, 3, h, m) - 180 * MIN;
    await seedUser(env.DB, { now: at(11, 0), words: 3, patch: { remindAt: "12:00" } });
    const calls = strictFetch(() => ({ ok: true, result: { message_id: 9 } }));
    const res = await tick({ repo: new Repo(env.DB), tg: new TgClient("1:token"), adminChatId: 999, now: at(12, 0) });
    expect(res.sent).toBe(1);
    expect(calls).toHaveLength(1);
    expect(String((calls[0]!.body as { text: string }).text)).toContain("Пора повторить");
  });

  it("DictionaryClient and LlmClient work with their default fetch too", async () => {
    strictFetch((url) => (url.includes("dictionaryapi")
      ? [{ phonetic: "/x/", meanings: [{ partOfSpeech: "noun", definitions: [] }] }]
      : { choices: [{ message: { content: '{"ok":true}' } }] }));
    expect((await new DictionaryClient().lookup("word"))?.pos).toBe("noun");
    const r = await new LlmClient([{ baseUrl: "https://llm/v1", apiKey: "k", model: "m" }]).completeJson("s", "u", z.object({ ok: z.boolean() }));
    expect(r.ok).toBe(true);
  });
});

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("worker entry", () => {
  it("health check answers ok", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://bot.example/"), env as never, ctx);
    expect(await res.text()).toBe("ok");
  });
  it("webhook without the secret header is rejected", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://bot.example/tg", { method: "POST", body: "{}" }), env as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });
  it("webhook with a wrong secret is rejected", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://bot.example/tg", { method: "POST", body: "{}", headers: { "X-Telegram-Bot-Api-Secret-Token": "nope" } }), env as never, ctx);
    expect(res.status).toBe(401);
  });
});

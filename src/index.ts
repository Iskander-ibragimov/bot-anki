import { webhookCallback } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { checkUsage } from "./admin/service";
import { createBot } from "./bot/bot";
import { Repo } from "./db/repo";
import { type Env, parseEnv } from "./env";
import { tick } from "./reminders/service";
import { TgClient } from "./tg/client";

/** getMe result cached per isolate so each webhook doesn't spend a subrequest on it. */
let botInfo: UserFromGetMe | undefined;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") return new Response("ok");
    if (req.method !== "POST" || url.pathname !== "/tg") return new Response("not found", { status: 404 });
    if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) return new Response("unauthorized", { status: 401 });
    const config = parseEnv(env);
    const bot = createBot(
      { config, repo: new Repo(env.DB), fetch: (i, init) => fetch(i, init), waitUntil: (p) => ctx.waitUntil(p), now: () => Date.now() },
      botInfo,
    );
    if (!botInfo) {
      try { await bot.init(); botInfo = bot.botInfo; } catch (e) { console.error("getMe failed", e); return new Response("retry later", { status: 503 }); }
    }
    return webhookCallback(bot, "cloudflare-mod", { secretToken: env.WEBHOOK_SECRET, timeoutMilliseconds: 25_000 })(req);
  },

  /** Awaited (not waitUntil) so the cron invocation may run past 30 s if Telegram is slow. */
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const config = parseEnv(env);
    const repo = new Repo(env.DB);
    const tg = new TgClient(config.botToken);
    const now = Date.now();
    try {
      await tick({ repo, tg, adminChatId: config.adminTgId, now });
      await checkUsage(repo, tg, config.adminTgId, now);
    } catch (e) {
      console.error("tick failed", e);
    }
  },
} satisfies ExportedHandler<Env>;

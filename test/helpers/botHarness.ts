import type { Update } from "grammy/types";
import { createBot, type BotDeps } from "../../src/bot/bot";
import { Repo } from "../../src/db/repo";
import { fakeTelegram } from "./fakeTelegram";

export function harness(db: D1Database, opts: { now: number; fetch?: typeof fetch; repo?: Repo; synth?: BotDeps["synth"] }) {
  const tg = fakeTelegram();
  const pending: Promise<unknown>[] = [];
  let now = opts.now;
  const deps: BotDeps = {
    config: { botToken: "1:x", webhookSecret: "s", adminTgId: 999, llmProviders: [{ baseUrl: "https://llm/v1", apiKey: "k", model: "m" }] },
    repo: opts.repo ?? new Repo(db),
    fetch: opts.fetch ?? (async () => new Response("{}", { status: 500 })),
    waitUntil: (p) => { pending.push(p); },
    now: () => now,
    ...(opts.synth ? { synth: opts.synth } : {}),
  };
  const bot = createBot(deps, {
    id: 1, is_bot: true, first_name: "Povtor", username: "povtor_bot", can_join_groups: false,
    can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false,
  } as never);
  bot.api.config.use(async (_prev, method, payload) => {
    try {
      return { ok: true, result: await tg.call(method, payload as Record<string, unknown>) } as never;
    } catch (e) {
      const err = e as { error_code: number; message: string; parameters?: unknown };
      return { ok: false, error_code: err.error_code, description: err.message, parameters: err.parameters } as never;
    }
  });
  let uid = 1;
  const from = { id: 42, is_bot: false, first_name: "Iskander", language_code: "ru" };
  const chat = { id: 42, type: "private" as const, first_name: "Iskander" };
  const send = async (u: Update) => { await bot.handleUpdate(u); await Promise.all(pending.splice(0)); };
  return {
    tg, deps, bot,
    setNow(t: number) { now = t; },
    text: (text: string, entities?: unknown[]) => {
      const cmd = text.match(/^\/\w+/);
      const ents = entities ?? (cmd ? [{ type: "bot_command", offset: 0, length: cmd[0].length }] : undefined);
      return send({ update_id: uid++, message: { message_id: 500 + uid, date: 0, chat, from, text, ...(ents ? { entities: ents } : {}) } } as Update);
    },
    press: (data: string, messageId = 100) =>
      send({ update_id: uid++, callback_query: { id: `cb${uid}`, from, chat_instance: "x", data, message: { message_id: messageId, date: 0, chat, text: "x" } } } as Update),
    lastText: () => { const c = [...tg.calls].reverse().find((x) => x.method === "sendMessage" || x.method === "editMessageText"); return String(c?.payload.text ?? ""); },
    lastMarkup: () => { const c = [...tg.calls].reverse().find((x) => x.method === "sendMessage" || x.method === "editMessageText"); return (c?.payload.reply_markup ?? {}) as { inline_keyboard?: { text: string; callback_data: string }[][] }; },
  };
}

import { Bot, type Context, GrammyError } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { isAdmin, adminStatsText, importDeckCsv } from "../admin/service";
import { playVoice } from "../content/audio";
import { DictionaryClient } from "../content/dictionary";
import { LlmClient } from "../content/llm";
import { ContentService } from "../content/service";
import type { Repo, User } from "../db/repo";
import { remaining } from "../entitlements/service";
import type { Config } from "../env";
import { dict } from "../i18n";
import { ReviewService, type Screen } from "../review/service";
import type { Rating } from "../srs/fsrs";
import { cumulative } from "../stats/service";
import type { TgApi } from "../tg/client";
import { REMIND_TIMES, RETENTIONS, advanceOnboarding, getOrCreate, langFromTelegram, setSetting, startOnboarding } from "../users/service";
import { deckTitle, learnKeyboard, renderDecks, renderGenPreview, renderOnboarding, renderSettings, renderStats } from "./screens";
import { type Keyboard, type Rendered, esc, hostOf, renderAddPreview, renderCard, renderDone } from "./views";

export interface BotDeps {
  config: Config;
  repo: Repo;
  fetch: typeof fetch;
  waitUntil(p: Promise<unknown>): void;
  now(): number;
}

type Ctx = Context & { user: User };
const HTML = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };
const isD1Limit = (e: unknown) => /daily row (read|write) limit|exceeded D1/i.test(String((e as Error)?.message ?? e));

export function createBot(deps: BotDeps, botInfo?: UserFromGetMe): Bot<Ctx> {
  const { repo, config } = deps;
  const bot = new Bot<Ctx>(config.botToken, botInfo ? { botInfo } : {});
  const tg: TgApi = { call: <T>(m: string, p: Record<string, unknown>) => (bot.api.raw as unknown as Record<string, (x: unknown) => Promise<T>>)[m]!(p) };
  const content = () => new ContentService(repo, { dict: new DictionaryClient(deps.fetch), llm: new LlmClient(config.llmProviders, deps.fetch) }, deps.now());
  const reviews = () => new ReviewService(repo, deps.now());

  const markup = (keyboard: Keyboard) => (keyboard.length ? { inline_keyboard: keyboard } : undefined);
  const send = async (ctx: Ctx, r: Rendered) => ctx.api.sendMessage(ctx.user.chatId, r.text, { ...HTML, reply_markup: markup(r.keyboard) });
  /** Edits a message; if Telegram can’t edit it, sends a new one. Returns the message id shown. */
  const editOrSend = async (ctx: Ctx, messageId: number | undefined, r: Rendered): Promise<number> => {
    if (messageId) {
      try {
        await ctx.api.editMessageText(ctx.user.chatId, messageId, r.text, { ...HTML, reply_markup: markup(r.keyboard) });
        return messageId;
      } catch (e) {
        if (e instanceof GrammyError && /not modified/i.test(e.description)) return messageId;
        if (!(e instanceof GrammyError)) throw e;
      }
    }
    return (await send(ctx, r)).message_id;
  };
  const toast = async (ctx: Ctx, text?: string) => { if (ctx.callbackQuery) await ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => undefined); };
  const clickedId = (ctx: Ctx) => ctx.callbackQuery?.message?.message_id;

  /** Renders a review screen into the session message (edit when clicked from it, otherwise a new message). */
  const show = async (ctx: Ctx, s: Screen, mode: "edit" | "send") => {
    const t = dict(ctx.user.lang);
    if (s.kind === "stale") return toast(ctx, t.staleButton);
    if (s.kind === "noundo") { if (ctx.callbackQuery) return toast(ctx, t.nothingToUndo); await ctx.reply(t.nothingToUndo); return; }
    if (s.kind === "nothing") { await toast(ctx); await send(ctx, { text: t.noDecks, keyboard: [[{ text: t.decksBtn, callback_data: "decks" }]] }); return; }
    const r = s.kind === "card"
      ? renderCard(s.view, s.counts, s.intervals, s.feedback, s.canUndo, ctx.user.lang)
      : renderDone(s.summary, ctx.user.lang, s.feedback);
    const id = await editOrSend(ctx, mode === "edit" ? clickedId(ctx) : undefined, r);
    await repo.setSessionMessage(ctx.user.id, ctx.user.chatId, id, s.kind === "card" ? s.view.cardId : null);
    await toast(ctx);
    if (s.kind === "card" && ctx.user.autoplay && s.view.hasAudio) await playVoice(repo, tg, ctx.user, s.view.noteId);
  };

  const onError = async (err: { ctx: Ctx; error: unknown }) => {
    const ctx = err.ctx;
    const lang = ctx.user?.lang ?? langFromTelegram(ctx.from?.language_code);
    if (isD1Limit(err.error)) await ctx.reply(dict(lang).maintenance).catch(() => undefined);
    else console.error("handler error", err.error);
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => undefined);
  };
  bot.catch(onError);
  /** Webhooks bypass bot.catch, so every handler lives inside an error boundary (Telegram must always get 200). */
  const c = bot.errorBoundary(onError);

  c.use(async (ctx, next) => {
    if (!ctx.from || ctx.chat?.type !== "private") return;
    const { user } = await getOrCreate(repo, ctx.from.id, ctx.chat.id, ctx.from.language_code, deps.now());
    ctx.user = user;
    await next();
  });

  /* onboarding */
  const renderOb = async (ctx: Ctx, screen: ReturnType<typeof startOnboarding>, lang = ctx.user.lang): Promise<Rendered> => {
    if (screen.kind === "deck") return renderOnboarding(screen, lang, await repo.getDeckBySlug(screen.slug));
    if (screen.kind === "deckList") {
      const all = await repo.listDecksForUser(ctx.user.id, deps.now());
      return renderOnboarding(screen, lang, null, all.filter((d) => d.kind === "catalog"));
    }
    return renderOnboarding(screen, lang);
  };
  const answerOb = async (ctx: Ctx, answer: string, messageId?: number) => {
    const screen = await advanceOnboarding(repo, ctx.user, answer, deps.now());
    if (screen.kind === "invalid") { if (ctx.callbackQuery) return toast(ctx, dict(ctx.user.lang).chooseAbove); await ctx.reply(dict(ctx.user.lang).chooseAbove); return; }
    const lang = screen.kind === "placement" && screen.index === 0 && (answer === "ru" || answer === "en") ? answer : ctx.user.lang;
    await editOrSend(ctx, messageId, await renderOb(ctx, screen, lang));
    await toast(ctx);
  };

  c.command("start", async (ctx) => {
    const t = dict(ctx.user.lang);
    if (!ctx.user.onboardingStep) { await send(ctx, { text: t.alreadySetUp, keyboard: learnKeyboard(ctx.user.lang) }); return; }
    await send(ctx, await renderOb(ctx, startOnboarding(ctx.user, deps.now())));
  });
  c.callbackQuery(/^ob:(.+)$/, async (ctx) => {
    if (!ctx.user.onboardingStep) return toast(ctx);
    await answerOb(ctx, ctx.match[1]!, clickedId(ctx));
  });

  /** Commands other than /start only work after onboarding. */
  const ready = async (ctx: Ctx) => {
    if (!ctx.user.onboardingStep) return true;
    await ctx.reply(dict(ctx.user.lang).chooseAbove);
    return false;
  };

  /* review */
  c.command("learn", async (ctx) => { if (await ready(ctx)) await show(ctx, await reviews().nextScreen(ctx.user), "send"); });
  c.callbackQuery("learn", async (ctx) => { if (await ready(ctx)) await show(ctx, await reviews().nextScreen(ctx.user), "send"); });
  c.callbackQuery(/^g:(\d+):(\d+):([1-4])$/, async (ctx) => {
    const [, id, reps, r] = ctx.match;
    await show(ctx, await reviews().grade(ctx.user, Number(id), Number(reps), Number(r) as Rating), "edit");
  });
  c.callbackQuery("u", async (ctx) => {
    const s = await reviews().undo(ctx.user);
    if (s.kind === "card") await ctx.answerCallbackQuery({ text: dict(ctx.user.lang).undone }).catch(() => undefined);
    await show(ctx, s, "edit");
  });
  c.command("undo", async (ctx) => { if (await ready(ctx)) await show(ctx, await reviews().undo(ctx.user), "send"); });
  c.callbackQuery(/^v:(\d+)$/, async (ctx) => { await toast(ctx); await playVoice(repo, tg, ctx.user, Number(ctx.match[1])); });

  /* decks */
  c.command("decks", async (ctx) => { if (await ready(ctx)) await send(ctx, renderDecks(await repo.listDecksForUser(ctx.user.id, deps.now()), ctx.user.lang)); });
  c.callbackQuery("decks", async (ctx) => { await toast(ctx); await send(ctx, renderDecks(await repo.listDecksForUser(ctx.user.id, deps.now()), ctx.user.lang)); });
  c.callbackQuery(/^sub:(\d+)$/, async (ctx) => {
    const deck = await repo.getDeck(Number(ctx.match[1]));
    if (!deck || (deck.kind !== "catalog" && deck.ownerId !== ctx.user.id)) return toast(ctx);
    await repo.subscribe(ctx.user.id, deck.id, deps.now());
    await editOrSend(ctx, clickedId(ctx), { text: dict(ctx.user.lang).deckSubscribed(esc(deckTitle(deck, ctx.user.lang))), keyboard: learnKeyboard(ctx.user.lang) });
    await toast(ctx);
  });
  c.command("gen", async (ctx) => {
    if (!(await ready(ctx))) return;
    const t = dict(ctx.user.lang);
    const topic = String(ctx.match ?? "").trim().slice(0, 100);
    if (!topic) { await ctx.reply(t.genUsage, HTML); return; }
    const m = await ctx.reply(t.genWorking(esc(topic)), HTML);
    const user = ctx.user;
    deps.waitUntil((async () => {
      try {
        const res = await content().generateDeck(user, topic, 20);
        const r: Rendered = res.kind === "limit" ? { text: t.genLimit, keyboard: [] }
          : res.kind === "failed" ? { text: t.genFailed, keyboard: [] }
          : renderGenPreview(res.topic, res.items, await remaining((await repo.getUser(user.id))!, "gen", deps.now()), res.previewId, user.lang);
        await editOrSend(ctx, m.message_id, r);
      } catch (e) {
        await editOrSend(ctx, m.message_id, { text: isD1Limit(e) ? t.maintenance : t.genFailed, keyboard: [] }).catch(() => undefined);
      }
    })());
  });
  c.callbackQuery(/^gen:(ok|no):(\d+)$/, async (ctx) => {
    const t = dict(ctx.user.lang);
    const id = Number(ctx.match[2]);
    if (ctx.match[1] === "no") { await content().cancel(ctx.user, id); await editOrSend(ctx, clickedId(ctx), { text: t.genCancelled, keyboard: [] }); return toast(ctx); }
    try {
      const d = await content().confirmDeck(ctx.user, id);
      await editOrSend(ctx, clickedId(ctx), { text: t.genAdded(esc(d.title), d.count), keyboard: learnKeyboard(ctx.user.lang) });
    } catch { await editOrSend(ctx, clickedId(ctx), { text: t.previewExpired, keyboard: [] }); }
    await toast(ctx);
  });

  /* custom words */
  c.callbackQuery(/^add:(ok|edit|no):(\d+)$/, async (ctx) => {
    const t = dict(ctx.user.lang);
    const id = Number(ctx.match[2]);
    const svc = content();
    if (ctx.match[1] === "no") { await svc.cancel(ctx.user, id); await editOrSend(ctx, clickedId(ctx), { text: t.notAdded, keyboard: [] }); return toast(ctx); }
    if (ctx.match[1] === "edit") {
      const items = await svc.startEdit(ctx.user, id);
      await toast(ctx);
      await ctx.reply(items ? t.editAsk(esc(items[0]!.word)) : t.previewExpired);
      return;
    }
    try {
      const r = await svc.confirmAdd(ctx.user, id);
      await editOrSend(ctx, clickedId(ctx), { text: t.added(r.words.map((w) => `<b>${esc(w)}</b>`).join(", ")), keyboard: learnKeyboard(ctx.user.lang) });
    } catch { await editOrSend(ctx, clickedId(ctx), { text: t.previewExpired, keyboard: [] }); }
    await toast(ctx);
  });

  /* settings, stats, help */
  c.command("settings", async (ctx) => { if (await ready(ctx)) await send(ctx, renderSettings(ctx.user)); });
  c.callbackQuery(/^set:(lang|ret|new|rem|dir|auto)$/, async (ctx) => {
    const u = ctx.user;
    const cycle = <T>(list: readonly T[], v: T) => list[(list.indexOf(v) + 1) % list.length]!;
    switch (ctx.match[1]) {
      case "lang": await setSetting(repo, u.id, "lang", u.lang === "ru" ? "en" : "ru", deps.now()); break;
      case "ret": await setSetting(repo, u.id, "retention", cycle(RETENTIONS, u.retention as (typeof RETENTIONS)[number]), deps.now()); break;
      case "new": await setSetting(repo, u.id, "newPerDay", cycle([5, 10, 20] as const, u.newPerDay as 5), deps.now()); break;
      case "rem": await setSetting(repo, u.id, "remindAt", cycle(REMIND_TIMES, u.remindAt as (typeof REMIND_TIMES)[number]), deps.now()); break;
      case "dir": await setSetting(repo, u.id, "direction", cycle(["en_ru", "ru_en", "both"] as const, u.direction), deps.now()); break;
      case "auto": await setSetting(repo, u.id, "autoplay", !u.autoplay, deps.now()); break;
    }
    const updated = (await repo.getUser(u.id))!;
    ctx.user = updated;
    await editOrSend(ctx, clickedId(ctx), renderSettings(updated));
    await toast(ctx);
  });
  c.command("stats", async (ctx) => { if (await ready(ctx)) await ctx.reply(renderStats(await cumulative(repo, ctx.user, deps.now()), ctx.user.lang), HTML); });
  c.command("help", async (ctx) => { await ctx.reply(dict(ctx.user.lang).help, HTML); });
  c.callbackQuery("help:add", async (ctx) => { await toast(ctx); await ctx.reply(dict(ctx.user.lang).helpAdd, HTML); });

  /* admin */
  c.command("admin", async (ctx) => {
    if (!isAdmin(ctx.user, config)) return;
    await ctx.reply(await adminStatsText(repo, deps.now()), HTML);
  });
  c.on("message:document", async (ctx) => {
    if (!isAdmin(ctx.user, config)) return;
    const doc = ctx.message.document;
    const caption = ctx.message.caption ?? "";
    const file = await ctx.api.getFile(doc.file_id);
    const res = await deps.fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
    await ctx.reply(await importDeckCsv(repo, await res.text(), caption, deps.now()), HTML);
  });

  /* free text: onboarding answers, manual translations, custom words */
  c.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const t = dict(ctx.user.lang);
    if (text.startsWith("/")) { await ctx.reply(t.unknownCommand); return; }
    if (ctx.user.onboardingStep) {
      if (ctx.user.onboardingStep === "tz") return answerOb(ctx, text);
      await ctx.reply(t.chooseAbove);
      return;
    }
    const svc = content();
    const pending = svc.pendingKind(ctx.user);
    if (pending === "manual") {
      const word = await svc.completeManual(ctx.user, text);
      if (word) { await send(ctx, { text: t.added(`<b>${esc(word)}</b>`), keyboard: learnKeyboard(ctx.user.lang) }); return; }
    }
    if (pending === "preview") {
      try {
        const r = await svc.editPreviewTranslation(ctx.user, text);
        await send(ctx, renderAddPreview(r.items, r.previewId, ctx.user.lang));
      } catch { await ctx.reply(t.previewExpired); }
      return;
    }
    const m = await ctx.reply(t.searching);
    const user = ctx.user;
    const entities = (ctx.message.entities ?? []).map((e) => ({ type: e.type, offset: e.offset, length: e.length, url: "url" in e ? (e as { url?: string }).url : undefined }));
    deps.waitUntil((async () => {
      try {
        const res = await svc.prepareAdd(user, text, entities);
        const dups = "duplicates" in res ? res.duplicates.map((d) => t.dupLine(esc(d.word), esc(d.deckTitle), d.linkAdded)) : [];
        const prefix = dups.length ? dups.join("\n") + "\n\n" : "";
        let r: Rendered;
        if (res.kind === "ask-words") r = { text: t.askWords(esc(hostOf(res.url))), keyboard: [] };
        else if (res.kind === "empty") r = { text: t.helpAdd, keyboard: [] };
        else if (res.kind === "duplicates-only") r = { text: dups.join("\n"), keyboard: learnKeyboard(user.lang) };
        else if (res.kind === "manual") r = { text: prefix + t.manualAsk(esc(res.word)) + (res.others.length ? "\n\n" + t.notTranslated(res.others.map(esc).join(", ")) : ""), keyboard: [] };
        else {
          const p = renderAddPreview(res.items, res.previewId, user.lang);
          const tail = res.manual.length ? "\n\n" + t.notTranslated(res.manual.map(esc).join(", ")) : "";
          r = { text: prefix + p.text + tail, keyboard: p.keyboard };
        }
        await editOrSend(ctx, m.message_id, r);
      } catch (e) {
        console.error("add words failed", e);
        await editOrSend(ctx, m.message_id, { text: isD1Limit(e) ? t.maintenance : t.genFailed, keyboard: [] }).catch(() => undefined);
      }
    })());
  });

  return bot;
}

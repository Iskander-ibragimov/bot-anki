import { Bot, type Context, GrammyError, InputFile } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { isAdmin, adminStatsText, importDeckCsv } from "../admin/service";
import { type Synth, playVoice } from "../content/audio";
import { DictionaryClient } from "../content/dictionary";
import { LlmClient } from "../content/llm";
import { type AutoResult, type Awaiting, ContentService, type EntryResult, type PhotoAsk, tokenOf } from "../content/service";
import { VisionClient } from "../content/vision";
import type { Repo, User } from "../db/repo";
import { remaining } from "../entitlements/service";
import type { Config } from "../env";
import { dict } from "../i18n";
import { ReviewService, type Screen } from "../review/service";
import type { Rating } from "../srs/fsrs";
import { cumulative } from "../stats/service";
import { type TgApi, TgUpload } from "../tg/client";
import { REMIND_TIMES, RETENTIONS, advanceOnboarding, getOrCreate, langFromTelegram, setSetting, startOnboarding } from "../users/service";
import { deckTitle, learnKeyboard, renderDecks, renderGenPreview, renderOnboarding, renderSettings, renderStats } from "./screens";
import { type Keyboard, type Rendered, esc, hostOf, renderAddPreview, renderAwait, renderCard, renderDeleteAsk, renderDone, renderMyWords, renderPhotoAsk, renderWord } from "./views";

export interface BotDeps {
  config: Config;
  repo: Repo;
  fetch: typeof fetch;
  waitUntil(p: Promise<unknown>): void;
  now(): number;
  /** Speech synthesis for words without recorded audio; absent when the AI binding is not configured. */
  synth?: Synth;
}

type Ctx = Context & { user: User };
const HTML = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };
const isD1Limit = (e: unknown) => /daily row (read|write) limit|exceeded D1/i.test(String((e as Error)?.message ?? e));

export function createBot(deps: BotDeps, botInfo?: UserFromGetMe): Bot<Ctx> {
  const { repo, config } = deps;
  const bot = new Bot<Ctx>(config.botToken, botInfo ? { botInfo } : {});
  const tg: TgApi = {
    call: <T>(m: string, p: Record<string, unknown>) => {
      const payload = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v instanceof TgUpload ? new InputFile(v.bytes, v.filename) : v]));
      return (bot.api.raw as unknown as Record<string, (x: unknown) => Promise<T>>)[m]!(payload);
    },
  };
  const vision = new VisionClient(config.visionProviders, deps.fetch);
  const content = () => new ContentService(repo, { dict: new DictionaryClient(deps.fetch), llm: new LlmClient(config.llmProviders, deps.fetch), vision }, deps.now());
  const reviews = () => new ReviewService(repo, deps.now());

  const markup = (keyboard: Keyboard) => (keyboard.length ? { inline_keyboard: keyboard } : undefined);
  /** Sends a screen; a card with a picture goes as a photo (blurred until tapped) with the text as its caption. */
  const send = async (ctx: Ctx, r: Rendered, silent = false) => {
    const extra = { reply_markup: markup(r.keyboard), ...(silent ? { disable_notification: true } : {}) };
    if (r.photo) {
      try {
        return await ctx.api.sendPhoto(ctx.user.chatId, r.photo, { caption: r.text, parse_mode: "HTML", has_spoiler: true, ...extra });
      } catch (e) {
        if (!(e instanceof GrammyError)) throw e; // a broken file id or an over-long caption: show the card as text
      }
    }
    return ctx.api.sendMessage(ctx.user.chatId, r.text, { ...HTML, ...extra });
  };
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

  /**
   * Shows a review screen. With `replace` (after a grade, undo or a new picture) it sends a NEW message and deletes that one:
   * Telegram clients keep a spoiler revealed when a message is edited, so every card needs its own message.
   */
  const show = async (ctx: Ctx, s: Screen, replace?: number) => {
    const t = dict(ctx.user.lang);
    if (s.kind === "stale") return toast(ctx, t.staleButton);
    if (s.kind === "noundo") { if (ctx.callbackQuery) return toast(ctx, t.nothingToUndo); await ctx.reply(t.nothingToUndo); return; }
    if (s.kind === "nothing") { await toast(ctx); await send(ctx, { text: t.noDecks, keyboard: [[{ text: t.decksBtn, callback_data: "decks" }]] }); return; }
    const r = s.kind === "card"
      ? renderCard(s.view, s.counts, s.intervals, s.canUndo, ctx.user.lang)
      : renderDone(s.summary, ctx.user.lang);
    const cardId = s.kind === "card" ? s.view.cardId : null;
    const chatId = ctx.user.chatId;
    if (replace === undefined) {
      const m = await send(ctx, r);
      await repo.setSessionMessage(ctx.user.id, chatId, m.message_id, cardId);
    } else {
      const m = await send(ctx, r, true);
      const oldVoice = await repo.replaceSessionMessage(ctx.user.id, chatId, m.message_id, cardId);
      await Promise.all([
        // Bots can't delete messages older than 48 h; then at least take the buttons off the old card.
        ctx.api.deleteMessage(chatId, replace).catch(() => ctx.api.editMessageReplyMarkup(chatId, replace).catch(() => undefined)),
        oldVoice ? ctx.api.deleteMessage(chatId, oldVoice).catch(() => undefined) : undefined,
      ]);
    }
    await toast(ctx);
    if (s.kind === "card" && ctx.user.autoplay) await playVoice(repo, tg, ctx.user, s.view.noteId, deps.synth);
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
  c.command("learn", async (ctx) => { if (await ready(ctx)) await show(ctx, await reviews().nextScreen(ctx.user)); });
  c.callbackQuery("learn", async (ctx) => { if (await ready(ctx)) await show(ctx, await reviews().nextScreen(ctx.user)); });
  c.callbackQuery(/^g:(\d+):(\d+):([1-4])$/, async (ctx) => {
    const [, id, reps, r] = ctx.match;
    await show(ctx, await reviews().grade(ctx.user, Number(id), Number(reps), Number(r) as Rating), clickedId(ctx));
  });
  c.callbackQuery("u", async (ctx) => {
    const s = await reviews().undo(ctx.user);
    if (s.kind === "card") await ctx.answerCallbackQuery({ text: dict(ctx.user.lang).undone }).catch(() => undefined);
    await show(ctx, s, clickedId(ctx));
  });
  c.command("undo", async (ctx) => { if (await ready(ctx)) await show(ctx, await reviews().undo(ctx.user)); });
  c.callbackQuery(/^v:(\d+)$/, async (ctx) => {
    const played = await playVoice(repo, tg, ctx.user, Number(ctx.match[1]), deps.synth);
    await toast(ctx, played ? undefined : dict(ctx.user.lang).voiceUnavailable);
  });

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

  /* own cards: one card per message, English and Russian in any order */
  type RawEntity = { type: string; offset: number; length: number; url?: string };
  const toEntities = (list: readonly RawEntity[] | undefined, shift = 0) =>
    (list ?? []).filter((e) => e.offset >= shift).map((e) => ({ type: e.type, offset: e.offset - shift, length: e.length, url: e.url }));

  const renderEntry = (res: EntryResult | AutoResult, lang: User["lang"]): Rendered => {
    const t = dict(lang);
    switch (res.kind) {
      case "empty": return { text: t.helpAdd, keyboard: [] };
      case "ask-words": return { text: t.askWords(esc(hostOf(res.url))), keyboard: [] };
      case "too-many": return { text: t.oneAtATime, keyboard: [] };
      case "unclear": return { text: t.unclearEntry, keyboard: [] };
      case "duplicate": {
        const d = res.duplicate;
        return { text: t.dupLine(esc(d.word), esc(d.deckTitle), d.linkAdded, d.imageAdded), keyboard: learnKeyboard(lang) };
      }
      case "await": return renderAwait(res, lang);
      case "failed": return { text: t.autoFailed(esc(res.text), res.side === "en"), keyboard: renderAwait(res, lang).keyboard };
      case "preview": return renderAddPreview(res.item, res.previewId, lang);
    }
  };

  const addFlow = async (ctx: Ctx, text: string, entities: ReturnType<typeof toEntities>, imageFileId?: string) => {
    const res = await content().addEntry(ctx.user, text, entities, imageFileId ? { imageFileId } : {});
    await send(ctx, renderEntry(res, ctx.user.lang));
  };

  const gone = async (ctx: Ctx) => { await editOrSend(ctx, clickedId(ctx), { text: dict(ctx.user.lang).awaitGone, keyboard: [] }); await toast(ctx); };
  /** Translates a claimed side with AI and turns the tapped message into the card preview. */
  const runAuto = async (ctx: Ctx, waiting: Awaiting) => {
    const user = ctx.user;
    const t = dict(user.lang);
    const svc = content();
    const shown = await editOrSend(ctx, clickedId(ctx), { text: t.translating, keyboard: [] });
    await toast(ctx);
    // The AI call is slow: it runs after the webhook has answered.
    deps.waitUntil((async () => {
      try {
        await editOrSend(ctx, shown, renderEntry(await svc.autoTranslate(user, waiting), user.lang));
      } catch (e) {
        console.error("auto translate failed", e);
        const retry = renderEntry({ kind: "failed", side: waiting.side, text: waiting.text, token: tokenOf(waiting) }, user.lang);
        await editOrSend(ctx, shown, isD1Limit(e) ? { text: t.maintenance, keyboard: [] } : retry).catch(() => undefined);
      }
    })());
  };

  /** "Translate automatically" / "don't add" under the request for the other side. */
  c.callbackQuery(/^tr:(auto|no):(\w+)$/, async (ctx) => {
    const svc = content();
    const token = ctx.match[2]!;
    if (ctx.match[1] === "no") {
      if (!(await svc.cancelAwait(ctx.user, token))) return gone(ctx);
      await editOrSend(ctx, clickedId(ctx), { text: dict(ctx.user.lang).notAdded, keyboard: [] });
      return toast(ctx);
    }
    // Claimed before answering: whatever the user types while the translation runs starts a new card.
    const waiting = await svc.takeAwait(ctx.user, token);
    return waiting ? runAuto(ctx, waiting) : gone(ctx);
  });

  /** Buttons under a picture: a word read from it, the whole phrase, or "don't add". */
  c.callbackQuery(/^ph:(w|all|no):(\w+?)(?::(\d+))?$/, async (ctx) => {
    const svc = content();
    const token = ctx.match[2]!;
    if (ctx.match[1] === "no") {
      if (!(await svc.cancelPhoto(ctx.user, token))) return gone(ctx);
      await editOrSend(ctx, clickedId(ctx), { text: dict(ctx.user.lang).notAdded, keyboard: [] });
      return toast(ctx);
    }
    const waiting = await svc.pickFromPhoto(ctx.user, token, ctx.match[1] === "all" ? "all" : Number(ctx.match[3] ?? -1));
    return waiting ? runAuto(ctx, waiting) : gone(ctx);
  });

  c.callbackQuery(/^add:(ok|edit|no):(\d+)$/, async (ctx) => {
    const t = dict(ctx.user.lang);
    const id = Number(ctx.match[2]);
    const svc = content();
    if (ctx.match[1] === "no") { await svc.cancel(ctx.user, id); await editOrSend(ctx, clickedId(ctx), { text: t.notAdded, keyboard: [] }); return toast(ctx); }
    if (ctx.match[1] === "edit") {
      const items = await svc.startEdit(ctx.user, id);
      await toast(ctx);
      await ctx.reply(items ? t.editAsk(esc(items[0]!.word)) : t.previewExpired, HTML);
      return;
    }
    let saved: { word: string; total: number };
    try { saved = await svc.confirmAdd(ctx.user, id); } catch { return toast(ctx, t.staleButton); } // tapped twice, or the preview has expired
    await editOrSend(ctx, clickedId(ctx), {
      text: t.addedOne(esc(saved.word), saved.total),
      keyboard: [[{ text: t.learnBtn, callback_data: "learn", style: "primary" }], [{ text: t.moreBtn, callback_data: "help:add" }, { text: t.myWordsBtn, callback_data: "mywords" }]],
    });
    await toast(ctx);
  });

  /* "My words": the list, one word, edit, picture, delete */
  c.command("mywords", async (ctx) => { if (await ready(ctx)) await send(ctx, renderMyWords(await content().myWords(ctx.user, 0), ctx.user.lang)); });
  c.callbackQuery("mywords", async (ctx) => { await toast(ctx); await send(ctx, renderMyWords(await content().myWords(ctx.user, 0), ctx.user.lang)); });
  c.callbackQuery(/^mw:p:(\d+)$/, async (ctx) => {
    await editOrSend(ctx, clickedId(ctx), renderMyWords(await content().myWords(ctx.user, Number(ctx.match[1])), ctx.user.lang));
    await toast(ctx);
  });
  c.callbackQuery(/^mw:(o|e|i|d|dy):(\d+):(\d+)$/, async (ctx) => {
    const t = dict(ctx.user.lang);
    const lang = ctx.user.lang;
    const [, action, idText, pageText] = ctx.match;
    const noteId = Number(idText), page = Number(pageText);
    const svc = content();
    const note = await svc.myWord(ctx.user, noteId);
    if (!note) {
      // deleted meanwhile: back to the list
      await editOrSend(ctx, clickedId(ctx), renderMyWords(await svc.myWords(ctx.user, page), lang));
      return toast(ctx, t.wordGone);
    }
    switch (action) {
      case "o": await editOrSend(ctx, clickedId(ctx), renderWord(note, page, lang)); return toast(ctx);
      case "d": await editOrSend(ctx, clickedId(ctx), renderDeleteAsk(note.word, noteId, page, lang)); return toast(ctx);
      case "dy": {
        const word = await svc.deleteWord(ctx.user, noteId);
        await editOrSend(ctx, clickedId(ctx), renderMyWords(await svc.myWords(ctx.user, page), lang));
        return toast(ctx, word ? t.wordDeleted(word) : t.wordGone);
      }
      case "e":
        await svc.startWordEdit(ctx.user, noteId, page);
        await toast(ctx);
        await ctx.reply(t.wordEditAsk(esc(note.word)), HTML);
        return;
      case "i": return askForPicture(ctx, noteId, page);
    }
  });

  /* a picture for a word the user already has: asked for with a button, never guessed */
  const askForPicture = async (ctx: Ctx, noteId: number, page: number | null) => {
    const t = dict(ctx.user.lang);
    const r = await content().askPicture(ctx.user, noteId, page);
    if (!r) return toast(ctx, t.staleButton);
    await toast(ctx);
    await send(ctx, r.hasImage
      ? { text: t.picAskReplace(esc(r.word)), keyboard: [[{ text: t.picRemoveBtn, callback_data: `pic:rm:${noteId}` }]] }
      : { text: t.picAsk(esc(r.word)), keyboard: [] });
  };
  /** If the review card on screen is this word, sends it again so that it shows the change. */
  const refreshCardOf = async (ctx: Ctx, noteId: number): Promise<boolean> => {
    const session = await repo.getSession(ctx.user.id);
    const card = session?.cardId ? await repo.getCard(ctx.user.id, session.cardId) : null;
    if (!session || !card || card.noteId !== noteId) return false;
    const screen = await reviews().cardScreen(ctx.user, card.id);
    if (!screen) return false;
    await show(ctx, screen, session.messageId ?? undefined);
    return true;
  };
  c.callbackQuery(/^pic:(\d+)$/, async (ctx) => askForPicture(ctx, Number(ctx.match[1]), null));
  c.callbackQuery(/^pic:rm:(\d+)$/, async (ctx) => {
    const t = dict(ctx.user.lang);
    const noteId = Number(ctx.match[1]);
    const word = await content().removePicture(ctx.user, noteId);
    if (!word) return toast(ctx, t.staleButton);
    await editOrSend(ctx, clickedId(ctx), { text: t.picRemoved(esc(word)), keyboard: [] });
    if (!(await refreshCardOf(ctx, noteId))) await toast(ctx);
  });

  /* settings, stats, help */
  c.command("settings", async (ctx) => { if (await ready(ctx)) await send(ctx, renderSettings(ctx.user)); });
  c.callbackQuery(/^set:(lang|ret|new|rem|dir|ord|auto)$/, async (ctx) => {
    const u = ctx.user;
    const cycle = <T>(list: readonly T[], v: T) => list[(list.indexOf(v) + 1) % list.length]!;
    switch (ctx.match[1]) {
      case "lang": await setSetting(repo, u.id, "lang", u.lang === "ru" ? "en" : "ru", deps.now()); break;
      case "ret": await setSetting(repo, u.id, "retention", cycle(RETENTIONS, u.retention as (typeof RETENTIONS)[number]), deps.now()); break;
      case "new": await setSetting(repo, u.id, "newPerDay", cycle([5, 10, 20] as const, u.newPerDay as 5), deps.now()); break;
      case "rem": await setSetting(repo, u.id, "remindAt", cycle(REMIND_TIMES, u.remindAt as (typeof REMIND_TIMES)[number]), deps.now()); break;
      case "dir": await setSetting(repo, u.id, "direction", cycle(["en_ru", "ru_en", "both"] as const, u.direction), deps.now()); break;
      case "ord": await setSetting(repo, u.id, "newOrder", u.newOrder === "random" ? "deck" : "random", deps.now()); break;
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

  c.command("add", async (ctx) => {
    if (!(await ready(ctx))) return;
    const arg = String(ctx.match ?? "").trim();
    if (!arg) { await ctx.reply(dict(ctx.user.lang).helpAdd, HTML); return; }
    const full = ctx.message?.text ?? arg;
    await addFlow(ctx, arg, toEntities(ctx.message?.entities, full.indexOf(arg)));
  });

  /** The picture itself, for reading the text on it. A size of about 1280 px is enough for subtitles. */
  const loadPhoto = async (ctx: Ctx, sizes: { file_id: string; width: number; height: number }[]) => {
    const fit = sizes.filter((p) => Math.max(p.width, p.height) <= 1280).at(-1) ?? sizes[0]!;
    const file = await ctx.api.getFile(fit.file_id);
    if (!file.file_path) return null;
    const res = await deps.fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
    if (!res.ok) return null;
    return { bytes: new Uint8Array(await res.arrayBuffer()), mime: /\.png$/i.test(file.file_path) ? "image/png" : "image/jpeg" };
  };

  /*
   * A picture is always about a NEW card, unless the user has just asked to attach one to a word:
   * with a caption the caption is the card; without one the text on the picture is read and offered as words.
   */
  c.on("message:photo", async (ctx) => {
    const t = dict(ctx.user.lang);
    const lang = ctx.user.lang;
    if (ctx.user.onboardingStep) { await ctx.reply(t.chooseAbove); return; }
    const sizes = ctx.message.photo;
    const fileId = sizes.at(-1)!.file_id;
    const raw = ctx.message.caption ?? "";
    const cmd = raw.match(/^\s*\/add(?:@\w+)?\s*/)?.[0].length ?? 0; // "/add word" typed as the caption
    if (raw.slice(cmd).trim()) return addFlow(ctx, raw.slice(cmd), toEntities(ctx.message.caption_entities, cmd), fileId);
    if (ctx.message.media_group_id) return; // the other photos of an album: only the captioned one counts
    const svc = content();

    const attached = await svc.attachPendingPicture(ctx.user, fileId); // the picture button was pressed for some word
    if (attached) {
      const inList = attached.page !== null ? await svc.myWord(ctx.user, attached.noteId) : null;
      if (inList) { await send(ctx, renderWord(inList, attached.page!, lang)); return; }
      if (!(await refreshCardOf(ctx, attached.noteId))) await send(ctx, { text: t.picAttached(esc(attached.word)), keyboard: [] });
      return;
    }
    const waiting = await svc.attachImageToAwait(ctx.user, fileId); // "cozy", then a photo: the picture is for that card
    if (waiting) { await send(ctx, renderAwait(waiting, lang, true)); return; }

    const began = await svc.beginPhoto(ctx.user, fileId);
    const blank: PhotoAsk = { text: null, words: [], phrase: null, token: began.token };
    if (!vision.available) { await send(ctx, renderPhotoAsk(blank, lang, false)); return; }
    const m = await ctx.reply(t.readingPhoto);
    // Reading the picture takes seconds: it runs after the webhook has answered.
    deps.waitUntil((async () => {
      let ask: PhotoAsk | null = blank;
      try {
        ask = await svc.readPhoto(began.user, began.token, await loadPhoto(ctx, sizes).catch(() => null));
      } catch (e) {
        console.error("reading a picture failed", e);
      }
      // The user has already typed the word for this picture: nothing to ask.
      if (!ask) { await ctx.api.deleteMessage(ctx.user.chatId, m.message_id).catch(() => undefined); return; }
      await editOrSend(ctx, m.message_id, renderPhotoAsk(ask, lang, true)).catch(() => undefined);
    })());
  });

  /* free text: onboarding answers, a corrected translation, an edited word, own cards */
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
    if (svc.pendingKind(ctx.user) === "preview") {
      try {
        const r = await svc.editPreviewTranslation(ctx.user, text);
        await send(ctx, renderAddPreview(r.items[0]!, r.previewId, ctx.user.lang));
        return;
      } catch {
        // The card being edited is gone (saved, cancelled or expired): this message is a new card.
        await svc.clearPending(ctx.user);
        ctx.user = { ...ctx.user, pendingEdit: null };
      }
    }
    if (svc.pendingKind(ctx.user) === "edit") {
      const r = await svc.applyWordEdit(ctx.user, text, toEntities(ctx.message.entities));
      if (r?.kind === "saved") {
        const note = await svc.myWord(ctx.user, r.noteId);
        if (note) await send(ctx, renderWord(note, r.page, ctx.user.lang));
        return;
      }
      if (r?.kind === "duplicate") { await ctx.reply(t.wordEditDuplicate(esc(r.word)), HTML); return; }
      if (r?.kind === "hint") { await ctx.reply(r.reason === "unclear" ? t.unclearEntry : t.wordEditHint, HTML); return; }
      ctx.user = { ...ctx.user, pendingEdit: null }; // the word is gone: this message is a new card
    }
    await addFlow(ctx, text, toEntities(ctx.message.entities));
  });

  return bot;
}

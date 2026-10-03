import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import fixture from "../fixtures/dictionary-serendipity.json";
import { Repo } from "../../src/db/repo";
import { DictionaryClient } from "../../src/content/dictionary";
import { LlmClient, LlmUnavailable, WordCardSchema } from "../../src/content/llm";
import { ContentService } from "../../src/content/service";
import { consume } from "../../src/entitlements/service";
import { z } from "zod";
import { seedUser } from "../helpers/seed";
import { countingDb } from "../helpers/countingDb";

const T = Date.UTC(2026, 8, 30, 6, 0);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const chat = (content: string) => json({ choices: [{ message: { content } }] });
const P = (baseUrl: string) => ({ baseUrl, apiKey: "k", model: "m" });

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function fakeFetch(h: Handler): typeof fetch & { urls: string[] } {
  const urls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => { const u = String(input instanceof Request ? input.url : input); urls.push(u); return h(u, init); }) as typeof fetch & { urls: string[] };
  f.urls = urls;
  return f;
}
const card = (word: string, translation = "перевод") => ({ word, ipa: null, pos: "adj", translation, exampleEn: `It is ${word}.`, exampleRu: `Это ${translation}.` });

describe("dictionary", () => {
  it("parses fixture", async () => {
    const d = new DictionaryClient(fakeFetch(() => json(fixture)));
    expect(await d.lookup("serendipity")).toEqual({
      ipa: "/ˌsɛɹənˈdɪpɪti/", pos: "noun", exampleEn: "Finding that book was pure serendipity.",
      audioUrl: "https://api.dictionaryapi.dev/media/pronunciations/en/serendipity-us.mp3",
    });
  });
  it("404 gives null", async () => {
    expect(await new DictionaryClient(fakeFetch(() => json({ title: "No Definitions Found" }, 404))).lookup("zzz")).toBeNull();
  });
});

describe("llm", () => {
  const Schema = z.object({ cards: z.array(WordCardSchema) });
  it("falls back to the next provider on malformed json", async () => {
    const f = fakeFetch((u) => (u.startsWith("https://one") ? chat("not json") : chat(JSON.stringify({ cards: [card("cozy", "уютный")] }))));
    const r = await new LlmClient([P("https://one/v1"), P("https://two/v1")], f).completeJson("sys", "user", Schema);
    expect(r.cards[0]!.translation).toBe("уютный");
    expect(f.urls).toEqual(["https://one/v1/chat/completions", "https://two/v1/chat/completions"]);
  });
  it("rejects cyrillic in exampleEn", async () => {
    const f = fakeFetch(() => chat(JSON.stringify({ cards: [{ ...card("cozy", "уютный"), exampleEn: "Это уютно." }] })));
    await expect(new LlmClient([P("https://one/v1")], f).completeJson("s", "u", Schema)).rejects.toBeInstanceOf(LlmUnavailable);
  });
  it("accepts fenced json and throws when all fail", async () => {
    const ok = fakeFetch(() => chat("```json\n" + JSON.stringify({ cards: [card("cozy", "уютный")] }) + "\n```"));
    expect((await new LlmClient([P("https://one/v1")], ok).completeJson("s", "u", Schema)).cards).toHaveLength(1);
    const bad = fakeFetch(() => json({ error: "rate" }, 429));
    await expect(new LlmClient([P("https://one/v1"), P("https://two/v1")], bad).completeJson("s", "u", Schema)).rejects.toBeInstanceOf(LlmUnavailable);
  });
});

function service(repo: Repo, now: number, llmCards: ReturnType<typeof card>[] | "fail" = []) {
  const f = fakeFetch((u) => {
    if (u.includes("dictionaryapi")) return u.includes("serendipity") ? json(fixture) : json({}, 404);
    if (llmCards === "fail") return json({}, 500);
    return chat(JSON.stringify({ cards: llmCards }));
  });
  return new ContentService(repo, { dict: new DictionaryClient(f), llm: new LlmClient([P("https://llm/v1")], f) }, now);
}

describe("content service", () => {
  it("previews a word with its link, dictionary ipa and audio, then adds it to My words", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const svc = service(repo, T, [card("serendipity", "счастливая случайность")]);
    const r = await svc.prepareAdd(user, "serendipity https://example.com/a", []);
    if (r.kind !== "preview") throw new Error(r.kind);
    expect(r.items[0]).toMatchObject({ word: "serendipity", ipa: "/ˌsɛɹənˈdɪpɪti/", translation: "счастливая случайность", sourceUrl: "https://example.com/a", audioUrl: expect.stringContaining(".mp3") });
    const added = await svc.confirmAdd(user, r.previewId);
    expect(added.words).toEqual(["serendipity"]);
    const hit = await repo.findNoteForUser(user.id, "Serendipity");
    expect(hit).toMatchObject({ sourceUrl: "https://example.com/a", deckTitleRu: "Мои слова" });
    await expect(svc.confirmAdd(user, r.previewId)).rejects.toThrow();
    const jobs = await env.DB.prepare("SELECT kind, payload, dedup_key FROM jobs").all<{ kind: string; payload: string; dedup_key: string }>();
    expect(jobs.results).toHaveLength(1);
    expect(jobs.results[0]).toMatchObject({ kind: "voice", dedup_key: expect.stringMatching(/^voice:\d+$/) });
    expect(JSON.parse(jobs.results[0]!.payload).audioUrl).toContain(".mp3");
  });

  it("duplicate in a subscribed deck is not added again but gets the link", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const svc = service(repo, T, []);
    const r = await svc.prepareAdd(user, " Borrow  https://x.com/v", []);
    expect(r).toMatchObject({ kind: "duplicates-only", duplicates: [{ word: "Borrow", deckTitle: "A2 · Базовый", linkAdded: true }] });
    expect((await repo.findNoteForUser(user.id, "borrow"))!.sourceUrl).toBe("https://x.com/v");
    const shared = await env.DB.prepare("SELECT source_url FROM notes WHERE word_key = 'borrow'").first<{ source_url: string | null }>();
    expect(shared!.source_url).toBeNull();
    const notes = await env.DB.prepare("SELECT COUNT(*) AS n FROM notes").first<{ n: number }>();
    expect(notes!.n).toBe(1);
  });

  it("pending url applies to the next words within 10 minutes only", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const ask = await service(repo, T).prepareAdd(user, "https://youtu.be/q", []);
    expect(ask).toEqual({ kind: "ask-words", url: "https://youtu.be/q" });
    const u = (await repo.getUser(user.id))!;
    const r = await service(repo, T + 9 * 60_000, [card("cozy", "уютный")]).prepareAdd(u, "cozy", []);
    if (r.kind !== "preview") throw new Error(r.kind);
    expect(r.items[0]!.sourceUrl).toBe("https://youtu.be/q");
    await service(repo, T, []).prepareAdd((await repo.getUser(user.id))!, "https://youtu.be/z", []);
    const late = await service(repo, T + 11 * 60_000, [card("cozy", "уютный")]).prepareAdd((await repo.getUser(user.id))!, "cozy", []);
    if (late.kind !== "preview") throw new Error(late.kind);
    expect(late.items[0]!.sourceUrl).toBeNull();
  });

  it("falls back to manual translation when AI is unavailable", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const svc = service(repo, T, "fail");
    const r = await svc.prepareAdd(user, "cozy https://c.com", []);
    expect(r).toMatchObject({ kind: "manual", word: "cozy" });
    const word = await svc.completeManual((await repo.getUser(user.id))!, "уютный");
    expect(word).toBe("cozy");
    expect(await repo.findNoteForUser(user.id, "cozy")).toMatchObject({ translation: "уютный", sourceUrl: "https://c.com" });
    expect((await repo.getUser(user.id))!.pendingEdit).toBeNull();
  });

  it("edit changes the preview translation", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const svc = service(repo, T, [card("cozy", "уютный")]);
    const r = await svc.prepareAdd(user, "cozy", []);
    if (r.kind !== "preview") throw new Error(r.kind);
    await svc.startEdit(user, r.previewId);
    const edited = await svc.editPreviewTranslation((await repo.getUser(user.id))!, "тёплый, уютный");
    expect(edited.previewId).toBe(r.previewId);
    expect(edited.items[0]!.translation).toBe("тёплый, уютный");
  });

  it("gen limit is 3 per local day and resets at 04:00 local", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    for (let i = 0; i < 3; i++) expect(await consume(repo, (await repo.getUser(user.id))!, "gen", T)).toBe(true);
    expect(await consume(repo, (await repo.getUser(user.id))!, "gen", T)).toBe(false);
    const next4am = Date.UTC(2026, 9, 1, 1, 1); // 04:01 local next day
    expect(await consume(repo, (await repo.getUser(user.id))!, "gen", next4am)).toBe(true);
  });

  it("generateDeck clamps n and creates a subscribed AI deck on confirm", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const cards = Array.from({ length: 12 }, (_, i) => card(`word${i}`, `слово${i}`));
    let prompt = "";
    const f = fakeFetch((_u, init) => { prompt = String(init?.body); return chat(JSON.stringify({ cards })); });
    const svc = new ContentService(repo, { dict: new DictionaryClient(f), llm: new LlmClient([P("https://llm/v1")], f) }, T);
    const r = await svc.generateDeck(user, "собеседование в IT", 99);
    if (r.kind !== "preview") throw new Error(r.kind);
    expect(prompt).toContain("30");
    expect(r.items).toHaveLength(12);
    const d = await svc.confirmDeck(user, r.previewId);
    expect(d.count).toBe(12);
    expect(await repo.userDeckIds(user.id)).toContain(d.deckId);
    expect((await repo.getDeck(d.deckId))!.titleRu).toBe("🤖 собеседование в IT");
  });

  it("20 words stay within the Workers subrequest budget", async () => {
    const { user } = await seedUser(env.DB, { now: T, words: 1 });
    const words = Array.from({ length: 20 }, (_, i) => `word${i}`);
    const f = fakeFetch((u) => (u.includes("dictionaryapi") ? json({}, 404) : chat(JSON.stringify({ cards: words.map((w) => card(w, "слово")) }))));
    const db = countingDb(env.DB);
    const svc = new ContentService(new Repo(db), { dict: new DictionaryClient(f), llm: new LlmClient([P("https://llm/v1")], f) }, T);
    const r = await svc.prepareAdd(user, words.join("\n"), []);
    expect(r.kind).toBe("preview");
    expect(db.calls + f.urls.length).toBeLessThanOrEqual(26);
  });

  it("one invalid card does not sink the batch and untranslated words are all reported", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const svc = service(repo, T, [card("cozy", "уютный"), { ...card("iphone", "iPhone") }]);
    const r = await svc.prepareAdd(user, "cozy\niphone\nthrive", []);
    if (r.kind !== "preview") throw new Error(r.kind);
    expect(r.items.map((i) => i.word)).toEqual(["cozy"]);
    expect(r.manual).toEqual(["iphone", "thrive"]);
  });

  it("manual fallback mentions every untranslated word", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const r = await service(repo, T, "fail").prepareAdd(user, "cozy\nthrive\nawkward", []);
    expect(r).toMatchObject({ kind: "manual", word: "cozy", others: ["thrive", "awkward"] });
  });

  it("a hanging provider is cut off by the overall deadline", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const hang = fakeFetch((u, init) => {
      if (u.includes("dictionaryapi")) return json({}, 404);
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    const svc = new ContentService(repo, { dict: new DictionaryClient(hang), llm: new LlmClient([P("https://a/v1"), P("https://b/v1")], hang) }, T, { deadlineMs: 300 });
    const started = Date.now();
    const r = await svc.prepareAdd(user, "cozy", []);
    expect(r.kind).toBe("manual");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("failed generation refunds the daily quota", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const r = await service(repo, T, "fail").generateDeck(user, "space", 10);
    expect(r.kind).toBe("failed");
    expect((await repo.getUser(user.id))!.gensCount).toBe(0);
  });

  it("a line with the user's own translation needs no AI", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const r = await service(repo, T, "fail").prepareAdd(user, "serendipity — счастливая случайность", []);
    if (r.kind !== "preview") throw new Error(r.kind);
    expect(r.items[0]).toMatchObject({ word: "serendipity", translation: "счастливая случайность", ipa: "/ˌsɛɹənˈdɪpɪti/", exampleEn: "Finding that book was pure serendipity.", exampleRu: "" });
    expect(r.manual).toEqual([]);
  });

  it("a picture sent with a new word is stored for that user's card", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1, patch: { newPerDay: 20 } });
    const svc = service(repo, T, [card("cozy", "уютный")]);
    const r = await svc.prepareAdd(user, "cozy", [], { imageFileId: "IMG1" });
    if (r.kind !== "preview") throw new Error(r.kind);
    expect(r.items[0]!.imageFileId).toBe("IMG1");
    await svc.confirmAdd(user, r.previewId);
    expect((await repo.findNoteForUser(user.id, "cozy"))!.imageFileId).toBe("IMG1");
    const c = await repo.candidateCards(user.id, T, { dayStartMs: T - 3_600_000, dayEndMs: T + 20 * 3_600_000, today: "2026-09-30", directions: ["en_ru"] });
    expect(c.newNotes.find((n) => n.word === "cozy")!.imageFileId).toBe("IMG1");
  });

  it("a picture for a shared catalog word is visible only to the user who attached it", async () => {
    const a = await seedUser(env.DB, { now: T, words: 1 });
    const svc = service(a.repo, T, []);
    const r = await svc.prepareAdd(a.user, "borrow", [], { imageFileId: "MINE" });
    expect(r).toMatchObject({ kind: "duplicates-only", duplicates: [{ word: "borrow", imageAdded: true, linkAdded: false }] });
    const otherId = await a.repo.insertUser({ tgId: 77, chatId: 77, lang: "ru", now: T });
    await a.repo.subscribe(otherId, a.deckId, T);
    expect((await a.repo.findNoteForUser(a.user.id, "borrow"))!.imageFileId).toBe("MINE");
    expect((await a.repo.findNoteForUser(otherId, "borrow"))!.imageFileId).toBeNull();
    await a.repo.setUserMedia(a.user.id, a.noteIds[0]!, { imageFileId: "NEWER" });
    const cardId = await a.repo.ensureNewCard(a.user.id, a.noteIds[0]!, "en_ru", { state: "new", step: null, stability: null, difficulty: null, due: T, lastReview: null, scheduledDays: 0, reps: 0, lapses: 0 });
    expect((await a.repo.getCard(a.user.id, cardId))!.imageFileId).toBe("NEWER");
  });
});

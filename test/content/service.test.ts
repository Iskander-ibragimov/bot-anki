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

const MIN = 60_000;
const fresh = async (repo: Repo, id: number) => (await repo.getUser(id))!;

describe("adding one card", () => {
  it("a pair in either order becomes a card without AI and is saved to My words", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    for (const text of ["serendipity — счастливая случайность https://example.com/a", "счастливая случайность serendipity"]) {
      const svc = service(repo, T, "fail");
      const r = await svc.addEntry(user, text, []);
      if (r.kind !== "preview") throw new Error(r.kind);
      expect(r.item).toMatchObject({ word: "serendipity", translation: "счастливая случайность", ipa: "/ˌsɛɹənˈdɪpɪti/", exampleEn: "Finding that book was pure serendipity.", exampleRu: "" });
      if (text.includes("https")) {
        expect(r.item.sourceUrl).toBe("https://example.com/a");
        const saved = await svc.confirmAdd(user, r.previewId);
        expect(saved).toEqual({ word: "serendipity", total: 1 });
        expect(await repo.findNoteForUser(user.id, "Serendipity")).toMatchObject({ sourceUrl: "https://example.com/a", deckTitleRu: "Мои слова" });
        await expect(svc.confirmAdd(user, r.previewId)).rejects.toThrow();
        const jobs = await env.DB.prepare("SELECT kind, dedup_key FROM jobs").all<{ kind: string; dedup_key: string }>();
        expect(jobs.results).toEqual([{ kind: "voice", dedup_key: expect.stringMatching(/^voice:\d+$/) }]);
        await env.DB.prepare("DELETE FROM notes WHERE word_key = 'serendipity'").run();
      }
    }
  });

  it("english first, russian next message: the two are joined", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    expect(await service(repo, T, "fail").addEntry(user, "break the ice", [])).toEqual({ kind: "await", side: "en", text: "break the ice" });
    const r = await service(repo, T + MIN, "fail").addEntry(await fresh(repo, user.id), "растопить лёд", []);
    if (r.kind !== "preview") throw new Error(r.kind);
    expect(r.item).toMatchObject({ word: "break the ice", translation: "растопить лёд" });
    expect((await fresh(repo, user.id)).pendingEdit).toBeNull();
  });

  it("russian first, english next message: the two are joined", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    expect(await service(repo, T, "fail").addEntry(user, "растопить лёд", [])).toEqual({ kind: "await", side: "ru", text: "растопить лёд" });
    const r = await service(repo, T + MIN, "fail").addEntry(await fresh(repo, user.id), "break the ice", []);
    if (r.kind !== "preview") throw new Error(r.kind);
    expect(r.item).toMatchObject({ word: "break the ice", translation: "растопить лёд" });
  });

  it("a second message in the same language starts over; a stale wait is not joined", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    await service(repo, T, "fail").addEntry(user, "cozy", []);
    expect(await service(repo, T + MIN, "fail").addEntry(await fresh(repo, user.id), "thrive", [])).toEqual({ kind: "await", side: "en", text: "thrive" });
    expect(await service(repo, T + 12 * MIN, "fail").addEntry(await fresh(repo, user.id), "процветать", [])).toEqual({ kind: "await", side: "ru", text: "процветать" });
  });

  it("automatic translation of an english phrase", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    await service(repo, T).addEntry(user, "Cozy", []);
    const r = await service(repo, T, [card("cozy", "уютный")]).autoTranslate(await fresh(repo, user.id));
    if (r.kind !== "preview") throw new Error(r.kind);
    expect(r.item).toMatchObject({ word: "Cozy", translation: "уютный", exampleEn: "It is cozy.", exampleRu: "Это уютный." });
    expect((await fresh(repo, user.id)).pendingEdit).toBeNull();
  });

  it("automatic translation of a russian phrase keeps the user's russian", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    await service(repo, T).addEntry(user, "растопить лёд", []);
    const r = await service(repo, T, [card("break the ice", "сломать лёд")]).autoTranslate(await fresh(repo, user.id));
    if (r.kind !== "preview") throw new Error(r.kind);
    expect(r.item).toMatchObject({ word: "break the ice", translation: "растопить лёд" });
  });

  it("when AI is unavailable the user can still type the other side", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    await service(repo, T).addEntry(user, "cozy https://c.com", []);
    expect(await service(repo, T, "fail").autoTranslate(await fresh(repo, user.id))).toEqual({ kind: "failed", side: "en", text: "cozy" });
    const r = await service(repo, T + MIN, "fail").addEntry(await fresh(repo, user.id), "уютный", []);
    if (r.kind !== "preview") throw new Error(r.kind);
    expect(r.item).toMatchObject({ word: "cozy", translation: "уютный", sourceUrl: "https://c.com" });
    expect(await service(repo, T).autoTranslate(await fresh(repo, user.id))).toEqual({ kind: "nothing" });
  });

  it("a hanging provider is cut off by the overall deadline", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const hang = fakeFetch((u, init) => {
      if (u.includes("dictionaryapi")) return json({}, 404);
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    const svc = new ContentService(repo, { dict: new DictionaryClient(hang), llm: new LlmClient([P("https://a/v1"), P("https://b/v1")], hang) }, T, { deadlineMs: 300 });
    await svc.addEntry(user, "cozy", []);
    const started = Date.now();
    expect((await svc.autoTranslate(await fresh(repo, user.id))).kind).toBe("failed");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a word the user already learns is not added again but gets the link, privately", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const r = await service(repo, T).addEntry(user, " Borrow  https://x.com/v", []);
    expect(r).toEqual({ kind: "duplicate", duplicate: { word: "Borrow", deckTitle: "A2 · Базовый", linkAdded: true, imageAdded: false } });
    expect((await repo.findNoteForUser(user.id, "borrow"))!.sourceUrl).toBe("https://x.com/v");
    const shared = await env.DB.prepare("SELECT source_url FROM notes WHERE word_key = 'borrow'").first<{ source_url: string | null }>();
    expect(shared!.source_url).toBeNull();
    expect((await service(repo, T).addEntry(user, "borrow — занимать", [])).kind).toBe("duplicate");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM notes").first<{ n: number }>())!.n).toBe(1);
  });

  it("a link sent alone is attached to the next card within 10 minutes only", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    expect(await service(repo, T).addEntry(user, "https://youtu.be/q", [])).toEqual({ kind: "ask-words", url: "https://youtu.be/q" });
    const r = await service(repo, T + 9 * MIN).addEntry(await fresh(repo, user.id), "cozy — уютный", []);
    if (r.kind !== "preview") throw new Error(r.kind);
    expect(r.item.sourceUrl).toBe("https://youtu.be/q");
    await service(repo, T).addEntry(await fresh(repo, user.id), "https://youtu.be/z", []);
    const late = await service(repo, T + 11 * MIN).addEntry(await fresh(repo, user.id), "thrive — процветать", []);
    if (late.kind !== "preview") throw new Error(late.kind);
    expect(late.item.sourceUrl).toBeNull();
  });

  it("several cards or an unclear mix are refused without side effects", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const svc = service(repo, T);
    expect(await svc.addEntry(user, "cozy\nthrive", [])).toEqual({ kind: "too-many" });
    expect(await svc.addEntry(user, "cozy уютный warm тёплый", [])).toEqual({ kind: "unclear" });
    expect(await svc.addEntry(user, "!!!", [])).toEqual({ kind: "empty" });
    expect((await fresh(repo, user.id)).pendingEdit).toBeNull();
  });

  it("edit changes the preview translation", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const svc = service(repo, T);
    const r = await svc.addEntry(user, "cozy — уютный", []);
    if (r.kind !== "preview") throw new Error(r.kind);
    await svc.startEdit(user, r.previewId);
    expect(svc.pendingKind(await fresh(repo, user.id))).toBe("preview");
    const edited = await svc.editPreviewTranslation(await fresh(repo, user.id), "тёплый, уютный");
    expect(edited.previewId).toBe(r.previewId);
    expect(edited.items[0]!.translation).toBe("тёплый, уютный");
  });

  it("a picture travels with the card, also through the wait for the other side", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1, patch: { newPerDay: 20 } });
    await service(repo, T).addEntry(user, "cozy", [], { imageFileId: "IMG1" });
    const svc = service(repo, T + MIN);
    const r = await svc.addEntry(await fresh(repo, user.id), "уютный", []);
    if (r.kind !== "preview") throw new Error(r.kind);
    expect(r.item.imageFileId).toBe("IMG1");
    await svc.confirmAdd(user, r.previewId);
    expect((await repo.findNoteForUser(user.id, "cozy"))!.imageFileId).toBe("IMG1");
  });

  it("a picture for a shared catalog word is visible only to the user who attached it", async () => {
    const a = await seedUser(env.DB, { now: T, words: 1 });
    const r = await service(a.repo, T).addEntry(a.user, "borrow", [], { imageFileId: "MINE" });
    expect(r).toMatchObject({ kind: "duplicate", duplicate: { word: "borrow", imageAdded: true, linkAdded: false } });
    const otherId = await a.repo.insertUser({ tgId: 77, chatId: 77, lang: "ru", now: T });
    await a.repo.subscribe(otherId, a.deckId, T);
    expect((await a.repo.findNoteForUser(a.user.id, "borrow"))!.imageFileId).toBe("MINE");
    expect((await a.repo.findNoteForUser(otherId, "borrow"))!.imageFileId).toBeNull();
    await a.repo.setUserMedia(a.user.id, a.noteIds[0]!, { imageFileId: "NEWER" });
    const cardId = await a.repo.ensureNewCard(a.user.id, a.noteIds[0]!, "en_ru", { state: "new", step: null, stability: null, difficulty: null, due: T, lastReview: null, scheduledDays: 0, reps: 0, lapses: 0 });
    expect((await a.repo.getCard(a.user.id, cardId))!.imageFileId).toBe("NEWER");
  });

  it("My words lists the user's own cards, newest first, and they are studied before catalog words", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 3, patch: { newPerDay: 20 } });
    expect(await service(repo, T).myWords(user)).toEqual({ total: 0, items: [] });
    for (const [i, text] of ["cozy — уютный", "break the ice — растопить лёд"].entries()) {
      const svc = service(repo, T + i);
      const r = await svc.addEntry(user, text, []);
      if (r.kind !== "preview") throw new Error(r.kind);
      await svc.confirmAdd(user, r.previewId);
    }
    expect(await service(repo, T).myWords(user)).toEqual({ total: 2, items: [
      { word: "break the ice", translation: "растопить лёд" }, { word: "cozy", translation: "уютный" },
    ] });
    for (const newOrder of ["deck", "random"] as const) {
      const c = await repo.candidateCards(user.id, T, { dayStartMs: T - 3_600_000, dayEndMs: T + 20 * 3_600_000, today: "2026-09-30", directions: ["en_ru"], newOrder });
      expect(c.newNotes.slice(0, 2).map((n) => n.word).sort()).toEqual(["break the ice", "cozy"]);
      expect(c.newNotes).toHaveLength(5);
    }
  });
});

describe("ai decks", () => {
  it("gen limit is 3 per local day and resets at 04:00 local", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    for (let i = 0; i < 3; i++) expect(await consume(repo, (await repo.getUser(user.id))!, "gen", T)).toBe(true);
    expect(await consume(repo, (await repo.getUser(user.id))!, "gen", T)).toBe(false);
    const next4am = Date.UTC(2026, 9, 1, 1, 1); // 04:01 local next day
    expect(await consume(repo, (await repo.getUser(user.id))!, "gen", next4am)).toBe(true);
  });

  it("generateDeck clamps n, drops invalid cards and creates a subscribed AI deck on confirm", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const cards = [...Array.from({ length: 12 }, (_, i) => card(`word${i}`, `слово${i}`)), card("iphone", "iPhone")];
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

  it("failed generation refunds the daily quota", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const r = await service(repo, T, "fail").generateDeck(user, "space", 10);
    expect(r.kind).toBe("failed");
    expect((await repo.getUser(user.id))!.gensCount).toBe(0);
  });
});

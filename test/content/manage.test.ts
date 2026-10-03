import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo } from "../../src/db/repo";
import { DictionaryClient } from "../../src/content/dictionary";
import { LlmClient } from "../../src/content/llm";
import { runVoiceJob } from "../../src/content/audio";
import { ContentService } from "../../src/content/service";
import { ReviewService } from "../../src/review/service";
import { seedUser } from "../helpers/seed";

const T = Date.UTC(2026, 8, 30, 6, 0);
const MIN = 60_000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const card = (word: string, translation: string, exampleEn = `It is ${word}.`, exampleRu = `Это ${translation}.`) => ({ word, ipa: null, pos: "verb", translation, exampleEn, exampleRu });
const IMG = { bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg" };

function service(repo: Repo, now: number, opts: { seen?: string | null; cards?: ReturnType<typeof card>[]; prompts?: string[] } = {}) {
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("dictionaryapi")) return json({}, 404);
    if (!opts.cards) return json({}, 500);
    opts.prompts?.push(String(init?.body));
    return json({ choices: [{ message: { content: JSON.stringify({ cards: opts.cards }) } }] });
  }) as typeof fetch;
  const vision = opts.seen === undefined ? undefined : { available: true, readText: async () => opts.seen ?? null };
  return new ContentService(repo, { dict: new DictionaryClient(f), llm: new LlmClient([{ baseUrl: "https://llm/v1", apiKey: "k", model: "m" }], f), ...(vision ? { vision } : {}) }, now);
}
const fresh = async (repo: Repo, id: number) => (await repo.getUser(id))!;
const addCard = async (repo: Repo, userId: number, text: string, now = T) => {
  const svc = service(repo, now);
  const r = await svc.addEntry(await fresh(repo, userId), text, []);
  if (r.kind !== "preview") throw new Error(r.kind);
  await svc.confirmAdd(await fresh(repo, userId), r.previewId);
  return (await repo.findNoteForUser(userId, r.item.word))!.id;
};

describe("a card from a picture", () => {
  it("the line on the picture becomes word buttons; a tapped word is translated with the line as its example", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const { token } = await service(repo, T).beginPhoto(user, "FRAME");
    const ask = await service(repo, T, { seen: "...and not twist." }).readPhoto(await fresh(repo, user.id), token, IMG);
    expect(ask).toEqual({ text: "...and not twist.", words: ["twist"], phrase: "and not twist", token });
    const prompts: string[] = [];
    const svc = service(repo, T + MIN, { cards: [card("twist", "крутить", "...and not twist.", "…а не крутить.")], prompts });
    const w = (await svc.pickFromPhoto(await fresh(repo, user.id), token, 0))!;
    expect(w).toMatchObject({ side: "en", text: "twist", imageFileId: "FRAME", context: "...and not twist." });
    expect((await fresh(repo, user.id)).pendingEdit).toBeNull();
    const r = await svc.autoTranslate(await fresh(repo, user.id), w);
    expect(prompts[0]).toContain("and not twist");
    expect(r).toMatchObject({ kind: "preview", item: { word: "twist", translation: "крутить", exampleEn: "...and not twist.", exampleRu: "…а не крутить.", imageFileId: "FRAME" } });
    if (r.kind !== "preview") throw new Error(r.kind);
    await svc.confirmAdd(await fresh(repo, user.id), r.previewId);
    expect(await repo.findNoteForUser(user.id, "twist")).toMatchObject({ imageFileId: "FRAME", deckTitleRu: "Мои слова" });
  });

  it("the whole phrase can be chosen; an old or wrong button does nothing", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const { token } = await service(repo, T).beginPhoto(user, "FRAME");
    await service(repo, T, { seen: "...and not twist." }).readPhoto(await fresh(repo, user.id), token, IMG);
    const svc = service(repo, T + MIN);
    expect(await svc.pickFromPhoto(await fresh(repo, user.id), "zzz", 0)).toBeNull();
    expect(await svc.pickFromPhoto(await fresh(repo, user.id), token, 5)).toBeNull();
    expect(await svc.cancelPhoto(await fresh(repo, user.id), "zzz")).toBe(false);
    expect(await svc.pickFromPhoto(await fresh(repo, user.id), token, "all")).toMatchObject({ text: "and not twist", imageFileId: "FRAME" });
    expect(await svc.pickFromPhoto(await fresh(repo, user.id), token, "all")).toBeNull();
  });

  it("when nothing is read, or the reader is off, the user types the word and the picture is attached", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const { token } = await service(repo, T).beginPhoto(user, "PIC");
    expect(await service(repo, T, { seen: null }).readPhoto(await fresh(repo, user.id), token, IMG)).toEqual({ text: null, words: [], phrase: null, token });
    expect(await service(repo, T).readPhoto(await fresh(repo, user.id), token, null)).toEqual({ text: null, words: [], phrase: null, token });
    const r = await service(repo, T + MIN).addEntry(await fresh(repo, user.id), "уютный cozy", []);
    expect(r).toMatchObject({ kind: "preview", item: { word: "cozy", translation: "уютный", imageFileId: "PIC" } });
    expect((await fresh(repo, user.id)).pendingEdit).toBeNull();
  });

  it("a typed word that stands in the line gets the line as its example; the picture waits 10 minutes only", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const { token } = await service(repo, T).beginPhoto(user, "FRAME");
    await service(repo, T, { seen: "He was thorough, as always." }).readPhoto(await fresh(repo, user.id), token, IMG);
    const r = await service(repo, T + MIN).addEntry(await fresh(repo, user.id), "thorough — тщательный", []);
    expect(r).toMatchObject({ kind: "preview", item: { word: "thorough", exampleEn: "He was thorough, as always.", imageFileId: "FRAME" } });

    await service(repo, T).beginPhoto(await fresh(repo, user.id), "OLD");
    const single = await service(repo, T + MIN).addEntry(await fresh(repo, user.id), "serene", []);
    expect(single.kind).toBe("await");
    expect(JSON.parse((await fresh(repo, user.id)).pendingEdit!).await).toMatchObject({ text: "serene", imageFileId: "OLD" });

    await service(repo, T).beginPhoto(await fresh(repo, user.id), "LATE");
    const late = await service(repo, T + 11 * MIN).addEntry(await fresh(repo, user.id), "calm — спокойный", []);
    expect(late).toMatchObject({ kind: "preview", item: { word: "calm", imageFileId: null } });
  });

  it("text recognised after the user has already moved on is dropped", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const { token } = await service(repo, T).beginPhoto(user, "FRAME");
    const stale = await fresh(repo, user.id);
    await service(repo, T + 1000).addEntry(stale, "cozy", []); // typed while the picture was being read
    expect(await service(repo, T + 2000, { seen: "...and not twist." }).readPhoto(stale, token, IMG)).toBeNull();
    expect(JSON.parse((await fresh(repo, user.id)).pendingEdit!).await).toMatchObject({ text: "cozy", imageFileId: "FRAME" });
  });
});

describe("a picture for a word the user already has", () => {
  it("is attached only after the user asked for it, and can be removed", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 1 });
    const svc = service(repo, T);
    expect(await svc.attachPendingPicture(user, "X")).toBeNull();
    expect(await svc.askPicture(user, 999_999, null)).toBeNull();
    expect(await svc.askPicture(user, noteIds[0]!, null)).toEqual({ word: "borrow", hasImage: false });
    expect(await service(repo, T + MIN).attachPendingPicture(await fresh(repo, user.id), "PIC1")).toEqual({ noteId: noteIds[0], word: "borrow", page: null });
    expect((await repo.findNoteForUser(user.id, "borrow"))!.imageFileId).toBe("PIC1");
    expect((await fresh(repo, user.id)).pendingEdit).toBeNull();
    expect(await svc.askPicture(await fresh(repo, user.id), noteIds[0]!, 2)).toEqual({ word: "borrow", hasImage: true });
    expect(await service(repo, T + 11 * MIN).attachPendingPicture(await fresh(repo, user.id), "TOO-LATE")).toBeNull();
    expect(await svc.removePicture(await fresh(repo, user.id), noteIds[0]!)).toBe("borrow");
    expect((await repo.findNoteForUser(user.id, "borrow"))!.imageFileId).toBeNull();
  });
});

describe("managing My words", () => {
  it("lists the dictionary page by page, newest first", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    expect(await service(repo, T).myWords(user, 0)).toEqual({ total: 0, page: 0, pages: 1, items: [] });
    for (let i = 1; i <= 10; i++) await addCard(repo, user.id, `word${String.fromCharCode(96 + i)} — слово${i}`, T + i);
    const first = await service(repo, T).myWords(user, 0);
    expect(first).toMatchObject({ total: 10, page: 0, pages: 2 });
    expect(first.items).toHaveLength(8);
    expect(first.items[0]).toMatchObject({ word: "wordj", translation: "слово10", id: expect.any(Number) });
    const second = await service(repo, T).myWords(user, 1);
    expect(second.items.map((i) => i.word)).toEqual(["wordb", "worda"]);
    expect((await service(repo, T).myWords(user, 7)).page).toBe(1); // a page that no longer exists shows the last one
  });

  it("edit: english replaces the word, russian the translation, a pair both", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const id = await addCard(repo, user.id, "cosy — уютный");
    const other = await addCard(repo, user.id, "thrive — процветать", T + 1);
    const edit = async (text: string, at = T + MIN) => {
      expect(await service(repo, at).startWordEdit(await fresh(repo, user.id), id, 0)).toBe((await service(repo, at).myWord(user, id))!.word);
      return service(repo, at).applyWordEdit(await fresh(repo, user.id), text, []);
    };
    expect(await edit("cozy")).toEqual({ kind: "saved", noteId: id, page: 0 });
    expect(await service(repo, T).myWord(user, id)).toMatchObject({ word: "cozy", translation: "уютный" });
    expect(await repo.findNoteForUser(user.id, "cosy")).toBeNull();
    expect(await edit("тёплый, уютный")).toMatchObject({ kind: "saved" });
    expect(await edit("комфортный snug")).toMatchObject({ kind: "saved" });
    expect(await service(repo, T).myWord(user, id)).toMatchObject({ word: "snug", translation: "комфортный" });
    expect((await fresh(repo, user.id)).pendingEdit).toBeNull();

    expect(await edit("thrive")).toEqual({ kind: "duplicate", word: "thrive", noteId: id, page: 0 });
    expect(await edit("borrow")).toMatchObject({ kind: "duplicate" }); // already studied in a catalog deck
    expect(await edit("one\ntwo\nthree")).toEqual({ kind: "hint", reason: "too-many" });
    expect(await service(repo, T + MIN).applyWordEdit(await fresh(repo, user.id), "Snug", [])).toMatchObject({ kind: "saved" }); // still editing after a hint
    expect((await service(repo, T).myWord(user, id))!.word).toBe("Snug");
    expect(await service(repo, T).myWord(user, other)).toMatchObject({ word: "thrive" });
  });

  it("a new spelling keeps an example that still fits and drops one that does not", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const deck = await repo.customDeck(user.id, T);
    const [id] = await repo.insertNotes(deck, [{ word: "twist", ipa: "/twɪst/", pos: "verb", translation: "крутить", exampleEn: "He twisted the cap and not twist it back.", exampleRu: "Он открутил крышку.", audioUrl: "https://a/twist.mp3" }]);
    const rename = async (text: string) => {
      await service(repo, T).startWordEdit(await fresh(repo, user.id), id!, 0);
      return service(repo, T).applyWordEdit(await fresh(repo, user.id), text, []);
    };
    await rename("not twist");
    expect(await service(repo, T).myWord(user, id!)).toMatchObject({ word: "not twist", exampleEn: "He twisted the cap and not twist it back.", ipa: null, audioUrl: null });
    await rename("spin");
    expect(await service(repo, T).myWord(user, id!)).toMatchObject({ word: "spin", exampleEn: "", exampleRu: "", pos: "" });
  });

  it("recorded audio queued for the old spelling is not attached to the renamed word", async () => {
    const { repo, user } = await seedUser(env.DB, { now: T, words: 1 });
    const deck = await repo.customDeck(user.id, T);
    const [id] = await repo.insertNotes(deck, [{ word: "cosy", ipa: null, pos: "", translation: "уютный", exampleEn: "", exampleRu: "", audioUrl: "https://a/cosy.mp3" }]);
    await service(repo, T).startWordEdit(await fresh(repo, user.id), id!, 0);
    await service(repo, T).applyWordEdit(await fresh(repo, user.id), "snug", []);
    const sent: string[] = [];
    const tg = { call: async <R>(method: string) => { sent.push(method); return { message_id: 1, voice: { file_id: "OLD" } } as R; } };
    await runVoiceJob(repo, tg, 999, { noteId: id!, audioUrl: "https://a/cosy.mp3" });
    expect(sent).toEqual([]);
    expect((await repo.getNote(id!))!.audioFileId).toBeNull();
  });

  it("an edit that was not started, is too old, or targets someone else's word changes nothing", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 1 });
    const id = await addCard(repo, user.id, "cozy — уютный");
    expect(await service(repo, T).applyWordEdit(await fresh(repo, user.id), "snug", [])).toBeNull();
    expect(await service(repo, T).startWordEdit(user, noteIds[0]!, 0)).toBeNull(); // catalog words are not editable
    await service(repo, T).startWordEdit(await fresh(repo, user.id), id, 0);
    expect(await service(repo, T + 11 * MIN).applyWordEdit(await fresh(repo, user.id), "snug", [])).toBeNull();
    const stranger = await seedUser(env.DB, { now: T, words: 1, tgId: 2 });
    expect(await service(stranger.repo, T).myWord(stranger.user, id)).toBeNull();
    expect(await service(stranger.repo, T).deleteWord(stranger.user, id)).toBeNull();
    expect((await service(repo, T).myWord(user, id))!.word).toBe("cozy");
  });

  it("delete removes the word with its cards and picture; catalog words cannot be deleted", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 1, patch: { newPerDay: 20 } });
    const id = await addCard(repo, user.id, "cozy — уютный");
    await repo.setUserMedia(user.id, id, { imageFileId: "PIC" });
    const s = await new ReviewService(repo, T).nextScreen(await fresh(repo, user.id));
    if (s.kind !== "card") throw new Error(s.kind);
    expect(s.view.word).toBe("cozy");
    await new ReviewService(repo, T).grade(await fresh(repo, user.id), s.view.cardId, 0, 3);
    expect(await service(repo, T).deleteWord(user, noteIds[0]!)).toBeNull();
    expect(await service(repo, T).deleteWord(user, id)).toBe("cozy");
    expect(await service(repo, T).myWords(user, 0)).toMatchObject({ total: 0, items: [] });
    for (const table of ["cards", "user_note_media"]) {
      expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE note_id = ?`).bind(id).first<{ n: number }>())!.n).toBe(0);
    }
    expect((await env.DB.prepare("SELECT total FROM decks WHERE kind = 'custom'").first<{ total: number }>())!.total).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM review_log").first<{ n: number }>())!.n).toBe(1); // statistics keep the history
    expect((await new ReviewService(repo, T).nextScreen(await fresh(repo, user.id))).kind).toBe("card"); // the catalog word is next
    expect(await service(repo, T).deleteWord(user, id)).toBeNull();
    // "undo" of the grade given to the deleted word must not rewrite the history or the streak
    const before = await fresh(repo, user.id);
    expect((await new ReviewService(repo, T).undo(before)).kind).toBe("noundo");
    expect((await env.DB.prepare("SELECT undone FROM review_log").first<{ undone: number }>())!.undone).toBe(0);
    expect(await fresh(repo, user.id)).toMatchObject({ streak: before.streak, lastStudyDay: before.lastStudyDay });
  });
});

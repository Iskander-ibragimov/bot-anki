import { type NoteInput, type NoteRow, type Repo, type User, wordKey } from "../db/repo";
import { consume, refund } from "../entitlements/service";
import { enqueue } from "../jobs/queue";
import type { DictionaryClient } from "./dictionary";
import { type Entity, type Side, parseEntry } from "./links";
import { DECK_SYSTEM, type LlmClient, LlmUnavailable, RU_SYSTEM, WORDS_SYSTEM, completeCards } from "./llm";
import { exampleFrom, wordChoices } from "./photo";

export interface CardDraft {
  word: string; ipa: string | null; pos: string; translation: string; exampleEn: string; exampleRu: string;
  sourceUrl: string | null; audioUrl: string | null;
  /** Telegram file_id of the picture the user sent with the word. */
  imageFileId?: string | null;
}
export interface Duplicate { word: string; deckTitle: string; linkAdded: boolean; imageAdded: boolean }
export interface AddOptions { imageFileId?: string }

/** Result of one "add a card" message. */
export type EntryResult =
  | { kind: "empty" }
  | { kind: "ask-words"; url: string }
  | { kind: "too-many" }
  | { kind: "unclear" }
  | { kind: "duplicate"; duplicate: Duplicate }
  /** Only one language was sent: waiting for the other side, or for the "translate automatically" button. */
  | { kind: "await"; side: Side; text: string; token: string }
  | { kind: "preview"; previewId: number; item: CardDraft };
export type AutoResult =
  | { kind: "failed"; side: Side; text: string; token: string }
  | { kind: "duplicate"; duplicate: Duplicate }
  | { kind: "preview"; previewId: number; item: CardDraft };
export type GenResult = { kind: "limit" } | { kind: "failed" } | { kind: "preview"; previewId: number; topic: string; items: CardDraft[] };

/** Reads the text on a picture; absent when no vision model is configured. */
export interface Vision { available: boolean; readText(bytes: Uint8Array, mime: string, deadline?: number): Promise<string | null> }
interface Deps { dict: DictionaryClient; llm: LlmClient; vision?: Vision }
/** One side of a card the user has sent; kept until the other side arrives. `context` is the line it was taken from. */
export interface Awaiting { side: Side; text: string; url: string | null; imageFileId: string | null; at: number; context?: string | null }
/** A picture sent without a caption: the card is built from what is written on it, or from what the user types next. */
interface PhotoPending { fileId: string; text: string | null; words: string[]; phrase: string | null; at: number }
export interface PhotoAsk { text: string | null; words: string[]; phrase: string | null; token: string }
export type EditResult =
  | { kind: "saved"; noteId: number; page: number }
  | { kind: "duplicate"; word: string; noteId: number; page: number }
  | { kind: "hint"; reason: "too-many" | "unclear" | "empty" };
export interface WordPage { total: number; page: number; pages: number; items: { id: number; word: string; translation: string }[] }
/** Identifies one waiting side, so that buttons under an older request cannot act on a newer word. */
export const tokenOf = (w: { at: number }) => w.at.toString(36);
const PAGE_SIZE = 8;
const sameText = (a: string, b: string) => a.toLowerCase().replace(/[^a-z]+/g, "") === b.toLowerCase().replace(/[^a-z]+/g, "");
interface Pending {
  await?: Awaiting;
  preview?: { previewId: number };
  photo?: PhotoPending;
  /** "Edit" in My words: the next message is the new text of this card. */
  editNote?: { noteId: number; page: number; at: number };
  /** The picture button: the next photo goes to this word. */
  pic?: { noteId: number; page: number | null; at: number };
}

const PENDING_URL_MS = 10 * 60_000;
const AWAIT_MS = 10 * 60_000;
const PREVIEW_TTL_MS = 24 * 3_600_000;
const DICT_TIMEOUT_MS = 3000;
/** Reading a picture runs in the background of a webhook call, which may last about 30 s in total. */
const READ_PHOTO_MS = 18_000;

const toNote = (d: CardDraft): NoteInput => ({
  word: d.word, ipa: d.ipa, pos: d.pos, translation: d.translation, exampleEn: d.exampleEn, exampleRu: d.exampleRu,
  sourceUrl: d.sourceUrl, audioUrl: d.audioUrl,
});
const pendingOf = (user: User): Pending => (user.pendingEdit ? (JSON.parse(user.pendingEdit) as Pending) : {});

export class ContentService {
  private readonly deadlineMs: number;
  constructor(private readonly repo: Repo, private readonly deps: Deps, private readonly now: number, opts: { deadlineMs?: number } = {}) {
    this.deadlineMs = opts.deadlineMs ?? 25_000;
  }

  /**
   * One message = at most one card. English and Russian may come in either order, in one message or in two
   * consecutive ones; a single side is remembered until the other arrives (or the user asks for auto-translation).
   */
  async addEntry(user: User, text: string, entities: Entity[], opts: AddOptions = {}): Promise<EntryResult> {
    const entry = parseEntry(text, entities);
    if (entry.kind === "empty" || entry.kind === "too-many" || entry.kind === "unclear") return entry;
    if (entry.kind === "url-only") {
      await this.repo.updateUser(user.id, { pendingUrl: entry.url, pendingUrlAt: this.now });
      return { kind: "ask-words", url: entry.url };
    }
    const pending = pendingOf(user);
    const waiting = pending.await;
    // A picture sent just before this message is the picture of this card.
    const photo = pending.photo && this.now - pending.photo.at <= AWAIT_MS ? pending.photo : null;
    const patch: Partial<User> = {};
    let url = entry.url;
    if (user.pendingUrl && user.pendingUrlAt != null) {
      if (!url && this.now - user.pendingUrlAt <= PENDING_URL_MS) url = user.pendingUrl;
      patch.pendingUrl = null;
      patch.pendingUrlAt = null;
    }
    let image = opts.imageFileId ?? photo?.fileId ?? null;
    let context = opts.imageFileId ? null : (photo?.text ?? null);

    let en: string, ru: string;
    if (entry.kind === "pair") {
      ({ en, ru } = entry);
    } else if (waiting && waiting.side !== entry.side && this.now - waiting.at <= AWAIT_MS) {
      // The other half of what the user sent a moment ago.
      en = entry.side === "en" ? entry.text : waiting.text;
      ru = entry.side === "ru" ? entry.text : waiting.text;
      url = url ?? waiting.url;
      image = image ?? waiting.imageFileId;
      context = context ?? waiting.context ?? null;
    } else {
      if (entry.side === "en") {
        const dup = await this.duplicateOf(user, entry.text, url, image);
        if (dup) { await this.repo.updateUser(user.id, { ...patch, pendingEdit: null }); return { kind: "duplicate", duplicate: dup }; }
      }
      const next: Awaiting = { side: entry.side, text: entry.text, url, imageFileId: image, at: this.now, context };
      await this.repo.updateUser(user.id, { ...patch, pendingEdit: JSON.stringify({ await: next } satisfies Pending) });
      return { kind: "await", side: entry.side, text: entry.text, token: tokenOf(next) };
    }

    await this.repo.updateUser(user.id, { ...patch, pendingEdit: null });
    const dup = await this.duplicateOf(user, en, url, image);
    if (dup) return { kind: "duplicate", duplicate: dup };
    const d = await this.deps.dict.lookup(en, DICT_TIMEOUT_MS);
    return this.preview(user, {
      word: en, translation: ru, ipa: d?.ipa ?? null, pos: d?.pos ?? "", exampleEn: exampleFrom(context, en) ?? d?.exampleEn ?? "", exampleRu: "",
      sourceUrl: url, audioUrl: d?.audioUrl ?? null, imageFileId: image,
    });
  }

  /**
   * The user pressed "translate automatically": claims the waiting side, so that whatever they type while
   * the translation is running starts a new card. Null when the button belongs to an older request.
   */
  async takeAwait(user: User, token: string): Promise<Awaiting | null> {
    const w = pendingOf(user).await;
    if (!w || tokenOf(w) !== token) return null;
    await this.repo.updateUser(user.id, { pendingEdit: null });
    return w;
  }

  /** Completes a claimed side with AI. On failure the side is put back, so the user can type the other one. */
  async autoTranslate(user: User, w: Awaiting): Promise<AutoResult> {
    const failed = async (): Promise<AutoResult> => {
      await this.repo.swapPendingEdit(user.id, null, JSON.stringify({ await: w } satisfies Pending));
      return { kind: "failed", side: w.side, text: w.text, token: tokenOf(w) };
    };
    const deadline = Date.now() + this.deadlineMs;
    // A word taken from a film line is translated in the sense it has there, and the line is its example.
    const line = w.side === "en" ? exampleFrom(w.context, w.text) : null;
    const ask = w.side === "ru" ? `Russian:\n${w.text}`
      : line ? `Words:\n${w.text}\nThe word comes from this line: "${line}". Translate it in the sense it has there. exampleEn must be exactly that line, exampleRu its Russian translation.`
      : `Words:\n${w.text}`;
    try {
      const [dict, cards] = await Promise.all([
        w.side === "en" ? this.deps.dict.lookup(w.text, Math.min(DICT_TIMEOUT_MS, this.deadlineMs)) : Promise.resolve(null),
        completeCards(this.deps.llm, w.side === "en" ? WORDS_SYSTEM : RU_SYSTEM, ask, deadline),
      ]);
      const a = cards[0];
      // The user's own text is kept as written; AI only supplies the missing side and the example.
      const en = w.side === "en" ? w.text : (a?.word ?? "").trim().slice(0, 100);
      if (!a || !en || /[А-Яа-яЁё]/.test(en)) return await failed();
      const ru = w.side === "ru" ? w.text : a.translation;
      const dup = await this.duplicateOf(user, en, w.url, w.imageFileId);
      if (dup) return { kind: "duplicate", duplicate: dup };
      return this.preview(user, {
        word: en, translation: ru, ipa: dict?.ipa ?? a.ipa ?? null, pos: dict?.pos || a.pos, exampleEn: line && sameText(a.exampleEn, line) ? line : a.exampleEn, exampleRu: a.exampleRu,
        sourceUrl: w.url, audioUrl: dict?.audioUrl ?? null, imageFileId: w.imageFileId,
      });
    } catch (e) {
      const result = await failed();
      if (e instanceof LlmUnavailable) return result;
      throw e;
    }
  }

  /** "Don't add": forgets the waiting side. False when the button belongs to an older request. */
  async cancelAwait(user: User, token: string): Promise<boolean> {
    const w = pendingOf(user).await;
    if (!w || tokenOf(w) !== token) return false;
    await this.repo.updateUser(user.id, { pendingEdit: null });
    return true;
  }

  /** A photo sent right after one side of a card belongs to that card. */
  async attachImageToAwait(user: User, imageFileId: string): Promise<{ side: Side; text: string; token: string } | null> {
    const w = pendingOf(user).await;
    if (!w || this.now - w.at > AWAIT_MS) return null;
    await this.repo.updateUser(user.id, { pendingEdit: JSON.stringify({ await: { ...w, imageFileId } } satisfies Pending) });
    return { side: w.side, text: w.text, token: tokenOf(w) };
  }

  /** Drops a broken add-flow state (e.g. an edit of a preview that no longer exists). */
  async clearPending(user: User): Promise<void> { await this.repo.updateUser(user.id, { pendingEdit: null }); }

  /** A word the user already learns gets no second card; a new link or picture is attached to their copy only. */
  private async duplicateOf(user: User, en: string, url: string | null, image: string | null): Promise<Duplicate | null> {
    const hit = (await this.repo.findNotesForUser(user.id, [en])).get(wordKey(en));
    if (!hit) return null;
    const linkAdded = !!url && !hit.sourceUrl;
    if (linkAdded || image) await this.repo.setUserMedia(user.id, hit.id, { sourceUrl: linkAdded ? url : null, imageFileId: image });
    return { word: en, deckTitle: user.lang === "ru" ? hit.deckTitleRu : hit.deckTitleEn, linkAdded, imageAdded: !!image };
  }

  private async preview(user: User, item: CardDraft): Promise<{ kind: "preview"; previewId: number; item: CardDraft }> {
    const previewId = await this.repo.insertPreview(user.id, "add", [item], this.now);
    return { kind: "preview", previewId, item };
  }

  async startEdit(user: User, previewId: number): Promise<CardDraft[] | null> {
    const items = await this.repo.getPreview<CardDraft[]>(user.id, previewId, "add", this.now - PREVIEW_TTL_MS);
    if (!items) return null;
    await this.repo.updateUser(user.id, { pendingEdit: JSON.stringify({ preview: { previewId } } satisfies Pending) });
    return items;
  }

  /** Applies a typed translation to the preview being edited; returns the updated items and preview id. */
  async editPreviewTranslation(user: User, translation: string): Promise<{ previewId: number; items: CardDraft[] }> {
    const edit = pendingOf(user).preview;
    if (!edit) throw new Error("no preview in edit");
    const items = await this.repo.getPreview<CardDraft[]>(user.id, edit.previewId, "add", this.now - PREVIEW_TTL_MS);
    if (!items?.length) throw new Error("preview expired");
    items[0]!.translation = translation.trim().slice(0, 300);
    await this.repo.updatePreview(edit.previewId, items);
    await this.repo.updateUser(user.id, { pendingEdit: null });
    return { previewId: edit.previewId, items };
  }

  /** What the user's next message or photo belongs to. Requests that wait for a reply expire after 10 minutes. */
  pendingKind(user: User): "await" | "preview" | "photo" | "edit" | "pic" | null {
    const p = pendingOf(user);
    const live = (x?: { at: number }) => !!x && this.now - x.at <= AWAIT_MS;
    if (p.preview) return "preview";
    if (live(p.editNote)) return "edit";
    if (live(p.pic)) return "pic";
    if (p.await) return "await";
    return live(p.photo) ? "photo" : null;
  }

  /* ---------- a card from a picture ---------- */

  /** A picture without a caption starts a new card. Returns the token of this request and the user row as it is now. */
  async beginPhoto(user: User, fileId: string): Promise<{ token: string; user: User }> {
    const photo: PhotoPending = { fileId, text: null, words: [], phrase: null, at: this.now };
    const pendingEdit = JSON.stringify({ photo } satisfies Pending);
    await this.repo.updateUser(user.id, { pendingEdit });
    return { token: tokenOf(photo), user: { ...user, pendingEdit } };
  }

  /**
   * Reads the text on the picture and remembers it with the request. `user` must be the row beginPhoto left behind:
   * if the user has typed something meanwhile, the result is dropped (null).
   */
  async readPhoto(user: User, token: string, image: { bytes: Uint8Array; mime: string } | null): Promise<PhotoAsk | null> {
    const before = pendingOf(user).photo;
    if (!before || tokenOf(before) !== token) return null;
    const text = image && this.deps.vision?.available ? await this.deps.vision.readText(image.bytes, image.mime, Date.now() + Math.min(this.deadlineMs, READ_PHOTO_MS)).catch(() => null) : null;
    const choices = text ? wordChoices(text) : { words: [], phrase: null };
    const photo: PhotoPending = { ...before, text, ...choices };
    const kept = await this.repo.swapPendingEdit(user.id, user.pendingEdit, JSON.stringify({ photo } satisfies Pending));
    return kept ? { text, ...choices, token } : null;
  }

  /** A word button (or "the whole phrase") under the picture: the choice is claimed for auto-translation. */
  async pickFromPhoto(user: User, token: string, choice: number | "all"): Promise<Awaiting | null> {
    const photo = pendingOf(user).photo;
    if (!photo || tokenOf(photo) !== token) return null;
    const text = choice === "all" ? photo.phrase : photo.words[choice];
    if (!text) return null;
    await this.repo.updateUser(user.id, { pendingEdit: null });
    return { side: "en", text, url: null, imageFileId: photo.fileId, at: this.now, context: photo.text };
  }

  async cancelPhoto(user: User, token: string): Promise<boolean> {
    const photo = pendingOf(user).photo;
    if (!photo || tokenOf(photo) !== token) return false;
    await this.repo.updateUser(user.id, { pendingEdit: null });
    return true;
  }

  /* ---------- a picture for a word the user already has ---------- */

  /** The picture button: the next photo without a caption goes to this word. */
  async askPicture(user: User, noteId: number, page: number | null): Promise<{ word: string; hasImage: boolean } | null> {
    const note = await this.repo.getNoteForUser(user.id, noteId);
    if (!note) return null;
    await this.repo.updateUser(user.id, { pendingEdit: JSON.stringify({ pic: { noteId, page, at: this.now } } satisfies Pending) });
    return { word: note.word, hasImage: !!note.imageFileId };
  }

  async attachPendingPicture(user: User, imageFileId: string): Promise<{ noteId: number; word: string; page: number | null } | null> {
    const pic = pendingOf(user).pic;
    if (!pic || this.now - pic.at > AWAIT_MS) return null;
    const note = await this.repo.getNoteForUser(user.id, pic.noteId);
    await this.repo.updateUser(user.id, { pendingEdit: null });
    if (!note) return null;
    await this.repo.setUserMedia(user.id, note.id, { imageFileId });
    return { noteId: note.id, word: note.word, page: pic.page };
  }

  /** Returns the word whose picture was removed, or null when the user has no such word. */
  async removePicture(user: User, noteId: number): Promise<string | null> {
    const note = await this.repo.getNoteForUser(user.id, noteId);
    if (!note) return null;
    await this.repo.clearUserImage(user.id, noteId);
    if (pendingOf(user).pic?.noteId === noteId) await this.repo.updateUser(user.id, { pendingEdit: null });
    return note.word;
  }

  /** Saves the previewed card into the user's own dictionary ("My words"). */
  async confirmAdd(user: User, previewId: number): Promise<{ word: string; total: number }> {
    const items = await this.repo.getPreview<CardDraft[]>(user.id, previewId, "add", this.now - PREVIEW_TTL_MS);
    const item = items?.[0];
    if (!item) throw new Error("preview not found");
    const deckId = await this.repo.customDeck(user.id, this.now);
    const [noteId] = await this.repo.insertNotes(deckId, [toNote(item)]);
    await this.repo.deletePreview(user.id, previewId);
    await this.endEditOf(user, previewId);
    if (item.imageFileId) await this.repo.setUserMedia(user.id, noteId!, { imageFileId: item.imageFileId });
    if (item.audioUrl) await enqueue(this.repo.db, "voice", { noteId, audioUrl: item.audioUrl }, this.now, `voice:${noteId}`);
    const { total } = await this.repo.listCustomNotes(user.id, 0);
    return { word: item.word, total };
  }

  /* ---------- managing "My words" ---------- */

  /** One page of the user's own dictionary, newest first. A page past the end shows the last one. */
  async myWords(user: User, page: number): Promise<WordPage> {
    let p = Math.max(0, Math.floor(page) || 0);
    let list = await this.repo.listCustomNotes(user.id, PAGE_SIZE, p * PAGE_SIZE);
    const pages = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
    if (p >= pages) { p = pages - 1; list = await this.repo.listCustomNotes(user.id, PAGE_SIZE, p * PAGE_SIZE); }
    return { total: list.total, page: p, pages, items: list.items };
  }

  async myWord(user: User, noteId: number): Promise<NoteRow | null> { return this.repo.getCustomNote(user.id, noteId); }

  /** "Edit": the next message replaces the word, the translation, or both. Returns the word, or null if it is not the user's. */
  async startWordEdit(user: User, noteId: number, page: number): Promise<string | null> {
    const note = await this.repo.getCustomNote(user.id, noteId);
    if (!note) return null;
    await this.repo.updateUser(user.id, { pendingEdit: JSON.stringify({ editNote: { noteId, page, at: this.now } } satisfies Pending) });
    return note.word;
  }

  /** Applies the message to the card being edited: English replaces the word, Russian the translation, a pair both. */
  async applyWordEdit(user: User, text: string, entities: Entity[]): Promise<EditResult | null> {
    const edit = pendingOf(user).editNote;
    if (!edit || this.now - edit.at > AWAIT_MS) return null;
    const note = await this.repo.getCustomNote(user.id, edit.noteId);
    if (!note) { await this.repo.updateUser(user.id, { pendingEdit: null }); return null; }
    const entry = parseEntry(text, entities);
    if (entry.kind === "too-many" || entry.kind === "unclear") return { kind: "hint", reason: entry.kind };
    if (entry.kind !== "pair" && entry.kind !== "single") return { kind: "hint", reason: "empty" };
    const word = entry.kind === "pair" ? entry.en : entry.side === "en" ? entry.text : undefined;
    const translation = entry.kind === "pair" ? entry.ru : entry.side === "ru" ? entry.text : undefined;
    if (word !== undefined && wordKey(word) !== wordKey(note.word)) {
      const taken = (await this.repo.findNotesForUser(user.id, [word])).get(wordKey(word));
      if (taken && taken.id !== note.id) return { kind: "duplicate", word, noteId: note.id, page: edit.page };
    }
    // An example sentence that no longer contains the word would only confuse.
    const dropExample = word !== undefined && wordKey(word) !== wordKey(note.word) && !exampleFrom(note.exampleEn, word);
    await this.repo.updateCustomNote(user.id, note.id, { ...(word !== undefined ? { word } : {}), ...(translation !== undefined ? { translation } : {}), dropExample });
    await this.repo.updateUser(user.id, { pendingEdit: null });
    return { kind: "saved", noteId: note.id, page: edit.page };
  }

  /** Deletes a card of the user's own dictionary with its progress. Returns the word, or null if it is not theirs. */
  async deleteWord(user: User, noteId: number): Promise<string | null> {
    const note = await this.repo.getCustomNote(user.id, noteId);
    if (!note || !(await this.repo.deleteCustomNote(user.id, noteId))) return null;
    return note.word;
  }

  async cancel(user: User, previewId: number): Promise<void> {
    await this.repo.deletePreview(user.id, previewId);
    await this.endEditOf(user, previewId);
  }

  private async endEditOf(user: User, previewId: number): Promise<void> {
    if (pendingOf(user).preview?.previewId === previewId) await this.repo.updateUser(user.id, { pendingEdit: null });
  }

  async generateDeck(user: User, topic: string, n: number): Promise<GenResult> {
    const count = Math.min(30, Math.max(10, Math.round(n) || 20));
    if (!(await consume(this.repo, user, "gen", this.now))) return { kind: "limit" };
    try {
      const cards = await completeCards(this.deps.llm, DECK_SYSTEM, `Topic: ${topic}\nNumber of cards: ${count}`, Date.now() + this.deadlineMs);
      const seen = new Set<string>();
      const items: CardDraft[] = cards
        .filter((c) => { const k = c.word.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
        .slice(0, count)
        .map((c) => ({ word: c.word, ipa: c.ipa ?? null, pos: c.pos, translation: c.translation, exampleEn: c.exampleEn, exampleRu: c.exampleRu, sourceUrl: null, audioUrl: null }));
      if (!items.length) { await refund(this.repo, user, "gen", this.now); return { kind: "failed" }; }
      const previewId = await this.repo.insertPreview(user.id, "gen", { topic, items }, this.now);
      return { kind: "preview", previewId, topic, items };
    } catch (e) {
      await refund(this.repo, user, "gen", this.now);
      if (e instanceof LlmUnavailable) return { kind: "failed" };
      throw e;
    }
  }

  async confirmDeck(user: User, previewId: number): Promise<{ deckId: number; title: string; count: number }> {
    const p = await this.repo.getPreview<{ topic: string; items: CardDraft[] }>(user.id, previewId, "gen", this.now - PREVIEW_TTL_MS);
    if (!p) throw new Error("preview not found");
    const title = `🤖 ${p.topic}`;
    const deckId = await this.repo.insertDeck({ slug: null, kind: "ai", titleRu: title, titleEn: title, level: null, ownerId: user.id });
    await this.repo.insertNotes(deckId, p.items.map(toNote));
    await this.repo.subscribe(user.id, deckId, this.now);
    await this.repo.deletePreview(user.id, previewId);
    return { deckId, title, count: p.items.length };
  }
}

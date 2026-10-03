import { type NoteInput, type Repo, type User, wordKey } from "../db/repo";
import { consume, refund } from "../entitlements/service";
import { enqueue } from "../jobs/queue";
import type { DictionaryClient } from "./dictionary";
import { type Entity, type Side, parseEntry } from "./links";
import { DECK_SYSTEM, type LlmClient, LlmUnavailable, RU_SYSTEM, WORDS_SYSTEM, completeCards } from "./llm";

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

interface Deps { dict: DictionaryClient; llm: LlmClient }
/** One side of a card the user has sent; kept until the other side arrives. */
export interface Awaiting { side: Side; text: string; url: string | null; imageFileId: string | null; at: number }
/** Identifies one waiting side, so that buttons under an older request cannot act on a newer word. */
const tokenOf = (w: Awaiting) => w.at.toString(36);
interface Pending { await?: Awaiting; preview?: { previewId: number } }

const PENDING_URL_MS = 10 * 60_000;
const AWAIT_MS = 10 * 60_000;
const PREVIEW_TTL_MS = 24 * 3_600_000;
const DICT_TIMEOUT_MS = 3000;

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
    const waiting = pendingOf(user).await;
    const patch: Partial<User> = {};
    let url = entry.url;
    if (user.pendingUrl && user.pendingUrlAt != null) {
      if (!url && this.now - user.pendingUrlAt <= PENDING_URL_MS) url = user.pendingUrl;
      patch.pendingUrl = null;
      patch.pendingUrlAt = null;
    }
    let image = opts.imageFileId ?? null;

    let en: string, ru: string;
    if (entry.kind === "pair") {
      ({ en, ru } = entry);
    } else if (waiting && waiting.side !== entry.side && this.now - waiting.at <= AWAIT_MS) {
      // The other half of what the user sent a moment ago.
      en = entry.side === "en" ? entry.text : waiting.text;
      ru = entry.side === "ru" ? entry.text : waiting.text;
      url = url ?? waiting.url;
      image = image ?? waiting.imageFileId;
    } else {
      if (entry.side === "en") {
        const dup = await this.duplicateOf(user, entry.text, url, image);
        if (dup) { await this.repo.updateUser(user.id, { ...patch, pendingEdit: null }); return { kind: "duplicate", duplicate: dup }; }
      }
      const next: Awaiting = { side: entry.side, text: entry.text, url, imageFileId: image, at: this.now };
      await this.repo.updateUser(user.id, { ...patch, pendingEdit: JSON.stringify({ await: next } satisfies Pending) });
      return { kind: "await", side: entry.side, text: entry.text, token: tokenOf(next) };
    }

    await this.repo.updateUser(user.id, { ...patch, pendingEdit: null });
    const dup = await this.duplicateOf(user, en, url, image);
    if (dup) return { kind: "duplicate", duplicate: dup };
    const d = await this.deps.dict.lookup(en, DICT_TIMEOUT_MS);
    return this.preview(user, {
      word: en, translation: ru, ipa: d?.ipa ?? null, pos: d?.pos ?? "", exampleEn: d?.exampleEn ?? "", exampleRu: "",
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
      await this.repo.restorePendingEdit(user.id, JSON.stringify({ await: w } satisfies Pending));
      return { kind: "failed", side: w.side, text: w.text, token: tokenOf(w) };
    };
    const deadline = Date.now() + this.deadlineMs;
    try {
      const [dict, cards] = await Promise.all([
        w.side === "en" ? this.deps.dict.lookup(w.text, Math.min(DICT_TIMEOUT_MS, this.deadlineMs)) : Promise.resolve(null),
        completeCards(this.deps.llm, w.side === "en" ? WORDS_SYSTEM : RU_SYSTEM, w.side === "en" ? `Words:\n${w.text}` : `Russian:\n${w.text}`, deadline),
      ]);
      const a = cards[0];
      // The user's own text is kept as written; AI only supplies the missing side and the example.
      const en = w.side === "en" ? w.text : (a?.word ?? "").trim().slice(0, 100);
      if (!a || !en || /[А-Яа-яЁё]/.test(en)) return await failed();
      const ru = w.side === "ru" ? w.text : a.translation;
      const dup = await this.duplicateOf(user, en, w.url, w.imageFileId);
      if (dup) return { kind: "duplicate", duplicate: dup };
      return this.preview(user, {
        word: en, translation: ru, ipa: dict?.ipa ?? a.ipa ?? null, pos: dict?.pos || a.pos, exampleEn: a.exampleEn, exampleRu: a.exampleRu,
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

  pendingKind(user: User): "await" | "preview" | null {
    const p = pendingOf(user);
    return p.preview ? "preview" : p.await ? "await" : null;
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
    const { total } = await this.repo.listCustomNotes(user.id, 1);
    return { word: item.word, total };
  }

  /** The user's own dictionary: how many cards and the latest ones. */
  async myWords(user: User, limit = 30): Promise<{ total: number; items: { word: string; translation: string }[] }> {
    return this.repo.listCustomNotes(user.id, limit);
  }

  /** Attaches the user's picture to a word they already have (e.g. the card on screen). */
  async attachImage(user: User, noteId: number, imageFileId: string): Promise<void> {
    await this.repo.setUserMedia(user.id, noteId, { imageFileId });
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

import { z } from "zod";
import { type NoteInput, type Repo, type User, wordKey } from "../db/repo";
import { consume } from "../entitlements/service";
import { enqueue } from "../jobs/queue";
import type { DictionaryClient } from "./dictionary";
import { type Entity, parseWordsAndLinks } from "./links";
import { DECK_SYSTEM, type LlmClient, LlmUnavailable, WORDS_SYSTEM, WordCardSchema } from "./llm";

export interface CardDraft {
  word: string; ipa: string | null; pos: string; translation: string; exampleEn: string; exampleRu: string;
  sourceUrl: string | null; audioUrl: string | null;
}
export interface Duplicate { word: string; deckTitle: string; linkAdded: boolean }
export type AddResult =
  | { kind: "ask-words"; url: string }
  | { kind: "empty" }
  | { kind: "duplicates-only"; duplicates: Duplicate[] }
  | { kind: "preview"; previewId: number; items: CardDraft[]; duplicates: Duplicate[]; manual: string[] }
  | { kind: "manual"; word: string; duplicates: Duplicate[] };
export type GenResult = { kind: "limit" } | { kind: "failed" } | { kind: "preview"; previewId: number; topic: string; items: CardDraft[] };

interface Deps { dict: DictionaryClient; llm: LlmClient }
interface PendingManual { word: string; url: string | null; ipa: string | null; pos: string; audioUrl: string | null }
interface PendingPreviewEdit { previewId: number }

const PENDING_URL_MS = 10 * 60_000;
const PREVIEW_TTL_MS = 24 * 3_600_000;
const CardsSchema = z.object({ cards: z.array(WordCardSchema) });

const toNote = (d: CardDraft): NoteInput => ({
  word: d.word, ipa: d.ipa, pos: d.pos, translation: d.translation, exampleEn: d.exampleEn, exampleRu: d.exampleRu,
  sourceUrl: d.sourceUrl, audioUrl: d.audioUrl,
});

export class ContentService {
  constructor(private readonly repo: Repo, private readonly deps: Deps, private readonly now: number) {}

  /** Parses a message with words and links, skips duplicates, and builds a preview via dictionary + LLM. */
  async prepareAdd(user: User, text: string, entities: Entity[]): Promise<AddResult> {
    const parsed = parseWordsAndLinks(text, entities);
    if (!parsed.items.length) {
      if (!parsed.orphanUrl) return { kind: "empty" };
      await this.repo.updateUser(user.id, { pendingUrl: parsed.orphanUrl, pendingUrlAt: this.now });
      return { kind: "ask-words", url: parsed.orphanUrl };
    }
    const items = parsed.items.map((i) => ({ ...i }));
    if (user.pendingUrl && user.pendingUrlAt != null) {
      if (this.now - user.pendingUrlAt <= PENDING_URL_MS && items.every((i) => !i.url)) for (const i of items) i.url = user.pendingUrl;
      await this.repo.updateUser(user.id, { pendingUrl: null, pendingUrlAt: null });
    }

    const duplicates: Duplicate[] = [];
    const fresh: typeof items = [];
    const known = await this.repo.findNotesForUser(user.id, items.map((i) => i.word));
    for (const it of items) {
      const hit = known.get(wordKey(it.word));
      if (!hit) { fresh.push(it); continue; }
      const linkAdded = !!it.url && !hit.sourceUrl;
      if (linkAdded) await this.repo.setNoteSourceUrl(hit.id, it.url!);
      duplicates.push({ word: it.word, deckTitle: user.lang === "ru" ? hit.deckTitleRu : hit.deckTitleEn, linkAdded });
    }
    if (!fresh.length) return { kind: "duplicates-only", duplicates };

    const dict = await Promise.all(fresh.map((i) => this.deps.dict.lookup(i.word)));
    let ai: z.infer<typeof WordCardSchema>[] = [];
    try {
      const res = await this.deps.llm.completeJson(WORDS_SYSTEM, `Words:\n${fresh.map((i) => i.word).join("\n")}`, CardsSchema);
      ai = res.cards;
    } catch (e) {
      if (!(e instanceof LlmUnavailable)) throw e;
    }
    const drafts: CardDraft[] = [];
    const manual: PendingManual[] = [];
    fresh.forEach((it, idx) => {
      const d = dict[idx];
      const a = ai.find((c) => c.word.toLowerCase() === it.word.toLowerCase()) ?? (ai.length === fresh.length ? ai[idx] : undefined);
      if (!a) { manual.push({ word: it.word, url: it.url, ipa: d?.ipa ?? null, pos: d?.pos ?? "", audioUrl: d?.audioUrl ?? null }); return; }
      drafts.push({
        word: it.word, ipa: d?.ipa ?? a.ipa ?? null, pos: d?.pos || a.pos, translation: a.translation,
        exampleEn: a.exampleEn, exampleRu: a.exampleRu, sourceUrl: it.url, audioUrl: d?.audioUrl ?? null,
      });
    });
    if (!drafts.length) {
      const first = manual[0]!;
      await this.repo.updateUser(user.id, { pendingEdit: JSON.stringify({ manual: first }) });
      return { kind: "manual", word: first.word, duplicates };
    }
    const previewId = await this.repo.insertPreview(user.id, "add", drafts, this.now);
    return { kind: "preview", previewId, items: drafts, duplicates, manual: manual.map((m) => m.word) };
  }

  /** Saves a card from a translation the user typed after AI was unavailable. */
  async completeManual(user: User, translation: string): Promise<string | null> {
    const pending = user.pendingEdit ? (JSON.parse(user.pendingEdit) as { manual?: PendingManual }) : null;
    if (!pending?.manual) return null;
    const m = pending.manual;
    const deckId = await this.repo.customDeck(user.id, this.now);
    await this.repo.insertNotes(deckId, [{ word: m.word, ipa: m.ipa, pos: m.pos, translation: translation.trim(), exampleEn: "", exampleRu: "", sourceUrl: m.url, audioUrl: m.audioUrl }]);
    await this.repo.updateUser(user.id, { pendingEdit: null });
    return m.word;
  }

  async startEdit(user: User, previewId: number): Promise<CardDraft[] | null> {
    const items = await this.repo.getPreview<CardDraft[]>(user.id, previewId, "add", this.now - PREVIEW_TTL_MS);
    if (!items) return null;
    const edit: PendingPreviewEdit = { previewId };
    await this.repo.updateUser(user.id, { pendingEdit: JSON.stringify({ preview: edit }) });
    return items;
  }

  /** Applies a typed translation to the preview being edited; returns the updated items and preview id. */
  async editPreviewTranslation(user: User, translation: string): Promise<CardDraft[]> {
    const pending = user.pendingEdit ? (JSON.parse(user.pendingEdit) as { preview?: PendingPreviewEdit }) : null;
    if (!pending?.preview) throw new Error("no preview in edit");
    const id = pending.preview.previewId;
    const items = await this.repo.getPreview<CardDraft[]>(user.id, id, "add", this.now - PREVIEW_TTL_MS);
    if (!items?.length) throw new Error("preview expired");
    items[0]!.translation = translation.trim();
    await this.repo.updatePreview(id, items);
    await this.repo.updateUser(user.id, { pendingEdit: null });
    return items;
  }

  pendingKind(user: User): "manual" | "preview" | null {
    if (!user.pendingEdit) return null;
    const p = JSON.parse(user.pendingEdit) as { manual?: unknown; preview?: unknown };
    return p.manual ? "manual" : p.preview ? "preview" : null;
  }

  async confirmAdd(user: User, previewId: number): Promise<{ words: string[]; audio: { noteId: number; audioUrl: string }[] }> {
    const items = await this.repo.getPreview<CardDraft[]>(user.id, previewId, "add", this.now - PREVIEW_TTL_MS);
    if (!items) throw new Error("preview not found");
    const deckId = await this.repo.customDeck(user.id, this.now);
    const ids = await this.repo.insertNotes(deckId, items.map(toNote));
    await this.repo.deletePreview(user.id, previewId);
    const audio = items.flatMap((d, i) => (d.audioUrl ? [{ noteId: ids[i]!, audioUrl: d.audioUrl }] : []));
    for (const a of audio) await enqueue(this.repo.db, "voice", a, this.now, `voice:${a.noteId}`);
    return { words: items.map((i) => i.word), audio };
  }

  async cancel(user: User, previewId: number): Promise<void> { await this.repo.deletePreview(user.id, previewId); }

  async generateDeck(user: User, topic: string, n: number): Promise<GenResult> {
    const count = Math.min(30, Math.max(10, Math.round(n) || 20));
    if (!(await consume(this.repo, user, "gen", this.now))) return { kind: "limit" };
    try {
      const res = await this.deps.llm.completeJson(DECK_SYSTEM, `Topic: ${topic}\nNumber of cards: ${count}`, CardsSchema);
      const seen = new Set<string>();
      const items: CardDraft[] = res.cards
        .filter((c) => { const k = c.word.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
        .slice(0, count)
        .map((c) => ({ word: c.word, ipa: c.ipa ?? null, pos: c.pos, translation: c.translation, exampleEn: c.exampleEn, exampleRu: c.exampleRu, sourceUrl: null, audioUrl: null }));
      if (!items.length) return { kind: "failed" };
      const previewId = await this.repo.insertPreview(user.id, "gen", { topic, items }, this.now);
      return { kind: "preview", previewId, topic, items };
    } catch (e) {
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

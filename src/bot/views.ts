import type { InlineKeyboardButton } from "grammy/types";
import { type Lang, type Mem, type Rating, memoryDays, stage } from "../srs/fsrs";
import { dict } from "../i18n";

export type Button = InlineKeyboardButton.CallbackButton;
export type Keyboard = Button[][];
export interface Rendered { text: string; keyboard: Keyboard; /** Telegram file_id: send as a photo with `text` as the caption. */ photo?: string }

import type { CardView, Counts, DaySummary, Feedback } from "../review/service";
export type { CardView, Counts, DaySummary, Feedback };
export interface PreviewItem { word: string; ipa: string | null; pos: string; translation: string; exampleEn: string; exampleRu: string; sourceUrl: string | null; imageFileId?: string | null }

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const btn = (text: string, data: string, style?: Button["style"]): Button => (style ? { text, callback_data: data, style } : { text, callback_data: data });

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/** Human interval for the done screen: "10 мин", "11 дн.", "1,2 мес.". */
export function formatLong(ms: number, lang: Lang): string {
  const t = dict(lang);
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${Math.max(1, min)} ${t.unitMin}`;
  const h = Math.round(ms / 3_600_000);
  if (h < 24) return `${h} ${t.unitHour}`;
  const d = Math.round(ms / 86_400_000);
  if (d < 30) return `${d} ${t.unitDay}`;
  return `${(Math.round(d / 3) / 10).toString().replace(".", t.decimal)} ${t.unitMonth}`;
}

export function progressLine(m: Mem, lang: Lang): string {
  const t = dict(lang);
  const st = { new: t.stageNew, learning: t.stageLearning, known: t.stageKnown, learned: t.stageLearned }[stage(m)];
  const parts = [st];
  const d = memoryDays(m);
  if (d) parts.push(t.memory(d));
  if (m.reps) parts.push(t.reviewNo(m.reps + 1));
  return parts.join(" · ");
}

const reEsc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Bolds the studied word (and simple inflections: -s, -ed, -ing, -ies) inside an already escaped sentence. */
export function highlight(sentenceEsc: string, word: string): string {
  const w = esc(word.trim());
  if (!w) return sentenceEsc;
  const forms = [`${reEsc(w)}(?:s|es|d|ed|ing)?`];
  if (/e$/i.test(w)) forms.push(`${reEsc(w.slice(0, -1))}ing`);
  if (/y$/i.test(w)) forms.push(`${reEsc(w.slice(0, -1))}(?:ies|ied)`);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${forms.join("|")})(?![\\p{L}\\p{N}])`, "giu");
  return sentenceEsc.replace(re, (m) => `<b>${m}</b>`);
}

/**
 * Card layout: the word first, then the answer under spoilers, then progress and queue counters.
 * A card with a picture is sent as a photo with this text as the caption.
 */
export function renderCard(v: CardView, c: Counts, intervals: Record<Rating, string>, canUndo: boolean, lang: Lang): Rendered {
  const t = dict(lang);
  const ipa = v.ipa ? esc(v.ipa) : "";
  const pos = v.pos ? `<i>${esc(v.pos)}</i>` : "";
  const lines: string[] = [];
  if (v.direction === "en_ru") {
    lines.push(`<b>${esc(v.word)}</b>`);
    if (ipa || pos) lines.push([ipa, pos].filter(Boolean).join(" · "));
    lines.push("", `<tg-spoiler><b>${esc(v.translation)}</b></tg-spoiler>`);
  } else {
    lines.push(`<b>${esc(v.translation)}</b>`, "", `<tg-spoiler><b>${esc(v.word)}</b>${ipa ? " " + ipa : ""}</tg-spoiler>`);
  }
  if (v.exampleEn || v.exampleRu) {
    const en = v.exampleEn ? `<i>${highlight(esc(v.exampleEn), v.word)}</i>` : "";
    lines.push(`<blockquote><tg-spoiler>${[en, esc(v.exampleRu)].filter(Boolean).join("\n")}</tg-spoiler></blockquote>`);
  } else lines.push("");
  lines.push(progressLine(v.mem, lang), `🔵 ${c.n} · 🔴 ${c.l} · 🟢 ${c.r}`);
  if (v.sourceUrl) lines.push(`🔗 <a href="${esc(v.sourceUrl)}">${esc(hostOf(v.sourceUrl))}</a>`);

  const g = (r: Rating) => `g:${v.cardId}:${v.reps}:${r}`;
  const keyboard: Keyboard = [
    [btn(`${t.again} ${intervals[1]}`, g(1), "danger"), btn(`${t.hard} ${intervals[2]}`, g(2))],
    [btn(`${t.good} ${intervals[3]}`, g(3), "success"), btn(`${t.easy} ${intervals[4]}`, g(4), "primary")],
    canUndo ? [btn(t.speak, `v:${v.noteId}`), btn(t.undo, "u")] : [btn(t.speak, `v:${v.noteId}`)],
  ];
  return v.imageFileId ? { text: lines.join("\n"), keyboard, photo: v.imageFileId } : { text: lines.join("\n"), keyboard };
}

export function renderDone(s: DaySummary, lang: Lang): Rendered {
  const t = dict(lang);
  const lines: string[] = [];
  lines.push(t.doneTitle, t.doneToday(s.reviewsToday, s.learnedToday), t.doneTotals(s.totals.learned, s.totals.known, s.totals.learning, s.totals.new));
  if (s.nextLearningInMs != null) lines.push("", t.doneNextLearning(formatLong(s.nextLearningInMs, lang)));
  if (s.streak > 0) lines.push(t.streak(s.streak));
  return { text: lines.join("\n"), keyboard: [[btn(t.addWords, "help:add"), btn(t.decksBtn, "decks")]] };
}

export function renderAddPreview(items: PreviewItem[], previewId: number, lang: Lang): Rendered {
  const t = dict(lang);
  if (items.length === 1) {
    const i = items[0]!;
    let text = `<b>${esc(i.word)}</b>`;
    const meta = [i.ipa ? esc(i.ipa) : "", i.pos ? `<i>${esc(i.pos)}</i>` : ""].filter(Boolean).join(" · ");
    if (meta) text += `\n${meta}`;
    text += `\n\n<b>${esc(i.translation)}</b>`;
    if (i.exampleEn || i.exampleRu) text += `<blockquote>${[i.exampleEn ? `<i>${esc(i.exampleEn)}</i>` : "", esc(i.exampleRu)].filter(Boolean).join("\n")}</blockquote>`;
    if (i.sourceUrl) text += `\n🔗 ${esc(hostOf(i.sourceUrl))}`;
    if (i.imageFileId) text += `\n${t.withPicture}`;
    return { text, keyboard: [[btn(t.add, `add:ok:${previewId}`, "primary"), btn(t.edit, `add:edit:${previewId}`), btn(t.cancel, `add:no:${previewId}`)]] };
  }
  const text = [t.foundN(items.length), ...items.map((i) => `• <b>${esc(i.word)}</b> — ${esc(i.translation)}${i.sourceUrl ? " 🔗" : ""}${i.imageFileId ? " 🖼" : ""}`)].join("\n");
  return { text, keyboard: [[btn(t.addAll(items.length), `add:ok:${previewId}`, "primary"), btn(t.cancel, `add:no:${previewId}`)]] };
}

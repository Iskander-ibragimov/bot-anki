import type { DeckRow, User } from "../db/repo";
import { dict } from "../i18n";
import type { Lang } from "../srs/fsrs";
import type { Cumulative } from "../stats/service";
import type { OnboardingScreen } from "../users/service";
import { REMIND_TIMES } from "../users/service";
import type { Button, Keyboard, Rendered } from "./views";
import { esc } from "./views";

const btn = (text: string, data: string, style?: Button["style"]): Button => (style ? { text, callback_data: data, style } : { text, callback_data: data });
const tzLabel = (min: number) => `UTC${min >= 0 ? "+" : "−"}${Math.floor(Math.abs(min) / 60)}${Math.abs(min) % 60 ? ":" + String(Math.abs(min) % 60).padStart(2, "0") : ""}`;
export const deckTitle = (d: Pick<DeckRow, "titleRu" | "titleEn">, lang: Lang) => (lang === "ru" ? d.titleRu : d.titleEn);

export function renderOnboarding(s: OnboardingScreen, lang: Lang, deck?: DeckRow | null, decks?: DeckRow[]): Rendered {
  const t = dict(lang);
  switch (s.kind) {
    case "lang":
      return { text: t.welcome, keyboard: [[btn("🇷🇺 Русский", "ob:ru"), btn("🇬🇧 English", "ob:en")]] };
    case "placement":
      return { text: t.placementQ(s.index + 1, esc(s.word)), keyboard: [[btn(t.knowBtn, "ob:1", "success"), btn(t.dontKnowBtn, "ob:0")]] };
    case "goal":
      return { text: t.goalQ(s.level), keyboard: [[btn(t.goalBtn(5), "ob:5"), btn(t.goalBtn(10), "ob:10", "primary"), btn(t.goalBtn(20), "ob:20")]] };
    case "remind":
      return { text: t.remindQ, keyboard: [REMIND_TIMES.slice(0, 3).map((x) => btn(x, `ob:${x}`)), REMIND_TIMES.slice(3).map((x) => btn(x, `ob:${x}`))] };
    case "tz":
      return { text: t.tzQ, keyboard: [s.options.slice(0, 3).map((o) => btn(o.label, `ob:${o.offset}`)), s.options.slice(3).map((o) => btn(o.label, `ob:${o.offset}`))] };
    case "deck": {
      const title = deck ? deckTitle(deck, lang) : s.slug.toUpperCase();
      return { text: t.deckQ(esc(title), deck?.total ?? 0), keyboard: [[btn(t.addDeckBtn(title), `ob:${s.slug}`, "primary"), btn(t.otherDeckBtn, "ob:other")]] };
    }
    case "deckList": {
      const list = (decks ?? []).filter((d) => d.slug);
      const kb: Keyboard = [];
      for (let i = 0; i < list.length; i += 2) kb.push(list.slice(i, i + 2).map((d) => btn(deckTitle(d, lang), `ob:${d.slug}`)));
      return { text: t.pickDeck, keyboard: kb };
    }
    case "finished":
      return { text: t.finished(s.remindAt, tzLabel(s.tzOffsetMin)), keyboard: [[btn(t.startBtn, "learn", "primary")]] };
    default:
      return { text: t.chooseAbove, keyboard: [] };
  }
}

export function renderDecks(list: (DeckRow & { subscribed: boolean; newCount: number; dueCount: number })[], lang: Lang): Rendered {
  const t = dict(lang);
  const lines = list.map((d) => t.deckLine(esc(deckTitle(d, lang)), d.total, d.subscribed, d.newCount, d.dueCount));
  const off = list.filter((d) => !d.subscribed);
  const kb: Keyboard = [];
  for (let i = 0; i < off.length; i += 2) kb.push(off.slice(i, i + 2).map((d) => btn(`+ ${deckTitle(d, lang)}`, `sub:${d.id}`)));
  return { text: [t.decksTitle, "", ...lines, "", t.decksFooter].join("\n"), keyboard: kb };
}

export function renderSettings(u: User): Rendered {
  const t = dict(u.lang);
  return {
    text: t.settingsTitle,
    keyboard: [
      [btn(t.setLang, "set:lang")], [btn(t.setMode(u.retention), "set:ret")], [btn(t.setNew(u.newPerDay), "set:new")],
      [btn(t.setRemind(u.remindAt), "set:rem")], [btn(t.setDir(u.direction), "set:dir")], [btn(t.setOrder(u.newOrder), "set:ord")],
      [btn(t.setAuto(u.autoplay), "set:auto")],
    ],
  };
}

export function renderStats(s: Cumulative, lang: Lang): string {
  const t = dict(lang);
  return t.statsText({
    streak: s.streak, learned: s.learned, known: s.known, learning: s.learning, fresh: s.fresh, memory: s.memory, total: s.total, r30: s.r30,
    retention: s.retention30 == null ? "—" : `${Math.round(s.retention30 * 100)}%`, forecast: s.forecast7.join(" · "),
  });
}

export function renderGenPreview(topic: string, items: { word: string; translation: string }[], left: number, previewId: number, lang: Lang): Rendered {
  const t = dict(lang);
  const text = [t.genTitle(esc(topic), items.length), "", ...items.map((i) => `• <b>${esc(i.word)}</b> — ${esc(i.translation)}`), "", t.genLeft(left)].join("\n");
  return { text, keyboard: [[btn(t.addDeckGenBtn, `gen:ok:${previewId}`, "primary"), btn(t.cancel, `gen:no:${previewId}`)]] };
}

export const learnKeyboard = (lang: Lang): Keyboard => [[btn(dict(lang).learnBtn, "learn", "primary")]];

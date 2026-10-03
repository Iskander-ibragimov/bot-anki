import { describe, expect, it } from "vitest";
import { renderAddPreview, renderCard, renderDone, type CardView } from "../../src/bot/views";
import { en } from "../../src/i18n/en";
import { ru } from "../../src/i18n/ru";
import { newMem } from "../../src/srs/fsrs";

const T = Date.UTC(2026, 8, 30, 6);
const view = (over: Partial<CardView> = {}): CardView => ({
  cardId: 7, noteId: 3, reps: 3, direction: "en_ru", word: "reliable", ipa: "/rɪˈlaɪəbl/", pos: "adj",
  translation: "надёжный", exampleEn: "He is reliable.", exampleRu: "Он надёжный.", hasAudio: true, sourceUrl: null,
  mem: { ...newMem(T), state: "review", scheduledDays: 2, reps: 3, stability: 2, difficulty: 5, lastReview: T }, ...over,
});
const iv = { 1: "<10м", 2: "1д", 3: "2д", 4: "4д" } as const;
const counts = { n: 4, l: 1, r: 12 };

describe("views", () => {
  it("translation and example are inside tg-spoiler", () => {
    const { text } = renderCard(view(), counts, iv, false, "ru");
    expect(text).toContain("🔵 4 · 🔴 1 · 🟢 12");
    expect(text).toContain("<b>reliable</b>");
    expect(text).toMatch(/<tg-spoiler>[^]*надёжный[^]*<\/tg-spoiler>/);
    expect(text).toMatch(/<blockquote><tg-spoiler>[^]*He is reliable\.[^]*<\/tg-spoiler><\/blockquote>/);
  });

  it("keyboard is 2x2 with styles and short callbacks", () => {
    const { keyboard } = renderCard(view(), counts, iv, true, "ru");
    const grades = keyboard.slice(0, 2);
    expect(grades.map((r) => r.length)).toEqual([2, 2]);
    const flat = grades.flat();
    expect(flat.map((b) => b.style)).toEqual(["danger", undefined, "success", "primary"]);
    expect(flat.map((b) => b.callback_data)).toEqual(["g:7:3:1", "g:7:3:2", "g:7:3:3", "g:7:3:4"]);
    expect(flat.map((b) => b.text)).toEqual(["Снова <10м", "Трудно 1д", "Хорошо 2д", "Легко 4д"]);
    for (const b of flat) expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(64);
    expect(keyboard[2]!.map((b) => b.callback_data)).toEqual(["v:3", "u"]);
  });

  it("voice button only when audio exists; undo only when allowed", () => {
    const { keyboard } = renderCard(view({ hasAudio: false }), counts, iv, false, "ru");
    expect(keyboard).toHaveLength(2);
  });

  it("html in word is escaped", () => {
    const { text } = renderCard(view({ word: "<b>x&y" }), counts, iv, false, "en");
    expect(text).toContain("&lt;b&gt;x&amp;y");
  });

  it("source link shows hostname", () => {
    const { text } = renderCard(view({ sourceUrl: "https://www.youtube.com/watch?v=1&t=2" }), counts, iv, false, "ru");
    expect(text).toContain('🔗 <a href="https://www.youtube.com/watch?v=1&amp;t=2">youtube.com</a>');
  });

  it("progress line shows stage, memory and review number", () => {
    const { text } = renderCard(view(), counts, iv, false, "ru");
    expect(text).toContain("🌿 Учу · память ~2 дн. · повтор №4");
  });

  it("card shows only the current word, nothing about the previous one", () => {
    const { text } = renderCard(view(), counts, iv, true, "ru");
    expect(text.split("\n")[1]).toBe("<b>reliable</b>");
    expect(text).not.toContain("→");
  });

  it("ru to en direction hides the English word", () => {
    const { text } = renderCard(view({ direction: "ru_en" }), counts, iv, false, "ru");
    expect(text).toMatch(/^[^]*<b>надёжный<\/b>\n<tg-spoiler><b>reliable<\/b>/);
  });

  it("done screen shows day and cumulative totals", () => {
    const { text, keyboard } = renderDone({ reviewsToday: 24, learnedToday: 3, totals: { learned: 37, known: 20, learning: 14, new: 429 }, nextLearningInMs: 480_000, streak: 5 }, "ru");
    expect(text.startsWith("✅")).toBe(true);
    expect(text).toContain("Сегодня: 24 повт. · +3 выучено");
    expect(text).toContain("Всего: 🏆 37 · 🌳 20 · 🌿 14 · 🌱 429");
    expect(text).toContain("через 8 мин");
    expect(text).toContain("🔥 Серия: 5 дн.");
    expect(keyboard.flat().map((b) => b.callback_data)).toEqual(["help:add", "decks"]);
  });

  it("add preview shows link host and actions", () => {
    const one = renderAddPreview([{ word: "resilient", ipa: "/rɪˈzɪliənt/", pos: "adj", translation: "стойкий", exampleEn: "Kids are resilient.", exampleRu: "Дети стойкие.", sourceUrl: "https://example.com/a" }], 5, "ru");
    expect(one.text).toContain("🔗 example.com");
    expect(one.keyboard.flat().map((b) => b.callback_data)).toEqual(["add:ok:5", "add:edit:5", "add:no:5"]);
    const many = renderAddPreview([
      { word: "a", ipa: null, pos: "", translation: "а", exampleEn: "", exampleRu: "", sourceUrl: null },
      { word: "b", ipa: null, pos: "", translation: "б", exampleEn: "", exampleRu: "", sourceUrl: "https://x.org" },
    ], 6, "en");
    expect(many.text).toContain("• <b>b</b> — б 🔗");
    expect(many.keyboard.flat().map((b) => b.callback_data)).toEqual(["add:ok:6", "add:no:6"]);
  });

  it("ru and en have the same keys", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ru).sort());
  });
});

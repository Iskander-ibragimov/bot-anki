import { describe, expect, it } from "vitest";
import { renderAddPreview, renderAwait, renderCard, renderDeleteAsk, renderDone, renderMyWords, renderPhotoAsk, renderWord, type CardView } from "../../src/bot/views";
import { en } from "../../src/i18n/en";
import { ru } from "../../src/i18n/ru";
import { newMem } from "../../src/srs/fsrs";

const T = Date.UTC(2026, 8, 30, 6);
const view = (over: Partial<CardView> = {}): CardView => ({
  cardId: 7, noteId: 3, reps: 3, direction: "en_ru", word: "reliable", ipa: "/rɪˈlaɪəbl/", pos: "adj",
  translation: "надёжный", exampleEn: "He is reliable.", exampleRu: "Он надёжный.", sourceUrl: null, imageFileId: null,
  mem: { ...newMem(T), state: "review", scheduledDays: 2, reps: 3, stability: 2, difficulty: 5, lastReview: T }, ...over,
});
const iv = { 1: "<10м", 2: "1д", 3: "2д", 4: "4д" } as const;
const counts = { n: 4, l: 1, r: 12 };

describe("views", () => {
  it("card layout: word first, blocks separated, counters last", () => {
    const { text, photo } = renderCard(view(), counts, iv, false, "ru");
    expect(text).toBe([
      "<b>reliable</b>",
      "/rɪˈlaɪəbl/ · <i>adj</i>",
      "",
      "<tg-spoiler><b>надёжный</b></tg-spoiler>",
      "<blockquote><tg-spoiler><i>He is <b>reliable</b>.</i>",
      "Он надёжный.</tg-spoiler></blockquote>",
      "🌿 Учу · память ~2 дн. · повтор №4",
      "🔵 4 · 🔴 1 · 🟢 12",
    ].join("\n"));
    expect(photo).toBeUndefined();
  });

  it("the studied word is bold in the example, including inflected forms", () => {
    const t1 = renderCard(view({ word: "achieve", exampleEn: "She achieved her goal." }), counts, iv, false, "ru").text;
    expect(t1).toContain("<i>She <b>achieved</b> her goal.</i>");
    const t2 = renderCard(view({ word: "it's up to you", exampleEn: "Pizza or sushi? It's up to you." }), counts, iv, false, "ru").text;
    expect(t2).toContain("<b>It's up to you</b>.");
    const t3 = renderCard(view({ word: "go", exampleEn: "A good idea." }), counts, iv, false, "ru").text;
    expect(t3).toContain("<i>A good idea.</i>");
  });

  it("highlight never touches html entities or unrelated longer words", () => {
    const ex = (word: string, exampleEn: string) => renderCard(view({ word, exampleEn }), counts, iv, false, "ru").text;
    expect(ex("amp", "Loud & clear amp.")).toContain("<i>Loud &amp; clear <b>amp</b>.</i>");
    expect(ex("an", "Salt and an egg.")).toContain("<i>Salt and <b>an</b> egg.</i>");
    expect(ex("car", "A card in the car.")).toContain("<i>A card in the <b>car</b>.</i>");
    expect(ex("decide", "He decided quickly.")).toContain("<b>decided</b>");
    expect(ex("a<b", "Is a<b true?")).toContain("<i>Is <b>a&lt;b</b> true?</i>");
  });

  it("card without an example has no empty quote", () => {
    const { text } = renderCard(view({ exampleEn: "", exampleRu: "" }), counts, iv, false, "ru");
    expect(text).not.toContain("blockquote");
    expect(text).toContain("</tg-spoiler>\n\n🌿");
  });

  it("card with a picture is sent as a photo", () => {
    expect(renderCard(view({ imageFileId: "PHOTO1" }), counts, iv, false, "ru").photo).toBe("PHOTO1");
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
    expect(keyboard[2]!.map((b) => b.callback_data)).toEqual(["v:3", "pic:3", "u"]);
  });

  it("voice button is on every card; undo only when allowed", () => {
    const { keyboard } = renderCard(view(), counts, iv, false, "ru");
    expect(keyboard[2]!.map((b) => b.callback_data)).toEqual(["v:3", "pic:3"]);
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

  it("ru to en direction hides the English word", () => {
    const { text } = renderCard(view({ direction: "ru_en" }), counts, iv, false, "ru");
    expect(text.startsWith("<b>надёжный</b>\n\n<tg-spoiler><b>reliable</b> /rɪˈlaɪəbl/</tg-spoiler>\n<blockquote>")).toBe(true);
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

  it("add preview shows one card with its link host and actions", () => {
    const one = renderAddPreview({ word: "resilient", ipa: "/rɪˈzɪliənt/", pos: "adj", translation: "стойкий", exampleEn: "Kids are resilient.", exampleRu: "Дети стойкие.", sourceUrl: "https://example.com/a" }, 5, "ru");
    expect(one.text).toContain("<b>resilient</b>");
    expect(one.text).toContain("🔗 example.com");
    expect(one.keyboard.flat().map((b) => b.callback_data)).toEqual(["add:ok:5", "add:edit:5", "add:no:5"]);
  });

  it("a single side asks for the other language and offers auto-translation", () => {
    const en = renderAwait({ side: "en", text: "break <the> ice", token: "abc" }, "ru");
    expect(en.text).toContain("<b>break &lt;the&gt; ice</b>");
    expect(en.text).toContain("по-русски");
    expect(en.keyboard.flat().map((b) => b.callback_data)).toEqual(["tr:auto:abc", "tr:no:abc"]);
    expect(renderAwait({ side: "ru", text: "уютный", token: "abc" }, "ru").text).toContain("по-английски");
  });

  it("my words: an empty hint, or a page of word buttons with paging", () => {
    const empty = renderMyWords({ total: 0, page: 0, pages: 1, items: [] }, "ru");
    expect(empty.text).toContain("пока пуст");
    expect(empty.keyboard.flat().map((b) => b.callback_data)).toEqual(["help:add"]);
    const items = [{ id: 7, word: "thrive", translation: "процветать" }, { id: 5, word: "a".repeat(90), translation: "очень длинный перевод ".repeat(10) }];
    const one = renderMyWords({ total: 2, page: 0, pages: 1, items }, "ru");
    expect(one.text).toContain("Мои слова</b> · 2");
    expect(one.keyboard[0]![0]).toMatchObject({ text: "thrive — процветать", callback_data: "mw:o:7:0" });
    expect(one.keyboard[1]![0]!.text.length).toBeLessThanOrEqual(64);
    expect(one.keyboard.flat().map((b) => b.callback_data)).toEqual(["mw:o:7:0", "mw:o:5:0", "learn", "help:add"]);
    const mid = renderMyWords({ total: 20, page: 1, pages: 3, items }, "ru");
    expect(mid.keyboard[2]!.map((b) => b.callback_data)).toEqual(["mw:p:0", "mw:p:1", "mw:p:2"]);
    expect(mid.keyboard[2]![1]!.text).toBe("2/3");
    expect(renderMyWords({ total: 20, page: 0, pages: 3, items }, "ru").keyboard[2]!.map((b) => b.callback_data)).toEqual(["mw:p:0", "mw:p:1"]);
  });

  it("a word of the dictionary shows the whole card and what can be done with it", () => {
    const note = { id: 7, deckId: 1, word: "Tom & Jerry", ipa: "/tɒm/", pos: "noun", translation: "Том и Джерри", exampleEn: "Tom & Jerry is on.", exampleRu: "Идёт «Том и Джерри».", audioFileId: null, audioUrl: null, sourceUrl: "https://example.com/a", imageFileId: "PIC" };
    const r = renderWord(note, 2, "ru");
    expect(r.text).toContain("<b>Tom &amp; Jerry</b>");
    expect(r.text).toContain("<b>Том и Джерри</b>");
    expect(r.text).toContain("🔗 example.com");
    expect(r.text).toContain("🖼");
    expect(r.keyboard.flat().map((b) => b.callback_data)).toEqual(["mw:e:7:2", "mw:i:7:2", "mw:d:7:2", "mw:p:2"]);
    const ask = renderDeleteAsk("Tom & Jerry", 7, 2, "ru");
    expect(ask.text).toContain("Tom &amp; Jerry");
    expect(ask.keyboard.flat().map((b) => b.callback_data)).toEqual(["mw:dy:7:2", "mw:o:7:2"]);
  });

  it("a picture: buttons for the words that were read, or a request to type the word", () => {
    const ask = renderPhotoAsk({ text: "He was <thorough>, as always.", words: ["thorough", "always"], phrase: "He was thorough, as always", token: "tk" }, "ru", true);
    expect(ask.text).toContain("«He was &lt;thorough&gt;, as always.»");
    expect(ask.keyboard.flat().map((b) => b.callback_data)).toEqual(["ph:w:tk:0", "ph:w:tk:1", "ph:all:tk", "ph:no:tk"]);
    expect(ask.keyboard[0]!.map((b) => b.text)).toEqual(["thorough", "always"]);
    const none = renderPhotoAsk({ text: null, words: [], phrase: null, token: "tk" }, "ru", true);
    expect(none.text).toContain("не прочитался");
    expect(none.keyboard.flat().map((b) => b.callback_data)).toEqual(["ph:no:tk"]);
    expect(renderPhotoAsk({ text: null, words: [], phrase: null, token: "tk" }, "ru", false).text).toContain("Напишите слово");
    const seven = renderPhotoAsk({ text: "x", words: ["a1", "a2", "a3", "a4", "a5", "a6", "a7"], phrase: null, token: "tk" }, "ru", true);
    expect(seven.keyboard.slice(0, 3).map((row) => row.length)).toEqual([3, 3, 1]);
  });

  it("ru and en have the same keys", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ru).sort());
  });
});

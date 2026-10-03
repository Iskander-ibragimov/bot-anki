import { describe, expect, it } from "vitest";
import { cleanUrl, parseEntry, type Entity } from "../../src/content/links";

/** url entities shaped like Telegram's: trailing punctuation is outside the entity. */
const urlEntities = (text: string): Entity[] => {
  const out: Entity[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s)]+[^\s).,]/g)) out.push({ type: "url", offset: m.index!, length: m[0].length });
  return out;
};
const parse = (t: string) => parseEntry(t, urlEntities(t));

describe("parseEntry: one card per message", () => {
  it("english and russian in any order make a pair", () => {
    const pair = { kind: "pair", en: "break the ice", ru: "растопить лёд", url: null };
    expect(parse("break the ice растопить лёд")).toEqual(pair);
    expect(parse("растопить лёд break the ice")).toEqual(pair);
    expect(parse("break the ice — растопить лёд")).toEqual(pair);
    expect(parse("растопить лёд - break the ice")).toEqual(pair);
    expect(parse("break the ice = растопить лёд")).toEqual(pair);
    expect(parse("растопить лёд\nbreak the ice")).toEqual(pair);
    expect(parse("resilient—устойчивый")).toEqual({ kind: "pair", en: "resilient", ru: "устойчивый", url: null });
  });

  it("only one language is a single side waiting for the other", () => {
    expect(parse("serendipity")).toEqual({ kind: "single", side: "en", text: "serendipity", url: null });
    expect(parse("It's up to you!")).toEqual({ kind: "single", side: "en", text: "It's up to you!", url: null });
    expect(parse("счастливая случайность")).toEqual({ kind: "single", side: "ru", text: "счастливая случайность", url: null });
    expect(parse("well-known")).toEqual({ kind: "single", side: "en", text: "well-known", url: null });
    expect(parse("state - of the art")).toEqual({ kind: "single", side: "en", text: "state - of the art", url: null });
  });

  it("a russian word that contains latin letters stays on the russian side", () => {
    expect(parse("IT department IT-отдел")).toEqual({ kind: "pair", en: "IT department", ru: "IT-отдел", url: null });
    expect(parse("e-mail = электронная почта")).toEqual({ kind: "pair", en: "e-mail", ru: "электронная почта", url: null });
    expect(parse("cozy — уютный, тёплый (о доме)")).toEqual({ kind: "pair", en: "cozy", ru: "уютный, тёплый (о доме)", url: null });
  });

  it("numbers stay with the side they were written on", () => {
    expect(parse("7 days a week 7 дней в неделю")).toEqual({ kind: "pair", en: "7 days a week", ru: "7 дней в неделю", url: null });
    expect(parse("2 недели 2 weeks")).toEqual({ kind: "pair", en: "2 weeks", ru: "2 недели", url: null });
    expect(parse("page 5 страница 5")).toEqual({ kind: "pair", en: "page 5", ru: "страница 5", url: null });
    expect(parse("at 5 pm в 5 вечера")).toEqual({ kind: "pair", en: "at 5 pm", ru: "в 5 вечера", url: null });
    expect(parse("24/7 круглосуточно")).toEqual({ kind: "single", side: "ru", text: "24/7 круглосуточно", url: null });
    expect(parse("10 minutes — 10 минут")).toEqual({ kind: "pair", en: "10 minutes", ru: "10 минут", url: null });
  });

  it("sides glued by punctuation or written as a list item are still split cleanly", () => {
    const pair = { kind: "pair", en: "cat", ru: "кот", url: null };
    for (const t of ["cat,кот", "cat/кот", "cat:кот", "кот;cat", "cat / кот", "cat -> кот", "cat → кот", "cat | кот", "1) cat - кот", "• cat — кот", "2. кот cat"]) {
      expect(parse(t), t).toEqual(pair);
    }
  });

  it("question and exclamation marks of a phrase are kept, abbreviations keep their dot", () => {
    expect(parse("How are you? Как дела?")).toEqual({ kind: "pair", en: "How are you?", ru: "Как дела?", url: null });
    expect(parse("привет, hello!")).toEqual({ kind: "pair", en: "hello", ru: "привет", url: null });
    expect(parse("cozy (уютный)")).toEqual({ kind: "pair", en: "cozy", ru: "уютный", url: null });
    expect(parse("и т.д. — and so on.")).toEqual({ kind: "pair", en: "and so on", ru: "и т.д.", url: null });
  });

  it("a link without http is attached too", () => {
    expect(parseEntry("cat кот example.com/cats", [{ type: "url", offset: 8, length: 16 }])).toEqual({ kind: "pair", en: "cat", ru: "кот", url: "https://example.com/cats" });
  });

  it("several cards in one message are refused", () => {
    expect(parse("cozy\nthrive")).toEqual({ kind: "too-many" });
    expect(parse("cozy\nуютный\nthrive")).toEqual({ kind: "too-many" });
    expect(parse("уютный\nтёплый")).toEqual({ kind: "too-many" });
  });

  it("interleaved languages cannot be split", () => {
    expect(parse("cozy уютный warm тёплый")).toEqual({ kind: "unclear" });
  });

  it("a link in the message is attached and removed from the text", () => {
    expect(parse("resilient https://example.com/a")).toEqual({ kind: "single", side: "en", text: "resilient", url: "https://example.com/a" });
    expect(parse("https://a.com/p cozy — уютный")).toEqual({ kind: "pair", en: "cozy", ru: "уютный", url: "https://a.com/p" });
    expect(parse("serendipity (https://x.com/a).")).toEqual({ kind: "single", side: "en", text: "serendipity", url: "https://x.com/a" });
    expect(parse("cozy уютный\nhttps://youtu.be/x")).toEqual({ kind: "pair", en: "cozy", ru: "уютный", url: "https://youtu.be/x" });
    expect(parseEntry("gorgeous view", [{ type: "text_link", offset: 0, length: 8, url: "https://pics.com/1" }]))
      .toEqual({ kind: "single", side: "en", text: "gorgeous view", url: "https://pics.com/1" });
    expect(parseEntry("awkward (https://x.com/a).", [])).toEqual({ kind: "single", side: "en", text: "awkward", url: "https://x.com/a" });
  });

  it("a message with only a link, or nothing, is reported as such", () => {
    expect(parse("https://example.com/article")).toEqual({ kind: "url-only", url: "https://example.com/article" });
    expect(parse("   ")).toEqual({ kind: "empty" });
    expect(parse("123 !!!")).toEqual({ kind: "empty" });
  });

  it("non-http schemes and overlong urls are not links", () => {
    expect(parseEntry("cozy javascript:alert(1)", [])).toEqual({ kind: "single", side: "en", text: "cozy javascript:alert(1)", url: null });
    expect(cleanUrl("https://e.com/" + "a".repeat(600))).toBeNull();
    expect(cleanUrl("https://en.wikipedia.org/wiki/Set_(mathematics)")).toBe("https://en.wikipedia.org/wiki/Set_(mathematics)");
    expect(cleanUrl("https://x.com/a).")).toBe("https://x.com/a");
  });

  it("over-long sides are cut", () => {
    const r = parse(`${"w".repeat(300)} — ${"я".repeat(900)}`);
    if (r.kind !== "pair") throw new Error(r.kind);
    expect(r.en.length).toBeLessThanOrEqual(100);
    expect(r.ru.length).toBeLessThanOrEqual(300);
  });
});

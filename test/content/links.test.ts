import { describe, expect, it } from "vitest";
import { parseWordsAndLinks, type Entity } from "../../src/content/links";

const urlEntities = (text: string): Entity[] => {
  const out: Entity[] = [];
  for (const m of text.matchAll(/https?:\/\/\S+/g)) out.push({ type: "url", offset: m.index!, length: m[0].length });
  return out;
};

describe("parseWordsAndLinks", () => {
  it("same-line url attaches to that word", () => {
    const t = "resilient https://example.com/a\nawkward";
    expect(parseWordsAndLinks(t, urlEntities(t)).items).toEqual([
      { word: "resilient", url: "https://example.com/a" }, { word: "awkward", url: null },
    ]);
  });
  it("standalone url line attaches to all words without their own", () => {
    const t = "https://youtu.be/x\ncozy\nthrive — https://b.org/t";
    expect(parseWordsAndLinks(t, urlEntities(t)).items).toEqual([
      { word: "cozy", url: "https://youtu.be/x" }, { word: "thrive", url: "https://b.org/t" },
    ]);
  });
  it("url first then words on the same line", () => {
    const t = "https://a.com/p serendipity";
    expect(parseWordsAndLinks(t, urlEntities(t)).items).toEqual([{ word: "serendipity", url: "https://a.com/p" }]);
  });
  it("text_link on a word", () => {
    const t = "gorgeous view";
    const r = parseWordsAndLinks(t, [{ type: "text_link", offset: 0, length: 8, url: "https://pics.com/1" }]);
    expect(r.items).toEqual([{ word: "gorgeous view", url: "https://pics.com/1" }]);
  });
  it("url-only message returns orphanUrl", () => {
    const t = "https://example.com/article";
    expect(parseWordsAndLinks(t, urlEntities(t))).toEqual({ items: [], orphanUrl: "https://example.com/article" });
  });
  it("trailing punctuation is trimmed, raw urls found without entities", () => {
    expect(parseWordsAndLinks("awkward (https://x.com/a).", []).items).toEqual([{ word: "awkward", url: "https://x.com/a" }]);
  });
  it("non-http schemes and overlong urls are dropped", () => {
    const long = "https://e.com/" + "a".repeat(600);
    const r = parseWordsAndLinks(`cozy javascript:alert(1)\nthrive ${long}`, []);
    expect(r.items).toEqual([{ word: "cozy javascript:alert(1)", url: null }, { word: "thrive", url: null }]);
  });
  it("two urls on one line: first wins", () => {
    const t = "cozy https://a.com https://b.com";
    expect(parseWordsAndLinks(t, urlEntities(t)).items).toEqual([{ word: "cozy", url: "https://a.com" }]);
  });
  it("telegram-shaped entities: punctuation around links is not part of the word", () => {
    const tg = (text: string, url: string): Entity[] => [{ type: "url", offset: text.indexOf(url), length: url.length }];
    const cases: [string, string, string][] = [
      ["serendipity (https://x.com/a).", "https://x.com/a", "serendipity"],
      ["serendipity https://x.com/a).", "https://x.com/a", "serendipity"],
      ["serendipity — https://x.com/a.", "https://x.com/a", "serendipity"],
      ["word, https://x.com/a", "https://x.com/a", "word"],
    ];
    for (const [text, url, word] of cases) expect(parseWordsAndLinks(text, tg(text, url)).items).toEqual([{ word, url }]);
  });
  it("balanced parentheses inside a url are kept", () => {
    const u = "https://en.wikipedia.org/wiki/Set_(mathematics)";
    expect(parseWordsAndLinks(`set ${u}`, []).items).toEqual([{ word: "set", url: u }]);
    expect(parseWordsAndLinks(`set (${u})`, []).items).toEqual([{ word: "set", url: u }]);
  });
  it("keeps at most 20 words and drops duplicates", () => {
    const t = Array.from({ length: 25 }, (_, i) => `w${i}`).concat(["w1"]).join("\n");
    const r = parseWordsAndLinks(t, []);
    expect(r.items).toHaveLength(20);
  });

  it("'word — перевод' lines carry the user's own translation", () => {
    expect(parseWordsAndLinks("serendipity — счастливая случайность", []).items).toEqual([{ word: "serendipity", url: null, translation: "счастливая случайность" }]);
    expect(parseWordsAndLinks("cozy - уютный https://x.com/a", []).items).toEqual([{ word: "cozy", url: "https://x.com/a", translation: "уютный" }]);
    expect(parseWordsAndLinks("thrive = процветать\nlong time no see – сто лет не виделись", []).items).toEqual([
      { word: "thrive", url: null, translation: "процветать" }, { word: "long time no see", url: null, translation: "сто лет не виделись" },
    ]);
  });
  it("hyphenated words and english-only lines are not split", () => {
    expect(parseWordsAndLinks("well-known\nstate - of the art", []).items).toEqual([{ word: "well-known", url: null }, { word: "state - of the art", url: null }]);
  });
});

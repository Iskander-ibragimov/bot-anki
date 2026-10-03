import { describe, expect, it } from "vitest";
import { cleanOcr, wordChoices } from "../../src/content/photo";
import { VisionClient, toBase64 } from "../../src/content/vision";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const P = (baseUrl: string) => ({ baseUrl, apiKey: "k", model: "vision-m" });

describe("text read from a picture", () => {
  it("keeps the English line and drops everything that is not it", () => {
    expect(cleanOcr("...and not twist.")).toBe("...and not twist.");
    expect(cleanOcr('"It\'s raining\ncats and dogs."')).toBe("It's raining cats and dogs.");
    expect(cleanOcr("```\nHello there\n```")).toBe("Hello there");
    expect(cleanOcr("Сезон 2 Серия 3 — and not twist.")).toBe("and not twist.");
    expect(cleanOcr("NONE")).toBeNull();
    expect(cleanOcr("none.")).toBeNull();
    expect(cleanOcr("Субтитры 4K")).toBeNull();
    expect(cleanOcr("  ")).toBeNull();
    expect(cleanOcr("word ".repeat(100))!.length).toBeLessThanOrEqual(200);
  });

  it("takes the line out of a chatty answer and treats refusals as no text", () => {
    expect(cleanOcr('The subtitle reads: "...and not twist."')).toBe("...and not twist.");
    expect(cleanOcr("Subtitle: ...and not twist.")).toBe("...and not twist.");
    expect(cleanOcr('The subtitle reads: "...and not twist." Other text: theatre.example')).toBe("...and not twist.");
    expect(cleanOcr("The text in the image says “Leave now.”")).toBe("Leave now.");
    expect(cleanOcr("**...and not twist.**")).toBe("...and not twist.");
    expect(cleanOcr("`...and not twist.`")).toBe("...and not twist.");
    expect(cleanOcr("...and not twist.\n\n(Note: this is the subtitle of the frame.)")).toBe("...and not twist.");
    expect(cleanOcr('He said "no"')).toBe('He said "no"');
    expect(cleanOcr("First line\nsecond line")).toBe("First line second line");
    for (const refusal of ["There is no English text in this image.", "NONE (there is no English text in the image)", "I’m sorry, but I can’t help with that.", "No text found.", "I cannot read any text here."]) {
      expect(cleanOcr(refusal), refusal).toBeNull();
    }
  });

  it("offers the meaningful words of the line and the whole phrase", () => {
    expect(wordChoices("...and not twist.")).toEqual({ words: ["twist"], phrase: "and not twist" });
    expect(wordChoices("I've been thoroughly THOROUGH, haven't I?")).toEqual({ words: ["thoroughly", "thorough"], phrase: "I've been thoroughly THOROUGH, haven't I?" });
    expect(wordChoices("Resilient")).toEqual({ words: ["resilient"], phrase: null });
    expect(wordChoices("It is what it is")).toEqual({ words: [], phrase: "It is what it is" });
    const many = wordChoices("The quick brown fox jumps over the lazy dog near the quiet river bank at dawn while birds sing loudly");
    expect(many.words).toHaveLength(8);
    expect(many.words.slice(0, 3)).toEqual(["quick", "brown", "fox"]);
    expect(wordChoices("x".repeat(50) + " " + "y".repeat(60)).phrase).toBeNull(); // too long to be a card
    expect(wordChoices("I was--you know--busy. Stop it, John!").words).toEqual(["know", "busy", "stop", "John"]);
    expect(wordChoices("WHO'S THERE? LEAVE NOW").words).toEqual(["leave", "now"]);
    expect(wordChoices("He works at NASA, here's proof").words).toEqual(["works", "NASA", "proof"]);
  });
});

describe("vision client", () => {
  const bytes = new Uint8Array([255, 216, 255, 0, 1, 2, 3]);

  it("base64 works for large inputs", () => {
    expect(toBase64(new Uint8Array([104, 105]))).toBe("aGk=");
    expect(toBase64(new Uint8Array(200_000)).length).toBe(Math.ceil(200_000 / 3) * 4);
    expect(toBase64(new Uint8Array([0, 255, 128, 7]).subarray(1, 3))).toBe("/4A="); // a view into a larger buffer
  });

  it("sends the picture as a data URL and returns the cleaned line", async () => {
    let body: { model: string; messages: { content: { type: string; text?: string; image_url?: { url: string } }[] }[] } | undefined;
    let auth = "";
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://v/v1/chat/completions");
      body = JSON.parse(String(init!.body));
      auth = new Headers(init!.headers).get("authorization") ?? "";
      return json({ choices: [{ message: { content: '"...and not twist."' } }] });
    }) as typeof fetch;
    const c = new VisionClient([P("https://v/v1")], f);
    expect(c.available).toBe(true);
    expect(await c.readText(bytes, "image/jpeg")).toBe("...and not twist.");
    expect(auth).toBe("Bearer k");
    expect(body!.model).toBe("vision-m");
    const parts = body!.messages[0]!.content;
    expect(parts.find((p) => p.type === "image_url")!.image_url!.url).toBe(`data:image/jpeg;base64,${toBase64(bytes)}`);
    expect(parts.find((p) => p.type === "text")!.text).toMatch(/subtitle/i);
  });

  it("falls back to the next provider and never throws", async () => {
    const urls: string[] = [];
    const f = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (String(input).startsWith("https://a")) return json({ error: "rate limit" }, 429);
      return json({ choices: [{ message: { content: "Hello there" } }] });
    }) as typeof fetch;
    expect(await new VisionClient([P("https://a/v1"), P("https://b/v1")], f).readText(bytes, "image/jpeg")).toBe("Hello there");
    expect(urls).toHaveLength(2);
    const broken = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
    expect(await new VisionClient([P("https://a/v1")], broken).readText(bytes, "image/jpeg")).toBeNull();
    expect(new VisionClient([], f).available).toBe(false);
    expect(await new VisionClient([], f).readText(bytes, "image/jpeg")).toBeNull();
  });

  it("a hanging provider is cut off by the deadline", async () => {
    const hang = ((_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
    const started = Date.now();
    expect(await new VisionClient([P("https://a/v1"), P("https://b/v1")], hang).readText(bytes, "image/jpeg", Date.now() + 300)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

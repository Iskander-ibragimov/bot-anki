import type { LlmProvider } from "./llm";
import { cleanOcr } from "./photo";

const PROMPT =
  "Read the English text shown in this image. If it is a frame of a film, series or video, return only the subtitle line " +
  "and ignore player controls, menus, watermarks and web addresses. Reply with the text exactly as written, on one line, " +
  "with no comments and no translation. If there is no English text, reply NONE.";

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Reads the text on a picture with an OpenAI-compatible vision model. Never throws: no text and no service both give null. */
export class VisionClient {
  constructor(private readonly providers: LlmProvider[], private readonly fetcher: typeof fetch = (input, init) => fetch(input, init), private readonly timeoutMs = 15_000) {}

  get available(): boolean { return this.providers.length > 0; }

  async readText(bytes: Uint8Array, mime: string, deadline = Date.now() + 22_000): Promise<string | null> {
    if (!this.providers.length) return null;
    const url = `data:${mime};base64,${toBase64(bytes)}`;
    for (const p of this.providers) {
      const left = deadline - Date.now();
      if (left <= 200) break;
      try {
        const res = await this.fetcher(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
          body: JSON.stringify({
            model: p.model, temperature: 0, max_tokens: 200,
            messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url } }] }],
          }),
          signal: AbortSignal.timeout(Math.min(this.timeoutMs, left)),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const content = body.choices?.[0]?.message?.content;
        if (typeof content !== "string") throw new Error("no content");
        return cleanOcr(content);
      } catch (e) {
        console.error(`vision ${p.baseUrl}: ${(e as Error).message.slice(0, 200)}`);
      }
    }
    return null;
  }
}

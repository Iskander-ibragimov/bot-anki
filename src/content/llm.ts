import { z } from "zod";
import type { LlmProvider } from "../env";

const CYR = /[А-Яа-яЁё]/;
export const WordCardSchema = z.object({
  word: z.string().trim().min(1),
  ipa: z.string().nullish(),
  pos: z.string().default(""),
  translation: z.string().trim().min(1).refine((s) => CYR.test(s), "translation must be Russian"),
  exampleEn: z.string().trim().min(1).refine((s) => !CYR.test(s), "exampleEn must be English"),
  exampleRu: z.string().trim().min(1).refine((s) => CYR.test(s), "exampleRu must be Russian"),
});
export type WordCard = z.infer<typeof WordCardSchema>;

export class LlmUnavailable extends Error {}

/** OpenAI-compatible chat client that tries providers in order until one returns valid JSON. */
export class LlmClient {
  constructor(private readonly providers: LlmProvider[], private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = 20_000) {}

  async completeJson<T extends z.ZodTypeAny>(system: string, user: string, schema: T): Promise<z.infer<T>> {
    const errors: string[] = [];
    for (const p of this.providers) {
      try {
        const res = await this.fetcher(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
          body: JSON.stringify({
            model: p.model, temperature: 0.2, response_format: { type: "json_object" },
            messages: [{ role: "system", content: system }, { role: "user", content: user }],
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const content = body.choices?.[0]?.message?.content ?? "";
        const raw = content.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
        return schema.parse(JSON.parse(raw));
      } catch (e) {
        errors.push(`${p.baseUrl}: ${(e as Error).message.slice(0, 200)}`);
      }
    }
    throw new LlmUnavailable(errors.join("; ") || "no providers");
  }
}

export const WORDS_SYSTEM =
  "You build flashcards for Russian speakers learning English. Reply with JSON only: " +
  '{"cards":[{"word","ipa","pos","translation","exampleEn","exampleRu"}]}. ' +
  "translation: short Russian translation (1–3 variants). exampleEn: one natural everyday English sentence with the word. " +
  "exampleRu: its Russian translation. ipa: British IPA in slashes or null. pos: noun/verb/adj/adv/phrase. Keep the words exactly as given.";

export const DECK_SYSTEM =
  "You create themed English vocabulary decks for Russian speakers. Reply with JSON only: " +
  '{"cards":[{"word","ipa","pos","translation","exampleEn","exampleRu"}]}. ' +
  "Pick the most useful words and short phrases for the topic, no duplicates, from common to advanced.";

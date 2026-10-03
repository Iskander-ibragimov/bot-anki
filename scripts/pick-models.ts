/**
 * Prints provider JSON for the worker.
 *   (no argument)  LLM_PROVIDERS: a currently available text model on Groq and a free one on OpenRouter.
 *   vision         VISION_PROVIDERS: models that can read the text on a picture. Each candidate is tried
 *                  on a sample film frame with the worker's own client; only those that read it are kept.
 * Env: GROQ_API_KEY, OPENROUTER_API_KEY (either may be missing).
 * Optional overrides: GROQ_MODEL, OPENROUTER_MODEL, GROQ_VISION_MODEL, OPENROUTER_VISION_MODEL.
 */
import { readFileSync } from "node:fs";
import { VisionClient } from "../src/content/vision";

const GROQ = "https://api.groq.com/openai/v1";
const OPENROUTER = "https://openrouter.ai/api/v1";
const GROQ_PREF = ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "openai/gpt-oss-20b", "moonshotai/kimi-k2-instruct", "llama-3.1-8b-instant"];
const OR_PREF = ["meta-llama/llama-3.3-70b-instruct:free", "openai/gpt-oss-120b:free", "openai/gpt-oss-20b:free", "deepseek/deepseek-chat-v3.1:free", "qwen/qwen3-235b-a22b:free"];
const GROQ_VISION_PREF = ["qwen/qwen3.8-27b", "meta-llama/llama-4-scout-17b-16e-instruct", "meta-llama/llama-4-maverick-17b-128e-instruct", "llama-3.2-90b-vision-preview", "llama-3.2-11b-vision-preview"];
const OR_VISION_PREF = ["google/gemma-3-27b-it:free", "meta-llama/llama-4-maverick:free", "meta-llama/llama-4-scout:free", "mistralai/mistral-small-3.2-24b-instruct:free", "qwen/qwen2.5-vl-72b-instruct:free", "google/gemma-3-12b-it:free"];
const MAX_TRIES = 4;

interface Model { id: string; architecture?: { input_modalities?: string[]; modality?: string } }
type Provider = { baseUrl: string; apiKey: string; model: string };

async function list(base: string, key: string): Promise<Model[]> {
  try {
    const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) { console.error(`${base}/models: HTTP ${res.status}`); return []; }
    return ((await res.json()) as { data?: Model[] }).data ?? [];
  } catch (e) { console.error(`${base}/models: ${(e as Error).message}`); return []; }
}
const choose = (ids: string[], pref: string[], fallback: (id: string) => boolean) => pref.find((p) => ids.includes(p)) ?? ids.find(fallback);
const { GROQ_API_KEY, OPENROUTER_API_KEY, GROQ_MODEL, OPENROUTER_MODEL, GROQ_VISION_MODEL, OPENROUTER_VISION_MODEL } = process.env;
const providers: Provider[] = [];

if (process.argv[2] === "vision") {
  const frame = new Uint8Array(readFileSync(new URL("./fixtures/subtitle.jpg", import.meta.url)));
  /** Known vision models first, then anything that looks like one; the override, if set, goes before all. */
  const order = (ids: string[], pref: string[], override: string | undefined) =>
    [...new Set([...(override ? [override] : []), ...pref.filter((p) => ids.includes(p)), ...ids])].slice(0, MAX_TRIES);
  /** The sample frame says "...and not twist."; an answer with anything else in it would end up on the user's cards. */
  const exact = (read: string | null) => read !== null && read.toLowerCase().replace(/[^a-z]+/g, "") === "andnottwist";
  /** fetch that remembers why the last call failed (status and the provider's own message; never the key). */
  let why = "";
  const probe: typeof fetch = async (input, init) => {
    try {
      const res = await fetch(input, init);
      if (res.ok) { why = ""; return res; }
      let message = "";
      try { message = String(((await res.clone().json()) as { error?: { message?: unknown } }).error?.message ?? ""); } catch { /* not JSON */ }
      why = `HTTP ${res.status} ${message.replace(/\s+/g, " ").slice(0, 140)}`.trim();
      return res;
    } catch (e) {
      why = `no response (${(e as Error).name})`;
      throw e;
    }
  };
  const busy = () => /^HTTP (408|429|5\d\d)|^no response/.test(why);
  const firstWorking = async (name: string, baseUrl: string, apiKey: string, candidates: string[]) => {
    let later: string | undefined; // a model that was only busy: rate limits must not switch the feature off until the next deploy
    const tried: string[] = [];
    for (const model of candidates) {
      const client = new VisionClient([{ baseUrl, apiKey, model }], probe);
      let read = await client.readText(frame, "image/jpeg", Date.now() + 40_000);
      if (read === null && busy()) read = await client.readText(frame, "image/jpeg", Date.now() + 40_000);
      if (exact(read)) {
        providers.push({ baseUrl, apiKey, model });
        console.error(`::notice title=Picture reading::${name}: ${model} read the sample frame`);
        return;
      }
      if (read === null && busy()) later ??= model;
      tried.push(`${model}: ${read !== null ? `read "${read.slice(0, 60)}"` : why || "saw no text"}`);
    }
    if (later) providers.push({ baseUrl, apiKey, model: later });
    console.error(`::warning title=Picture reading::${name}: ${tried.join("; ") || "no candidate models"}${later ? ` — keeping ${later} unverified` : ""}`);
  };
  if (GROQ_API_KEY) {
    const ids = (await list(GROQ, GROQ_API_KEY)).map((m) => m.id).filter((id) => /qwen|llama-4|vision|llava|pixtral|gemma|gemini/i.test(id) && !/guard|whisper|tts/i.test(id));
    await firstWorking("groq", GROQ, GROQ_API_KEY, order(ids, GROQ_VISION_PREF, GROQ_VISION_MODEL));
  }
  if (OPENROUTER_API_KEY) {
    const sees = (m: Model) => m.architecture?.input_modalities?.includes("image") || /image/.test(m.architecture?.modality?.split("->")[0] ?? "");
    const ids = (await list(OPENROUTER, OPENROUTER_API_KEY)).filter((m) => m.id.endsWith(":free") && sees(m)).map((m) => m.id);
    // Only free models: an override that would cost money is ignored.
    const override = OPENROUTER_VISION_MODEL?.endsWith(":free") ? OPENROUTER_VISION_MODEL : undefined;
    if (OPENROUTER_VISION_MODEL && !override) console.error(`::warning title=Picture reading::OPENROUTER_VISION_MODEL ignored: ${OPENROUTER_VISION_MODEL} is not a free model`);
    await firstWorking("openrouter", OPENROUTER, OPENROUTER_API_KEY, order(ids, OR_VISION_PREF, override));
  }
  if (!providers.length) console.error("::warning title=Picture reading::no vision model available — a photo without a caption will ask for the word");
} else {
  if (GROQ_API_KEY) {
    const ids = (await list(GROQ, GROQ_API_KEY)).map((m) => m.id);
    const model = GROQ_MODEL || choose(ids, GROQ_PREF, (id) => /llama|gpt-oss|qwen/i.test(id) && !/guard|whisper|tts/i.test(id));
    if (model) providers.push({ baseUrl: GROQ, apiKey: GROQ_API_KEY, model });
    console.error(`groq: ${model ?? "none"}`);
  }
  if (OPENROUTER_API_KEY) {
    const ids = (await list(OPENROUTER, OPENROUTER_API_KEY)).map((m) => m.id);
    const model = OPENROUTER_MODEL || choose(ids, OR_PREF, (id) => id.endsWith(":free") && /llama|gpt-oss|qwen|deepseek|gemma|mistral/i.test(id));
    if (model) providers.push({ baseUrl: OPENROUTER, apiKey: OPENROUTER_API_KEY, model });
    console.error(`openrouter: ${model ?? "none"}`);
  }
  if (!providers.length) console.error("WARNING: no LLM provider available — custom words will ask for manual translation");
}
process.stdout.write(JSON.stringify(providers));

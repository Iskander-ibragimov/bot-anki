/**
 * Prints LLM_PROVIDERS JSON for the worker: picks a currently available model on Groq and a free one on OpenRouter.
 * Env: GROQ_API_KEY, OPENROUTER_API_KEY (either may be missing). Optional overrides: GROQ_MODEL, OPENROUTER_MODEL.
 */
export {};
const GROQ_PREF = ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "openai/gpt-oss-20b", "moonshotai/kimi-k2-instruct", "llama-3.1-8b-instant"];
const OR_PREF = ["meta-llama/llama-3.3-70b-instruct:free", "openai/gpt-oss-120b:free", "openai/gpt-oss-20b:free", "deepseek/deepseek-chat-v3.1:free", "qwen/qwen3-235b-a22b:free"];

async function list(url: string, key: string): Promise<string[]> {
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) { console.error(`${url}: HTTP ${res.status}`); return []; }
    const body = (await res.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => m.id);
  } catch (e) { console.error(`${url}: ${(e as Error).message}`); return []; }
}
const choose = (ids: string[], pref: string[], fallback: (id: string) => boolean) => pref.find((p) => ids.includes(p)) ?? ids.find(fallback);

const providers: { baseUrl: string; apiKey: string; model: string }[] = [];
const { GROQ_API_KEY, OPENROUTER_API_KEY, GROQ_MODEL, OPENROUTER_MODEL } = process.env;
if (GROQ_API_KEY) {
  const ids = await list("https://api.groq.com/openai/v1/models", GROQ_API_KEY);
  const model = GROQ_MODEL || choose(ids, GROQ_PREF, (id) => /llama|gpt-oss|qwen/i.test(id) && !/guard|whisper|tts/i.test(id));
  if (model) providers.push({ baseUrl: "https://api.groq.com/openai/v1", apiKey: GROQ_API_KEY, model });
  console.error(`groq: ${model ?? "none"}`);
}
if (OPENROUTER_API_KEY) {
  const ids = await list("https://openrouter.ai/api/v1/models", OPENROUTER_API_KEY);
  const model = OPENROUTER_MODEL || choose(ids, OR_PREF, (id) => id.endsWith(":free") && /llama|gpt-oss|qwen|deepseek|gemma|mistral/i.test(id));
  if (model) providers.push({ baseUrl: "https://openrouter.ai/api/v1", apiKey: OPENROUTER_API_KEY, model });
  console.error(`openrouter: ${model ?? "none"}`);
}
if (!providers.length) console.error("WARNING: no LLM provider available — custom words will ask for manual translation");
process.stdout.write(JSON.stringify(providers));

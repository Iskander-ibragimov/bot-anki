/** Minimal shape of the Workers AI binding. */
export interface AiBinding { run(model: string, input: Record<string, unknown>): Promise<unknown> }

const MODEL = "@cf/myshell-ai/melotts";

/** Workers AI returns audio as base64 JSON, raw bytes or a stream depending on the model/runtime version. */
export async function toBytes(out: unknown): Promise<Uint8Array | null> {
  if (out == null) return null;
  if (out instanceof Uint8Array) return out.length ? out : null;
  if (out instanceof ArrayBuffer) return out.byteLength ? new Uint8Array(out) : null;
  if (out instanceof ReadableStream || out instanceof Response) {
    const buf = await new Response(out instanceof Response ? out.body : out).arrayBuffer();
    return buf.byteLength ? new Uint8Array(buf) : null;
  }
  const audio = (out as { audio?: unknown }).audio;
  if (typeof audio === "string" && audio) {
    const bin = atob(audio);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  return audio && typeof audio === "object" ? toBytes(audio) : null;
}

/** English text-to-speech on Cloudflare Workers AI (MP3). */
export async function synthSpeech(ai: AiBinding, text: string): Promise<Uint8Array | null> {
  return toBytes(await ai.run(MODEL, { prompt: text.slice(0, 200), lang: "en" }));
}

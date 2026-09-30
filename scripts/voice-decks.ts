/**
 * Voices every catalog word once with Piper, uploads it to Telegram (admin chat) and stores file_id in the CSV.
 * Runs in GitHub Actions (see .github/workflows/voice-decks.yml). Resumable: rows with audio_file_id are skipped.
 * Env: BOT_TOKEN, ADMIN_TG_ID, PIPER_MODEL (path to .onnx).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDeck, readIndex, writeDeck } from "./lib/decks";

const { BOT_TOKEN, ADMIN_TG_ID, PIPER_MODEL } = process.env;
if (!BOT_TOKEN || !ADMIN_TG_ID || !PIPER_MODEL) throw new Error("BOT_TOKEN, ADMIN_TG_ID and PIPER_MODEL are required");
const dir = mkdtempSync(join(tmpdir(), "voice-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function upload(ogg: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const form = new FormData();
    form.append("chat_id", ADMIN_TG_ID!);
    form.append("disable_notification", "true");
    form.append("voice", new Blob([readFileSync(ogg)], { type: "audio/ogg" }), "word.ogg");
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendVoice`, { method: "POST", body: form });
    const body = (await res.json()) as { ok: boolean; result?: { voice?: { file_id: string } }; parameters?: { retry_after?: number }; description?: string };
    if (body.ok && body.result?.voice) return body.result.voice.file_id;
    if (body.parameters?.retry_after) { await sleep((body.parameters.retry_after + 1) * 1000); continue; }
    throw new Error(`sendVoice failed: ${body.description}`);
  }
  throw new Error("sendVoice: too many retries");
}

for (const deck of readIndex()) {
  const rows = readDeck(deck.file);
  let done = 0;
  for (const row of rows) {
    if (row.audio_file_id || !row.word) continue;
    const wav = join(dir, "w.wav"), ogg = join(dir, "w.ogg");
    execFileSync("piper", ["--model", PIPER_MODEL, "--output_file", wav], { input: row.word, stdio: ["pipe", "ignore", "inherit"] });
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, "-c:a", "libopus", "-b:a", "24k", ogg]);
    row.audio_file_id = await upload(ogg);
    if (++done % 25 === 0) writeDeck(deck.file, rows);
    await sleep(60);
  }
  writeDeck(deck.file, rows);
  console.log(`${deck.slug}: voiced ${done}`);
}

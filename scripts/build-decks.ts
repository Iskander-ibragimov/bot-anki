/**
 * Grows a catalog deck with the free LLM: npx tsx scripts/build-decks.ts --deck a2 --add 100
 * Env: GROQ_API_KEY and/or OPENROUTER_API_KEY. Rows are validated like runtime cards; existing words are kept.
 */
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { LlmClient, WordCardSchema } from "../src/content/llm";
import { readDeck, readIndex, writeDeck } from "./lib/decks";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const slug = arg("deck"); const add = Number(arg("add") ?? 50);
const deck = readIndex().find((d) => d.slug === slug);
if (!deck) throw new Error(`unknown deck ${slug}; use one of ${readIndex().map((d) => d.slug).join(", ")}`);
const providers = JSON.parse(execFileSync("npx", ["tsx", "scripts/pick-models.ts"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
const llm = new LlmClient(providers);
const rows = readDeck(deck.file);
const taken = new Set(readIndex().flatMap((d) => readDeck(d.file).map((r) => r.word!.toLowerCase())));
const Schema = z.object({ cards: z.array(WordCardSchema) });
const topic = deck.level ? `CEFR ${deck.level} general English vocabulary` : `${deck.titleEn} vocabulary`;
let added = 0;
for (let round = 0; round < 10 && added < add; round++) {
  const n = Math.min(25, add - added);
  const res = await llm.completeJson(
    "You write English flashcards for Russian speakers. Reply with JSON only: {\"cards\":[{\"word\",\"ipa\",\"pos\",\"translation\",\"exampleEn\",\"exampleRu\"}]}. " +
      "ipa: British IPA in slashes. translation: short Russian, 1–3 variants. exampleEn: natural sentence of 5–12 words. exampleRu: its Russian translation.",
    `Topic: ${topic}. Give ${n} useful items that are NOT in this list: ${[...taken].slice(-400).join(", ")}`,
    Schema,
  );
  for (const c of res.cards) {
    const k = c.word.trim().toLowerCase();
    if (taken.has(k) || added >= add) continue;
    taken.add(k);
    rows.push({ word: k, ipa: c.ipa ?? "", pos: c.pos, translation: c.translation, example_en: c.exampleEn, example_ru: c.exampleRu, audio_file_id: "" });
    added++;
  }
  writeDeck(deck.file, rows);
  console.log(`${slug}: +${added}`);
}

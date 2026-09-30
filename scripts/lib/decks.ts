import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv, toCsv } from "./csv";

export const DECKS_DIR = "data/decks";
export const CSV_HEADER = ["word", "ipa", "pos", "translation", "example_en", "example_ru", "audio_file_id"];
export interface DeckIndexEntry { slug: string; file: string; titleRu: string; titleEn: string; level: string | null; size: number }

export const readIndex = (): DeckIndexEntry[] => JSON.parse(readFileSync(join(DECKS_DIR, "index.json"), "utf8"));
export function readDeck(file: string): Record<string, string>[] {
  const p = join(DECKS_DIR, file);
  return existsSync(p) ? parseCsv(readFileSync(p, "utf8")) : [];
}
export function writeDeck(file: string, rows: Record<string, string>[]): void {
  writeFileSync(join(DECKS_DIR, file), toCsv(CSV_HEADER, rows));
}

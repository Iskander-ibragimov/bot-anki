import { describe, expect, it } from "vitest";
import { csvToSql, parseCsv } from "../../scripts/lib/csv";

describe("csv", () => {
  it("parses quoted fields with commas, quotes and newlines", () => {
    const rows = parseCsv('word,translation\n"it\'s up to you","решать тебе, «как хочешь»"\n"say ""hi""","сказать ""привет"""\n');
    expect(rows).toEqual([
      { word: "it's up to you", translation: "решать тебе, «как хочешь»" },
      { word: 'say "hi"', translation: 'сказать "привет"' },
    ]);
  });

  it("csvToSql escapes quotes and is idempotent", () => {
    const sql = csvToSql({ slug: "phrases", titleRu: "Разговорные фразы", titleEn: "Everyday phrases", level: null }, [
      { word: "it's up to you", ipa: "", pos: "phrase", translation: "решать тебе", example_en: "It's up to you.", example_ru: "Решать тебе.", audio_file_id: "" },
    ]);
    expect(sql).toContain("INSERT OR IGNORE INTO decks");
    expect(sql).toContain("'it''s up to you'");
    expect(sql).toContain("ON CONFLICT (deck_id, word_key) DO UPDATE");
    expect(sql).toContain("NULL");
  });
});

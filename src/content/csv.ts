/** RFC 4180 CSV parser (quotes, doubled quotes, commas and newlines inside quotes). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((x) => x !== "")) rows.push(row); }
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ""])));
}

export function toCsv(header: string[], rows: Record<string, string | null | undefined>[]): string {
  const cell = (v: string | null | undefined) => {
    const s = v ?? "";
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header.join(","), ...rows.map((r) => header.map((h) => cell(r[h])).join(","))].join("\n") + "\n";
}

const sq = (v: string | null | undefined) => (v == null || v === "" ? "NULL" : `'${v.replace(/'/g, "''")}'`);
const key = (w: string) => w.trim().toLowerCase().replace(/\s+/g, " ");

export interface DeckMeta { slug: string; titleRu: string; titleEn: string; level: string | null }

/** Idempotent seed SQL for one catalog deck (re-running updates text and audio, never duplicates). */
export function csvToSql(meta: DeckMeta, rows: Record<string, string>[]): string {
  const deck = `(SELECT id FROM decks WHERE slug = ${sq(meta.slug)})`;
  const out = [`INSERT OR IGNORE INTO decks (slug, kind, title_ru, title_en, level) VALUES (${sq(meta.slug)}, 'catalog', ${sq(meta.titleRu)}, ${sq(meta.titleEn)}, ${sq(meta.level)});`];
  for (const r of rows) {
    const w = r.word ?? "";
    if (!w.trim()) continue;
    out.push(
      `INSERT INTO notes (deck_id, word, word_key, ipa, pos, translation, example_en, example_ru, audio_file_id) VALUES (${deck}, ${sq(w.trim())}, ${sq(key(w))}, ${sq(r.ipa)}, ${sq(r.pos ?? "") === "NULL" ? "''" : sq(r.pos)}, ${sq(r.translation)}, ${sq(r.example_en) === "NULL" ? "''" : sq(r.example_en)}, ${sq(r.example_ru) === "NULL" ? "''" : sq(r.example_ru)}, ${sq(r.audio_file_id)})` +
        ` ON CONFLICT (deck_id, word_key) DO UPDATE SET translation = excluded.translation, ipa = excluded.ipa, example_en = excluded.example_en, example_ru = excluded.example_ru, audio_file_id = COALESCE(excluded.audio_file_id, notes.audio_file_id);`,
    );
  }
  out.push(`UPDATE decks SET total = (SELECT COUNT(*) FROM notes WHERE deck_id = ${deck}) WHERE slug = ${sq(meta.slug)};`);
  return out.join("\n") + "\n";
}

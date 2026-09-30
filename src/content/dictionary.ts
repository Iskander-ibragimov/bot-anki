export interface DictEntry { ipa: string | null; pos: string; exampleEn: string | null; audioUrl: string | null }

interface ApiEntry {
  phonetic?: string;
  phonetics?: { text?: string; audio?: string }[];
  meanings?: { partOfSpeech?: string; definitions?: { example?: string }[] }[];
}

/** Free Dictionary API (dictionaryapi.dev): transcription, part of speech, an example and audio. */
export class DictionaryClient {
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = 5000) {}

  async lookup(word: string): Promise<DictEntry | null> {
    try {
      const res = await this.fetcher(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.trim().toLowerCase())}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as ApiEntry[];
      const e = data[0];
      if (!e) return null;
      const phon = e.phonetics ?? [];
      const ipa = e.phonetic || phon.find((p) => p.text)?.text || null;
      const audioUrl = phon.find((p) => p.audio && /^https:\/\//.test(p.audio))?.audio ?? null;
      const pos = e.meanings?.[0]?.partOfSpeech ?? "";
      let exampleEn: string | null = null;
      for (const m of e.meanings ?? []) for (const d of m.definitions ?? []) if (!exampleEn && d.example) exampleEn = d.example;
      return { ipa, pos, exampleEn, audioUrl };
    } catch {
      return null;
    }
  }
}

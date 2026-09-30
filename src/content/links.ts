/** Minimal shape of a Telegram MessageEntity we care about (offsets are UTF-16, like JS strings). */
export interface Entity { type: string; offset: number; length: number; url?: string }
export interface WordLink { word: string; url: string | null }
export interface Parsed { items: WordLink[]; orphanUrl: string | null }

const MAX_ITEMS = 20;
const MAX_URL = 512;
const RAW_URL = /https?:\/\/[^\s<>"]+/gi;

export function cleanUrl(raw: string): string | null {
  const u = raw.trim().replace(/[.,;:!?)\]}»"']+$/, "");
  if (!/^https?:\/\/[^\s/]+/i.test(u) || u.length > MAX_URL) return null;
  return u;
}

/** Collapse spaces, drop dashes/colons and brackets left dangling by a removed link. */
function tidy(w: string): string {
  let s = w.replace(/\s+/g, " ").replace(/^[\s—–:-]+|[\s—–:-]+$/gu, "");
  const count = (c: string) => s.split(c).length - 1;
  while (s.endsWith("(") || (s.endsWith(")") && count(")") > count("("))) s = s.slice(0, -1).trimEnd();
  while (s.startsWith(")") || (s.startsWith("(") && count("(") > count(")"))) s = s.slice(1).trimStart();
  return s.replace(/^[\s—–:-]+|[\s—–:-]+$/gu, "");
}

interface Span { start: number; end: number; url: string | null; keepText: boolean }

/**
 * Splits a message into words and links:
 * a URL on the same line as a word belongs to that word; a URL on its own line
 * belongs to every word without its own; a message of only URLs yields orphanUrl.
 */
export function parseWordsAndLinks(text: string, entities: Entity[]): Parsed {
  const spans: Span[] = [];
  for (const e of entities) {
    if (e.type === "url") spans.push({ start: e.offset, end: e.offset + e.length, url: cleanUrl(text.slice(e.offset, e.offset + e.length)), keepText: false });
    else if (e.type === "text_link" && e.url) spans.push({ start: e.offset, end: e.offset + e.length, url: cleanUrl(e.url), keepText: true });
  }
  for (const m of text.matchAll(RAW_URL)) {
    const start = m.index!, end = start + m[0].length;
    if (!spans.some((s) => start < s.end && end > s.start)) spans.push({ start, end, url: cleanUrl(m[0]), keepText: false });
  }
  spans.sort((a, b) => a.start - b.start);

  const items: WordLink[] = [];
  const seen = new Set<string>();
  let shared: string | null = null;
  let lineStart = 0;
  for (const line of text.split("\n")) {
    const lineEnd = lineStart + line.length;
    const inLine = spans.filter((s) => s.start >= lineStart && s.start < lineEnd);
    let word = "";
    let cursor = lineStart;
    for (const s of inLine) {
      word += text.slice(cursor, s.start) + (s.keepText ? text.slice(s.start, s.end) : " ");
      cursor = Math.max(cursor, s.end);
    }
    word += text.slice(cursor, lineEnd);
    word = tidy(word);
    const url = inLine.find((s) => s.url)?.url ?? null;
    if (word) {
      const key = word.toLowerCase();
      if (!seen.has(key) && items.length < MAX_ITEMS) { seen.add(key); items.push({ word, url }); }
    } else if (url && !shared) shared = url;
    lineStart = lineEnd + 1;
  }
  for (const it of items) if (!it.url && shared) it.url = shared;
  return { items, orphanUrl: items.length ? null : shared };
}

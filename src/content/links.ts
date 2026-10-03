/** Minimal shape of a Telegram MessageEntity we care about (offsets are UTF-16, like JS strings). */
export interface Entity { type: string; offset: number; length: number; url?: string }

/**
 * What one message means for the "add a card" flow. A message holds at most one card:
 * a word or phrase in English, its Russian side, or both in any order.
 */
export type Entry =
  | { kind: "empty" }
  | { kind: "url-only"; url: string }
  | { kind: "pair"; en: string; ru: string; url: string | null }
  | { kind: "single"; side: Side; text: string; url: string | null }
  | { kind: "too-many" }
  | { kind: "unclear" };
export type Side = "en" | "ru";

const MAX_URL = 512;
const MAX_LEN: Record<Side, number> = { en: 100, ru: 300 };
const RAW_URL = /https?:\/\/[^\s<>"]+/gi;
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

export function cleanUrl(raw: string): string | null {
  let u = raw.trim();
  const n = (c: string) => u.split(c).length - 1;
  for (;;) {
    const last = u.slice(-1);
    if (/[.,;:!?\]}»"']/.test(last)) u = u.slice(0, -1);
    else if (last === ")" && n(")") > n("(")) u = u.slice(0, -1);
    else break;
  }
  if (!/^https?:\/\/[^\s/]+/i.test(u) || u.length > MAX_URL) return null;
  return u;
}

const EDGE = /^[\s—–:;,.!?…"'«»\-=]+|[\s—–:;,.!?…"'«»\-=]+$/gu;
/** Collapse spaces, drop punctuation and brackets left dangling by a removed link. */
function tidy(w: string): string {
  let s = w.replace(/\s+/g, " ").replace(/\(\s*\)|\[\s*\]/g, " ").replace(/\s+/g, " ").replace(EDGE, "");
  const n = (c: string) => s.split(c).length - 1;
  for (let guard = 0; guard < 10; guard++) {
    const before = s;
    if (s.endsWith("(") || (s.endsWith(")") && n(")") > n("("))) s = s.slice(0, -1);
    if (s.startsWith(")") || (s.startsWith("(") && n("(") > n(")"))) s = s.slice(1);
    s = s.replace(EDGE, "");
    if (s === before) break;
  }
  return s;
}

/** Language by alphabet: Russian when Cyrillic letters are at least as many as Latin ("IT-отдел" is Russian). */
function langOf(s: string): Side | null {
  const cyr = count(s, /[А-Яа-яЁё]/g);
  const lat = count(s, /[A-Za-z]/g);
  if (!cyr && !lat) return null;
  return cyr > 0 && cyr >= lat ? "ru" : "en";
}
const cut = (s: string, side: Side) => tidy(s).slice(0, MAX_LEN[side]).trim();

/** Splits one line into its English and Russian parts, in either order. */
function splitLine(line: string): { en: string; ru: string } | { side: Side } | "unclear" {
  const sep = line.match(/^(.+?)(?:\s*[—–]\s*|\s+-\s+|\s*=\s*)(.+)$/);
  if (sep) {
    const a = langOf(sep[1]!), b = langOf(sep[2]!);
    if (a && b && a !== b) return a === "en" ? { en: sep[1]!, ru: sep[2]! } : { en: sep[2]!, ru: sep[1]! };
  }
  // No usable separator: the line must be one run of English followed by one run of Russian, or the reverse.
  const tokens = line.split(/\s+/).filter(Boolean);
  const runs: { side: Side; words: string[] }[] = [];
  for (const tok of tokens) {
    const l = langOf(tok);
    const last = runs[runs.length - 1];
    if (!l) { if (last) last.words.push(tok); continue; } // digits and punctuation stay with what precedes them
    if (last && last.side === l) last.words.push(tok);
    else runs.push({ side: l, words: [tok] });
  }
  if (runs.length === 1) return { side: runs[0]!.side };
  if (runs.length !== 2) return "unclear";
  const en = runs.find((r) => r.side === "en")!.words.join(" ");
  const ru = runs.find((r) => r.side === "ru")!.words.join(" ");
  return { en, ru };
}

export function parseEntry(text: string, entities: Entity[]): Entry {
  // 1. Take links out of the text (a text_link keeps its visible words).
  const spans: { start: number; end: number; url: string | null; keepText: boolean }[] = [];
  for (const e of entities) {
    if (e.type === "url") spans.push({ start: e.offset, end: e.offset + e.length, url: cleanUrl(text.slice(e.offset, e.offset + e.length)), keepText: false });
    else if (e.type === "text_link" && e.url) spans.push({ start: e.offset, end: e.offset + e.length, url: cleanUrl(e.url), keepText: true });
  }
  for (const m of text.matchAll(RAW_URL)) {
    const start = m.index!, end = start + m[0].length;
    if (!spans.some((s) => start < s.end && end > s.start)) spans.push({ start, end, url: cleanUrl(m[0]), keepText: false });
  }
  spans.sort((a, b) => a.start - b.start);
  let stripped = "";
  let cursor = 0;
  for (const s of spans) {
    if (s.start < cursor) continue;
    stripped += text.slice(cursor, s.start) + (s.keepText ? text.slice(s.start, s.end) : " ");
    cursor = s.end;
  }
  stripped += text.slice(cursor);
  const url = spans.find((s) => s.url)?.url ?? null;

  // 2. One card per message: one line, or two lines holding one language each.
  const lines = stripped.split("\n").map(tidy).filter((l) => langOf(l));
  if (!lines.length) return url ? { kind: "url-only", url } : { kind: "empty" };
  if (lines.length > 2) return { kind: "too-many" };
  if (lines.length === 2) {
    const [a, b] = lines.map(splitLine);
    if (a === "unclear" || b === "unclear" || !a || !b || !("side" in a) || !("side" in b) || a.side === b.side) return { kind: "too-many" };
    const en = a.side === "en" ? lines[0]! : lines[1]!;
    const ru = a.side === "ru" ? lines[0]! : lines[1]!;
    return { kind: "pair", en: cut(en, "en"), ru: cut(ru, "ru"), url };
  }
  const one = splitLine(lines[0]!);
  if (one === "unclear") return { kind: "unclear" };
  if ("side" in one) return { kind: "single", side: one.side, text: cut(lines[0]!, one.side), url };
  return { kind: "pair", en: cut(one.en, "en"), ru: cut(one.ru, "ru"), url };
}

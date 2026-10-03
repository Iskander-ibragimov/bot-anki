import { parseEntry } from "./links";

const MAX_LINE = 200;
const MAX_WORDS = 8;
const MAX_PHRASE = 100;

/** What a vision model answered → the English line on the picture, or null when there is none. */
export function cleanOcr(raw: string): string | null {
  let s = raw.replace(/```[a-z]*\n?/gi, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^["'«“]+|["'»”]+$/g, "").trim();
  if (/^none\W*$/i.test(s)) return null;
  if (/[А-Яа-яЁё]/.test(s)) {
    // interface labels of a Russian player ("Сезон 2 Серия 3") are not part of the line
    s = s.split(" ").filter((tok) => !/[А-Яа-яЁё]/.test(tok)).join(" ").replace(/^[^A-Za-z]+/, "").trim();
  }
  if (!/[A-Za-z]{2}/.test(s)) return null;
  return s.length > MAX_LINE ? s.slice(0, MAX_LINE).replace(/\s+\S*$/, "") : s;
}

const STOP = new Set((
  "a an the and or but if so not no nor yes of to in on at by for from with without into onto over under about as than then that this these those " +
  "is am are was were be been being do does did done have has had having will would can could shall should may might must " +
  "i me my mine we us our ours you your yours he him his she her hers it its they them their theirs who whom whose which what when where why how " +
  "there here up down out off near while just very too also only ok okay oh uh um yeah hey well " +
  "i'm i've i'll i'd you're you've you'll you'd he's she's it's we're we've we'll they're they've they'll that's there's what's let's " +
  "don't doesn't didn't isn't aren't wasn't weren't won't wouldn't can't couldn't shouldn't haven't hasn't hadn't ain't"
).split(" "));

/** Buttons for a line read from a picture: its meaningful words, and the whole line when it can be a card. */
export function wordChoices(line: string): { words: string[]; phrase: string | null } {
  const words: string[] = [];
  const tokens = line.match(/[A-Za-z][A-Za-z'’-]*/g) ?? [];
  tokens.forEach((tok, i) => {
    const bare = tok.replace(/’/g, "'").replace(/^['-]+|['-]+$/g, "");
    const key = bare.toLowerCase();
    if (bare.length < 3 || bare.length > 30 || STOP.has(key)) return;
    // a name in the middle of the line keeps its capital; shouting and sentence starts do not
    const shown = i === 0 || bare === bare.toUpperCase() ? key : bare;
    if (words.length < MAX_WORDS && !words.some((w) => w.toLowerCase() === key)) words.push(shown);
  });
  const entry = parseEntry(line, []);
  const phrase = entry.kind === "single" && entry.side === "en" && line.trim().length <= MAX_PHRASE && entry.text.includes(" ") ? entry.text : null;
  return { words, phrase };
}

/** The line is a good example sentence for the word when it has more in it than the word itself. */
export function exampleFrom(line: string | null | undefined, word: string): string | null {
  if (!line) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, " ").trim();
  const l = norm(line), w = norm(word);
  return w && l !== w && ` ${l} `.includes(` ${w} `) ? line : null;
}

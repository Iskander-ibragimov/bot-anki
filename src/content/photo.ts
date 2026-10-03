import { parseEntry } from "./links";

const MAX_LINE = 200;
const MAX_WORDS = 8;
const MAX_PHRASE = 100;

const QUOTES = `"'«»“”`;
const REFUSAL = [
  /^none\W*$/i, /^none\s*\(/i,
  /^there (is|are) no (english |readable |visible )?(text|subtitles?|words)/i,
  /^no (english |readable |visible )?(text|subtitles?)\b/i,
  /^(i'?m|i am) sorry,? but/i, /^sorry,? (but )?i (can|could)/i,
  /^i (can'?t|cannot|am unable to|'m unable to|do not|don'?t) (help|read|see|assist|identify|determine|find)/i,
];

/** What a vision model answered → the English line on the picture, or null when there is none. */
export function cleanOcr(raw: string): string | null {
  // reasoning models think aloud first; an unfinished thought means there is no answer
  const answer = raw.replace(/<think>[\s\S]*?<\/think>/gi, " ").replace(/<think>[\s\S]*$/i, " ");
  let s = answer.replace(/’/g, "'").trim().split(/\n\s*\n/)[0]!; // a model's remarks come after a blank line
  s = s.replace(/```[a-z]*\n?/gi, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^[*_`]+|[*_`]+$/g, "").trim();
  if (REFUSAL.some((re) => re.test(s))) return null;
  // "The subtitle reads: "..." Other text: ..." → the quoted line itself
  const intro = s.match(/^(?:the )?(?:subtitle|caption|text|line)\b[^:"“«]{0,40}(?::\s*|\s(?=["“«]))(.+)$/i);
  if (intro) {
    s = intro[1]!.trim();
    const quoted = s.match(/^["“«](.+?)["”»](?:\s|$)/);
    s = quoted ? quoted[1]!.trim() : s.replace(/^["“«]+/, "").trim();
  } else {
    const inner = s.slice(1, -1);
    if (s.length > 2 && QUOTES.includes(s[0]!) && QUOTES.includes(s.at(-1)!) && ![...inner].some((ch) => `"“”«»`.includes(ch))) s = inner.trim();
  }
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
  "who's here's where's how's when's why's he'd she'd we'd they'd it'd that'll there'll it'll " +
  "don't doesn't didn't isn't aren't wasn't weren't won't wouldn't can't couldn't shouldn't haven't hasn't hadn't ain't"
).split(" "));

/** Buttons for a line read from a picture: its meaningful words, and the whole line when it can be a card. */
export function wordChoices(line: string): { words: string[]; phrase: string | null } {
  const words: string[] = [];
  const text = line.replace(/’/g, "'").replace(/--+|—|–/g, " ");
  const shouting = !/[a-z]/.test(text); // subtitles in capitals
  for (const m of text.matchAll(/[A-Za-z][A-Za-z'-]*/g)) {
    const bare = m[0].replace(/^['-]+|['-]+$/g, "");
    const key = bare.toLowerCase();
    if (bare.length < 3 || bare.length > 30 || STOP.has(key)) continue;
    const upper = bare === bare.toUpperCase();
    const startsSentence = m.index === 0 || /[.!?…]["')\s]*$/.test(text.slice(0, m.index));
    // names and short abbreviations keep their capitals; sentence starts and shouted words do not
    const shown = shouting || (upper ? bare.length > 5 : startsSentence) ? key : bare;
    if (words.length < MAX_WORDS && !words.some((w) => w.toLowerCase() === key)) words.push(shown);
  }
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

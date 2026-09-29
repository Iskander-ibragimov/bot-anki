import { type Card, type FSRS, type Grade, State, createEmptyCard, fsrs, generatorParameters } from "ts-fsrs";

export type CardState = "new" | "learning" | "review" | "relearning";
export type Rating = 1 | 2 | 3 | 4;
export type Lang = "ru" | "en";
export type Stage = "new" | "learning" | "known" | "learned";

/** Memory state of one card, stored in D1 as plain numbers (ms epoch). */
export interface Mem {
  state: CardState;
  step: number | null;
  stability: number | null;
  difficulty: number | null;
  due: number;
  lastReview: number | null;
  scheduledDays: number;
  reps: number;
  lapses: number;
}

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;

const STATES: CardState[] = ["new", "learning", "review", "relearning"];
const TO_FSRS: Record<CardState, State> = { new: State.New, learning: State.Learning, review: State.Review, relearning: State.Relearning };

const cache = new Map<string, FSRS>();
function scheduler(retention: number, fuzz: boolean): FSRS {
  const key = `${retention}:${fuzz}`;
  let f = cache.get(key);
  if (!f) {
    f = fsrs(
      generatorParameters({
        request_retention: retention,
        maximum_interval: 36500,
        enable_fuzz: fuzz,
        enable_short_term: true,
        learning_steps: ["1m", "10m"],
        relearning_steps: ["10m"],
      }),
    );
    cache.set(key, f);
  }
  return f;
}

function toCard(m: Mem): Card {
  const base = createEmptyCard(new Date(m.due));
  return {
    ...base,
    due: new Date(m.due),
    stability: m.stability ?? 0,
    difficulty: m.difficulty ?? 0,
    scheduled_days: m.scheduledDays,
    learning_steps: m.step ?? 0,
    reps: m.reps,
    lapses: m.lapses,
    state: TO_FSRS[m.state],
    last_review: m.lastReview == null ? undefined : new Date(m.lastReview),
  };
}

function fromCard(c: Card): Mem {
  const state = STATES[c.state] ?? "new";
  return {
    state,
    step: state === "learning" || state === "relearning" ? c.learning_steps : null,
    stability: c.stability,
    difficulty: c.difficulty,
    due: c.due.getTime(),
    lastReview: c.last_review ? c.last_review.getTime() : null,
    scheduledDays: c.scheduled_days,
    reps: c.reps,
    lapses: c.lapses,
  };
}

export function newMem(now: number): Mem {
  return { state: "new", step: null, stability: null, difficulty: null, due: now, lastReview: null, scheduledDays: 0, reps: 0, lapses: 0 };
}

export function grade(m: Mem, rating: Rating, now: number, retention: number): Mem {
  return fromCard(scheduler(retention, true).next(toCard(m), new Date(now), rating as Grade).card);
}

/** Due time for each of the 4 ratings, without fuzz so button labels are stable. */
export function preview(m: Mem, now: number, retention: number): Record<Rating, number> {
  const p = scheduler(retention, false).repeat(toCard(m), new Date(now));
  const due = (g: Rating) => p[g as Grade].card.due.getTime();
  return { 1: due(1), 2: due(2), 3: due(3), 4: due(4) };
}

export function formatInterval(ms: number, lang: Lang): string {
  const ru = lang === "ru";
  if (ms < MIN) return ru ? "<1м" : "<1m";
  const m = Math.round(ms / MIN);
  if (m < 60) return `<${m}${ru ? "м" : "m"}`;
  if (ms < DAY) return `${Math.round(ms / H)}${ru ? "ч" : "h"}`;
  const d = Math.round(ms / DAY);
  if (d < 30) return `${d}${ru ? "д" : "d"}`;
  const dec = (x: number) => (Math.round(x * 10) / 10).toString().replace(".", ru ? "," : ".");
  if (d < 365) return `${dec(d / 30)}${ru ? "мес" : "mo"}`;
  return `${dec(d / 365)}${ru ? "г" : "y"}`;
}

export function stage(m: Mem): Stage {
  if (m.state === "new") return "new";
  if (m.state !== "review") return "learning";
  if (m.scheduledDays >= 21) return "learned";
  if (m.scheduledDays >= 7) return "known";
  return "learning";
}

/** How many days the word is currently held in memory. */
export function memoryDays(m: Mem): number {
  if (m.state === "review") return m.scheduledDays;
  if (m.state === "relearning") return Math.max(1, Math.round(m.stability ?? 0));
  return 0;
}

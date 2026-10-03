import type { DirectionSetting, Lang, Repo, User } from "../db/repo";
import { PLACEMENT_WORDS, placementLevel } from "./placement";

const MIN = 60_000;
const DAY = 86_400_000;
const DAY_START_MIN = 4 * 60;

/** Local calendar day with the Anki-style 04:00 boundary, as YYYY-MM-DD. */
export function localDay(offsetMin: number, now: number): string {
  return new Date(now + (offsetMin - DAY_START_MIN) * MIN).toISOString().slice(0, 10);
}

/** Minutes since local midnight. */
export function localMinutes(offsetMin: number, now: number): number {
  const d = new Date(now + offsetMin * MIN);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Next UTC moment (strictly after `after`) when the user's local clock shows hh:mm. */
export function nextOccurrence(offsetMin: number, hhmm: string, after: number): number {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const localMidnight = Math.floor((after + offsetMin * MIN) / DAY) * DAY - offsetMin * MIN;
  let t = localMidnight + (h * 60 + m) * MIN;
  if (t <= after) t += DAY;
  return t;
}

export const EVENING_AT = "20:00";

export interface Window { dayStartMs: number; dayEndMs: number; today: string }

export function dayWindow(offsetMin: number, now: number): Window {
  const shifted = now + (offsetMin - DAY_START_MIN) * MIN;
  const dayStartMs = Math.floor(shifted / DAY) * DAY - (offsetMin - DAY_START_MIN) * MIN;
  return { dayStartMs, dayEndMs: dayStartMs + DAY, today: localDay(offsetMin, now) };
}


const RU_LANGS = new Set(["ru", "uk", "be", "kk"]);
export function langFromTelegram(code?: string): Lang {
  return code && RU_LANGS.has(code.slice(0, 2).toLowerCase()) ? "ru" : "en";
}

/** UTC offset in minutes from the local time the user reports; handles the midnight wrap. */
export function offsetFromReported(h: number, m: number, now: number): number {
  const utc = new Date(now);
  let diff = h * 60 + m - (utc.getUTCHours() * 60 + utc.getUTCMinutes());
  while (diff <= -720) diff += 1440;
  while (diff > 840) diff -= 1440;
  return Math.round(diff / 30) * 30;
}

export async function getOrCreate(repo: Repo, tgId: number, chatId: number, tgLang: string | undefined, now: number): Promise<{ user: User; created: boolean }> {
  const existing = await repo.getUserByTg(tgId);
  if (existing) return { user: existing, created: false };
  await repo.insertUser({ tgId, chatId, lang: langFromTelegram(tgLang), now });
  return { user: (await repo.getUserByTg(tgId))!, created: true };
}

export type SettingKey = "lang" | "retention" | "newPerDay" | "remindAt" | "direction" | "autoplay" | "newOrder";
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const RETENTIONS = [0.85, 0.9, 0.95] as const;
export const NEW_PER_DAY = [5, 10, 20] as const;
export const REMIND_TIMES = ["08:00", "09:00", "12:00", "19:00", "21:00"] as const;

export async function setSetting(repo: Repo, userId: number, key: SettingKey, value: unknown, now = Date.now()): Promise<void> {
  const bad = () => { throw new Error(`invalid ${key}: ${String(value)}`); };
  switch (key) {
    case "lang": if (value !== "ru" && value !== "en") bad(); break;
    case "retention": if (!RETENTIONS.includes(value as never)) bad(); break;
    case "newPerDay": if (!NEW_PER_DAY.includes(value as never)) bad(); break;
    case "remindAt": if (typeof value !== "string" || !HHMM.test(value)) bad(); break;
    case "direction": if (!["en_ru", "ru_en", "both"].includes(value as string)) bad(); break;
    case "autoplay": if (typeof value !== "boolean") bad(); break;
    case "newOrder": if (value !== "deck" && value !== "random") bad(); break;
  }
  const patch = { [key]: value } as Partial<User>;
  if (key === "remindAt") {
    const u = await repo.getUser(userId);
    if (u) patch.nextDailyAt = nextOccurrence(u.tzOffsetMin, value as string, now);
  }
  await repo.updateUser(userId, patch);
}

export type OnboardingScreen =
  | { kind: "lang" }
  | { kind: "placement"; index: number; word: string }
  | { kind: "goal"; level: string; known: number }
  | { kind: "remind" }
  | { kind: "tz"; options: { label: string; offset: number }[] }
  | { kind: "deck"; slug: string }
  | { kind: "deckList" }
  | { kind: "finished"; remindAt: string; tzOffsetMin: number; deckSlug: string }
  | { kind: "invalid"; step: string };

const TZ_CHOICES = [120, 180, 240, 300, 420, 600];
function tzOptions(now: number) {
  return TZ_CHOICES.map((offset) => {
    const d = new Date(now + offset * 60_000);
    return { offset, label: `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}` };
  });
}

/** Re-renders the current onboarding step (used on /start while onboarding). */
export function startOnboarding(user: User, now = Date.now()): OnboardingScreen {
  const data = user.onboardingData ? (JSON.parse(user.onboardingData) as { i: number; known: number }) : { i: 0, known: 0 };
  switch (user.onboardingStep) {
    case "placement": return { kind: "placement", index: data.i, word: PLACEMENT_WORDS[data.i] ?? PLACEMENT_WORDS[0] };
    case "goal": return { kind: "goal", level: user.level ?? "A1", known: data.known };
    case "remind": return { kind: "remind" };
    case "tz": return { kind: "tz", options: tzOptions(now) };
    case "deck": return { kind: "deck", slug: (user.level ?? "A1").toLowerCase() };
    default: return { kind: "lang" };
  }
}

/** Applies one answer and returns the next screen. Invalid answers keep the step. */
export async function advanceOnboarding(repo: Repo, user: User, answer: string, now: number): Promise<OnboardingScreen> {
  const step = user.onboardingStep;
  const invalid = { kind: "invalid", step: step ?? "" } as const;
  if (step === "lang") {
    if (answer !== "ru" && answer !== "en") return invalid;
    await repo.updateUser(user.id, { lang: answer, onboardingStep: "placement", onboardingData: JSON.stringify({ i: 0, known: 0 }) });
    return { kind: "placement", index: 0, word: PLACEMENT_WORDS[0] };
  }
  if (step === "placement") {
    if (answer !== "0" && answer !== "1") return invalid;
    const d = user.onboardingData ? (JSON.parse(user.onboardingData) as { i: number; known: number }) : { i: 0, known: 0 };
    const next = { i: d.i + 1, known: d.known + Number(answer) };
    if (next.i < PLACEMENT_WORDS.length) {
      await repo.updateUser(user.id, { onboardingData: JSON.stringify(next) });
      return { kind: "placement", index: next.i, word: PLACEMENT_WORDS[next.i]! };
    }
    const level = placementLevel(next.known);
    await repo.updateUser(user.id, { level, onboardingStep: "goal", onboardingData: JSON.stringify(next) });
    return { kind: "goal", level, known: next.known };
  }
  if (step === "goal") {
    const n = Number(answer);
    if (!NEW_PER_DAY.includes(n as never)) return invalid;
    await repo.updateUser(user.id, { newPerDay: n, onboardingStep: "remind" });
    return { kind: "remind" };
  }
  if (step === "remind") {
    if (!HHMM.test(answer)) return invalid;
    await repo.updateUser(user.id, { remindAt: answer, onboardingStep: "tz" });
    return { kind: "tz", options: tzOptions(now) };
  }
  if (step === "tz") {
    let offset: number | null = null;
    const typed = answer.trim().match(/^(\d{1,2})[:.](\d{2})$/);
    if (typed) {
      const h = Number(typed[1]), m = Number(typed[2]);
      if (h < 24 && m < 60) offset = offsetFromReported(h, m, now);
    } else if (/^-?\d+$/.test(answer) && TZ_CHOICES.includes(Number(answer))) offset = Number(answer);
    if (offset == null) return invalid;
    await repo.updateUser(user.id, { tzOffsetMin: offset, onboardingStep: "deck" });
    return { kind: "deck", slug: (user.level ?? "A1").toLowerCase() };
  }
  if (step === "deck") {
    if (answer === "other") return { kind: "deckList" };
    const deck = await repo.getDeckBySlug(answer);
    if (!deck) return invalid;
    await repo.subscribe(user.id, deck.id, now);
    await repo.updateUser(user.id, {
      onboardingStep: null, onboardingData: null,
      nextDailyAt: nextOccurrence(user.tzOffsetMin, user.remindAt, now), nextEveningAt: nextOccurrence(user.tzOffsetMin, EVENING_AT, now),
    });
    return { kind: "finished", remindAt: user.remindAt, tzOffsetMin: user.tzOffsetMin, deckSlug: answer };
  }
  return invalid;
}

export type { DirectionSetting };

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

export interface Window { dayStartMs: number; dayEndMs: number; today: string }

export function dayWindow(offsetMin: number, now: number): Window {
  const shifted = now + (offsetMin - DAY_START_MIN) * MIN;
  const dayStartMs = Math.floor(shifted / DAY) * DAY - (offsetMin - DAY_START_MIN) * MIN;
  return { dayStartMs, dayEndMs: dayStartMs + DAY, today: localDay(offsetMin, now) };
}

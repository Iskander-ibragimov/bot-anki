import type { Repo, User } from "../db/repo";
import { localDay } from "../users/service";

export type Feature = "gen";
export const DAILY_LIMITS: Record<Feature, number> = { gen: 3 };

/** Uses one unit of a daily-limited feature; false when today's limit is reached. */
export async function consume(repo: Repo, user: User, feature: Feature, now: number): Promise<boolean> {
  const today = localDay(user.tzOffsetMin, now);
  const used = user.gensDay === today ? user.gensCount : 0;
  if (used >= DAILY_LIMITS[feature]) return false;
  await repo.updateUser(user.id, { gensDay: today, gensCount: used + 1 });
  return true;
}

export async function remaining(user: User, feature: Feature, now: number): Promise<number> {
  const used = user.gensDay === localDay(user.tzOffsetMin, now) ? user.gensCount : 0;
  return Math.max(0, DAILY_LIMITS[feature] - used);
}

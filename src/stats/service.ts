import type { Repo, User } from "../db/repo";
import { displayDirection } from "../review/service";
import { dayWindow } from "../users/service";

export interface Cumulative {
  streak: number; learned: number; known: number; learning: number; fresh: number;
  memory: number; total: number; r30: number; retention30: number | null; forecast7: number[];
}

/** All-time progress: stages, total "memory days", reviews, 30-day retention and a 7-day forecast. */
export async function cumulative(repo: Repo, user: User, now: number): Promise<Cumulative> {
  const w = dayWindow(user.tzOffsetMin, now);
  const dir = displayDirection(user);
  const [s, x] = await Promise.all([repo.summary(user.id, w.dayStartMs, dir), repo.statsExtra(user.id, now, w.dayStartMs, dir)]);
  const forecast7 = Array.from({ length: 7 }, (_, d) => x.forecast.filter((f) => f.d === d).reduce((a, f) => a + f.n, 0));
  const alive = user.lastStudyDay === w.today || user.lastStudyDay === dayWindow(user.tzOffsetMin, now - 86_400_000).today;
  return {
    streak: alive ? user.streak : 0, learned: s.learned, known: s.known, learning: s.learning, fresh: s.new,
    memory: x.memory, total: x.total, r30: x.r30, retention30: x.rev30 ? x.ok30 / x.rev30 : null, forecast7,
  };
}

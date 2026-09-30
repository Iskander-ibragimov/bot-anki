export interface Job<P = Record<string, unknown>> { id: number; kind: string; payload: P; runAt: number; attempts: number }

const LOCK_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;

/** Returns the job id, or null when a pending job with the same dedup key exists. */
export async function enqueue(db: D1Database, kind: string, payload: unknown, runAt: number, dedupKey?: string): Promise<number | null> {
  const r = await db.prepare(
    `INSERT INTO jobs (kind, payload, run_at, dedup_key) VALUES (?, ?, ?, ?)
     ON CONFLICT (dedup_key) WHERE done_at IS NULL AND dedup_key IS NOT NULL DO NOTHING RETURNING id`,
  ).bind(kind, JSON.stringify(payload), runAt, dedupKey ?? null).first<{ id: number }>();
  return r?.id ?? null;
}

/** Atomically locks up to `limit` due jobs (stale locks older than 5 min are reclaimed). */
export async function claim(db: D1Database, now: number, limit: number): Promise<Job[]> {
  const { results } = await db.prepare(
    `UPDATE jobs SET locked_at = ?1 WHERE id IN (
       SELECT id FROM jobs WHERE done_at IS NULL AND run_at <= ?1 AND (locked_at IS NULL OR locked_at < ?2)
       ORDER BY run_at, id LIMIT ?3)
     RETURNING id, kind, payload, run_at, attempts`,
  ).bind(now, now - LOCK_TTL_MS, limit).all<{ id: number; kind: string; payload: string; run_at: number; attempts: number }>();
  return results
    .map((r) => ({ id: r.id, kind: r.kind, payload: JSON.parse(r.payload) as Record<string, unknown>, runAt: r.run_at, attempts: r.attempts }))
    .sort((a, b) => a.runAt - b.runAt || a.id - b.id);
}

export async function complete(db: D1Database, id: number, now: number): Promise<void> {
  await db.prepare("UPDATE jobs SET done_at = ?, locked_at = NULL WHERE id = ?").bind(now, id).run();
}

/** Retry at now + 30s·2^attempts; after 3 attempts the job is closed with its error kept. */
export async function fail(db: D1Database, id: number, error: string, now: number): Promise<void> {
  await db.prepare(
    `UPDATE jobs SET attempts = attempts + 1, error = ?1, locked_at = NULL,
       run_at = ?2 + 30000 * (1 << (attempts + 1)),
       done_at = CASE WHEN attempts + 1 >= ?3 THEN ?2 ELSE NULL END
     WHERE id = ?4`,
  ).bind(error.slice(0, 500), now, MAX_ATTEMPTS, id).run();
}

/** Re-run later without counting as a failure (e.g. Telegram 429). */
export async function reschedule(db: D1Database, id: number, runAt: number): Promise<void> {
  await db.prepare("UPDATE jobs SET run_at = ?, locked_at = NULL WHERE id = ?").bind(runAt, id).run();
}

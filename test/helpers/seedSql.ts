/** Applies a seed SQL file (one statement per line) the way `wrangler d1 execute --file` does. */
export async function applySeed(db: D1Database, sql: string): Promise<void> {
  const stmts = sql.split("\n").filter((l) => l.trim() && !l.startsWith("--")).map((l) => db.prepare(l));
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
}

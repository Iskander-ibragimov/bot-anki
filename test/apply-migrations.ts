import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const TABLES = ["review_log", "cards", "user_decks", "notes", "decks", "sessions", "previews", "jobs", "usage_daily", "users"];
beforeEach(async () => {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

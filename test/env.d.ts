declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    BOT_TOKEN: string;
    WEBHOOK_SECRET: string;
    ADMIN_TG_ID: string;
    LLM_PROVIDERS: string;
    TEST_MIGRATIONS: import("@cloudflare/vitest-pool-workers").D1Migration[];
  }
}

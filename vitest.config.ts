import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            BOT_TOKEN: "123:test",
            WEBHOOK_SECRET: "test-secret",
            ADMIN_TG_ID: "999",
            LLM_PROVIDERS: "[]",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      coverage: { provider: "istanbul" as const, include: ["src/**"] },
    },
  };
});

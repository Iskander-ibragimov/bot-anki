import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/env";

const base = { BOT_TOKEN: "t", WEBHOOK_SECRET: "s", ADMIN_TG_ID: "42" } as const;

describe("parseEnv", () => {
  it("parses LLM_PROVIDERS json", () => {
    const cfg = parseEnv({
      ...base,
      DB: {} as D1Database,
      LLM_PROVIDERS: '[{"baseUrl":"https://api.groq.com/openai/v1","apiKey":"k","model":"m"}]',
    });
    expect(cfg.llmProviders[0]?.model).toBe("m");
    expect(cfg.adminTgId).toBe(42);
  });

  it("throws on invalid LLM_PROVIDERS json", () => {
    expect(() => parseEnv({ ...base, DB: {} as D1Database, LLM_PROVIDERS: "not json" })).toThrow();
  });
});

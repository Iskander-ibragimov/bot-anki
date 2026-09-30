import { z } from "zod";

export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ADMIN_TG_ID: string;
  LLM_PROVIDERS: string;
}

import { ProviderSchema as Provider, type LlmProvider } from "./content/llm";
export type { LlmProvider };

export interface Config {
  botToken: string;
  webhookSecret: string;
  adminTgId: number;
  llmProviders: LlmProvider[];
}

export function parseEnv(env: Env): Config {
  const providers = z.array(Provider).parse(JSON.parse(env.LLM_PROVIDERS || "[]"));
  const adminTgId = Number(env.ADMIN_TG_ID);
  if (!Number.isInteger(adminTgId)) throw new Error("ADMIN_TG_ID must be an integer");
  return { botToken: env.BOT_TOKEN, webhookSecret: env.WEBHOOK_SECRET, adminTgId, llmProviders: providers };
}

/** Minimal Bot API surface used outside grammY (cron, jobs). grammY's ctx.api satisfies the same shape via adapters. */
export interface TgApi {
  call<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T>;
}

export class TgError extends Error {
  constructor(readonly code: number, description: string, readonly retryAfter?: number) { super(description); }
}

export interface TgMessage { message_id: number; voice?: { file_id: string }; audio?: { file_id: string } }

/**
 * The default fetcher is a wrapper, not `fetch` itself: on Workers, calling fetch as a method of another object
 * (this.fetcher(...)) throws "Illegal invocation".
 */
export class TgClient implements TgApi {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  async call<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T> {
    const res = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { ok: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
    if (!body.ok) throw new TgError(body.error_code ?? res.status, body.description ?? "Telegram error", body.parameters?.retry_after);
    return body.result as T;
  }
}

/** Normalises errors thrown by TgClient, grammY (GrammyError) or test fakes. */
export function tgErrorInfo(e: unknown): { code: number; description: string; retryAfter?: number } | null {
  if (!e || typeof e !== "object") return null;
  const o = e as { code?: number; error_code?: number; description?: string; message?: string; retryAfter?: number; parameters?: { retry_after?: number } };
  const code = o.code ?? o.error_code;
  if (typeof code !== "number") return null;
  return { code, description: o.description ?? o.message ?? "", retryAfter: o.retryAfter ?? o.parameters?.retry_after };
}

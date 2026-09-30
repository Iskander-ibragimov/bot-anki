export interface TgCall { method: string; payload: Record<string, unknown> }

/** Fake Bot API: records calls and returns plausible results. */
export function fakeTelegram() {
  const calls: TgCall[] = [];
  let nextMessageId = 100;
  const failures = new Map<string, { status: number; description: string; retry_after?: number }>();
  async function callImpl(method: string, payload: Record<string, unknown>): Promise<unknown> {
    calls.push({ method, payload });
    const f = failures.get(method);
    if (f) {
      failures.delete(method);
      const err = new Error(f.description) as Error & { error_code: number; parameters?: { retry_after?: number } };
      err.error_code = f.status;
      if (f.retry_after) err.parameters = { retry_after: f.retry_after };
      throw err;
    }
    if (method.startsWith("send")) {
      const id = nextMessageId++;
      const res: Record<string, unknown> = { message_id: id, date: 0, chat: { id: payload.chat_id, type: "private" } };
      if (method === "sendVoice") res.voice = { file_id: `voice-${id}`, file_unique_id: `u${id}`, duration: 1 };
      return res;
    }
    return true;
  }
  return {
    calls,
    call: callImpl as <T = unknown>(method: string, payload: Record<string, unknown>) => Promise<T>,
    failNext(method: string, status: number, description: string, retry_after?: number) {
      failures.set(method, { status, description, retry_after });
    },
    of(method: string) { return calls.filter((c) => c.method === method); },
  };
}
export type FakeTelegram = ReturnType<typeof fakeTelegram>;

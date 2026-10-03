import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo } from "../../src/db/repo";
import { enqueue } from "../../src/jobs/queue";
import { tick } from "../../src/reminders/service";
import { newMem } from "../../src/srs/fsrs";
import { countingDb } from "../helpers/countingDb";
import { fakeTelegram } from "../helpers/fakeTelegram";
import { seedUser } from "../helpers/seed";

const MIN = 60_000;
const local = (d: number, h: number, m: number) => Date.UTC(2026, 8, d, h, m) - 180 * MIN; // +03:00
const run = (db: D1Database, tg: ReturnType<typeof fakeTelegram>, now: number) => tick({ repo: new Repo(db), tg, adminChatId: 999, now });

describe("reminders tick", () => {
  it("missed tick still sends exactly one daily push", async () => {
    await seedUser(env.DB, { now: local(30, 8, 0), words: 3, patch: { remindAt: "09:00" } });
    const tg = fakeTelegram();
    await run(env.DB, tg, local(30, 8, 58));
    expect(tg.of("sendMessage")).toHaveLength(0);
    await run(env.DB, tg, local(30, 9, 1));
    await run(env.DB, tg, local(30, 9, 2));
    const sent = tg.of("sendMessage");
    expect(sent).toHaveLength(1);
    expect(String(sent[0]!.payload.text)).toContain("3");
    expect(JSON.stringify(sent[0]!.payload.reply_markup)).toContain('"learn"');
  });

  it("next day sends again", async () => {
    await seedUser(env.DB, { now: local(30, 8, 0), words: 3 });
    const tg = fakeTelegram();
    await run(env.DB, tg, local(30, 9, 5));
    await run(env.DB, tg, local(30, 9, 5) + 86_400_000);
    expect(tg.of("sendMessage")).toHaveLength(2);
  });

  it("no push when nothing is due", async () => {
    await seedUser(env.DB, { now: local(30, 8, 0), words: 3, patch: { newPerDay: 5 } });
    await env.DB.prepare("DELETE FROM user_decks").run();
    const tg = fakeTelegram();
    await run(env.DB, tg, local(30, 9, 5));
    expect(tg.of("sendMessage")).toHaveLength(0);
  });

  it("evening push only with a streak of 2+ and no study today", async () => {
    const future = local(30, 9, 0) + 10 * 86_400_000;
    await seedUser(env.DB, { now: local(30, 8, 0), words: 1, tgId: 1, patch: { streak: 1, lastStudyDay: "2026-09-29", nextDailyAt: future } });
    await seedUser(env.DB, { now: local(30, 8, 0), words: 1, tgId: 2, patch: { streak: 3, lastStudyDay: "2026-09-29", nextDailyAt: future } });
    await seedUser(env.DB, { now: local(30, 8, 0), words: 1, tgId: 3, patch: { streak: 3, lastStudyDay: "2026-09-30", nextDailyAt: future } });
    const tg = fakeTelegram();
    await run(env.DB, tg, local(30, 19, 59));
    expect(tg.of("sendMessage")).toHaveLength(0);
    await run(env.DB, tg, local(30, 20, 5));
    await run(env.DB, tg, local(30, 20, 6));
    const sent = tg.of("sendMessage");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.chat_id).toBe(2);
  });

  it("step ping once and never in quiet hours", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: local(30, 8, 0), words: 1, patch: { nextDailyAt: local(30, 9, 0) + 10 * 86_400_000 } });
    const t0 = local(30, 12, 0);
    await repo.insertCard(user.id, noteIds[0]!, "en_ru", { ...newMem(t0), state: "learning", step: 1, due: t0 + 10 * MIN, reps: 1, lastReview: t0, stability: 2, difficulty: 5 });
    await repo.updateUser(user.id, { lastReviewAt: t0 });
    const tg = fakeTelegram();
    await run(env.DB, tg, t0 + 5 * MIN);
    expect(tg.of("sendMessage")).toHaveLength(0);
    await run(env.DB, tg, t0 + 11 * MIN);
    await run(env.DB, tg, t0 + 12 * MIN);
    expect(tg.of("sendMessage")).toHaveLength(1);

    const n = local(30, 23, 30);
    await repo.updateUser(user.id, { lastReviewAt: n - 20 * MIN, lastStepPingAt: null });
    const tg2 = fakeTelegram();
    await run(env.DB, tg2, n);
    expect(tg2.of("sendMessage")).toHaveLength(0);
  });

  it("caps sends at 35 per tick, rest next tick", async () => {
    for (let i = 0; i < 40; i++) await seedUser(env.DB, { now: local(30, 8, 0), words: 1, tgId: 1000 + i });
    const tg = fakeTelegram();
    await run(env.DB, tg, local(30, 9, 1));
    expect(tg.of("sendMessage")).toHaveLength(35);
    await run(env.DB, tg, local(30, 9, 2));
    expect(tg.of("sendMessage")).toHaveLength(40);
  });

  it("403 deactivates the user", async () => {
    const { repo, user } = await seedUser(env.DB, { now: local(30, 8, 0), words: 1 });
    const tg = fakeTelegram();
    tg.failNext("sendMessage", 403, "Forbidden: bot was blocked by the user");
    await run(env.DB, tg, local(30, 9, 1));
    expect((await repo.getUser(user.id))!.active).toBe(false);
  });

  it("429 reschedules as a job and the job is delivered later", async () => {
    await seedUser(env.DB, { now: local(30, 8, 0), words: 1 });
    const tg = fakeTelegram();
    tg.failNext("sendMessage", 429, "Too Many Requests", 30);
    await run(env.DB, tg, local(30, 9, 1));
    const job = await env.DB.prepare("SELECT kind, run_at FROM jobs").first<{ kind: string; run_at: number }>();
    expect(job).toMatchObject({ kind: "push", run_at: local(30, 9, 1) + 30_000 });
    await run(env.DB, tg, local(30, 9, 2));
    expect(tg.of("sendMessage")).toHaveLength(2);
    expect((await env.DB.prepare("SELECT done_at FROM jobs").first<{ done_at: number | null }>())!.done_at).not.toBeNull();
  });

  it("voice jobs run in the tick", async () => {
    const { noteIds } = await seedUser(env.DB, { now: local(30, 8, 0), words: 1, patch: { nextDailyAt: local(30, 9, 0) + 10 * 86_400_000 } });
    await env.DB.prepare("UPDATE notes SET audio_url = ? WHERE id = ?").bind("https://d.dev/a.mp3", noteIds[0]!).run(); // as saved with the card
    await enqueue(env.DB, "voice", { noteId: noteIds[0], audioUrl: "https://d.dev/a.mp3" }, local(30, 9, 0));
    const tg = fakeTelegram();
    await run(env.DB, tg, local(30, 9, 1));
    expect(tg.of("sendVoice")).toHaveLength(1);
  });

  it("tick uses at most 10 D1 calls", async () => {
    for (let i = 0; i < 5; i++) await seedUser(env.DB, { now: local(30, 8, 0), words: 1, tgId: 2000 + i });
    await enqueue(env.DB, "push", { chat_id: 1, text: "x" }, local(30, 9, 0));
    const db = countingDb(env.DB);
    await run(db, fakeTelegram(), local(30, 9, 1));
    expect(db.calls).toBeLessThanOrEqual(10);
  });

  it("a failed send is not retried every minute", async () => {
    await seedUser(env.DB, { now: local(30, 8, 0), words: 1 });
    const tg = fakeTelegram();
    tg.failNext("sendMessage", 400, "Bad Request: chat not found");
    await run(env.DB, tg, local(30, 9, 1));
    await run(env.DB, tg, local(30, 9, 2));
    expect(tg.of("sendMessage")).toHaveLength(1);
  });

  it("users are marked before sending, so a crashed send never repeats", async () => {
    await seedUser(env.DB, { now: local(30, 8, 0), words: 1 });
    const crashing = { call: async () => { throw new Error("network reset"); } };
    await tick({ repo: new Repo(env.DB), tg: crashing, adminChatId: 999, now: local(30, 9, 1) }).catch(() => undefined);
    const tg = fakeTelegram();
    await run(env.DB, tg, local(30, 9, 2));
    expect(tg.of("sendMessage")).toHaveLength(0);
  });

  it("the tick reads only due users (indexed next_daily_at)", async () => {
    for (let i = 0; i < 30; i++) await seedUser(env.DB, { now: local(30, 8, 0), words: 1, tgId: 3000 + i, patch: { nextDailyAt: local(30, 9, 0) + 86_400_000 } });
    const plan = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT u.id, u.chat_id FROM users u WHERE u.next_daily_at <= CAST(?1 AS INTEGER) AND +u.active = 1 AND u.onboarding_step IS NULL ORDER BY u.next_daily_at, u.id LIMIT 35").bind(local(30, 9, 1)).all<{ detail: string }>();
    const detail = plan.results.map((r) => r.detail).join(" ");
    expect(detail).toMatch(/USING (COVERING )?INDEX idx_users_next_daily/);
    expect(detail).not.toMatch(/SCAN u\b/);
    const stepPlan = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT u.id FROM users u WHERE u.last_review_at BETWEEN ?1 - 86400000 AND ?1 - 180000 AND +u.active = 1 AND u.onboarding_step IS NULL").bind(local(30, 9, 1)).all<{ detail: string }>();
    expect(stepPlan.results.map((r) => r.detail).join(" ")).toMatch(/idx_users_last_review/);
  });
});

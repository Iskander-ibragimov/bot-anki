import { runVoiceJob } from "../content/audio";
import type { Lang, Repo } from "../db/repo";
import { dict } from "../i18n";
import { claim, completeMany, fail } from "../jobs/queue";
import { type TgApi, tgErrorInfo } from "../tg/client";
import { EVENING_AT, localDay, nextOccurrence } from "../users/service";

export interface TickDeps { repo: Repo; tg: TgApi; adminChatId: number; now: number }

const MAX_SENDS = 35;
const MAX_VOICE_JOBS = 3;
const EVENING_SCAN = 100;

/* SQL fragments; ?1 = now (ms). Local day uses the 04:00 boundary. */
const NOW = "CAST(?1 AS INTEGER)";
const LOCAL_MIN = `(((${NOW} / 60000) + u.tz_offset_min) % 1440)`;
const DAY_START = `(((${NOW} + (u.tz_offset_min - 240) * 60000) / 86400000) * 86400000 - (u.tz_offset_min - 240) * 60000)`;
const READY = "+u.active = 1 AND u.onboarding_step IS NULL";
const IN_DECKS = "n.deck_id IN (SELECT deck_id FROM user_decks WHERE user_id = u.id)";

interface Push { chat_id: number; text: string; reply_markup: unknown; parse_mode: "HTML" }
interface Planned { userId: number; push: Push }

const button = (text: string) => ({ inline_keyboard: [[{ text, callback_data: "learn", style: "primary" }]] });

/**
 * Runs every minute. Candidates come from indexed columns (next_daily_at, next_evening_at, last_review_at),
 * so only due users are read. Users are marked before sending (at-most-once), so a crashed or slow tick never repeats a push.
 */
export async function tick(d: TickDeps): Promise<{ sent: number }> {
  const { repo, tg, now } = d;
  const db = repo.db;
  const [daily, evening, step] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT u.id, u.chat_id, u.lang, u.tz_offset_min, u.remind_at,
        (SELECT COUNT(*) FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.user_id = u.id AND c.state != 'new' AND c.due < ${DAY_START} + 86400000 AND ${IN_DECKS}) AS due_n,
        MIN(MAX(0, u.new_per_day - (SELECT COUNT(*) FROM review_log r WHERE r.user_id = u.id AND r.was_new = 1 AND r.undone = 0 AND r.reviewed_at >= ${DAY_START})),
            (SELECT COUNT(*) FROM notes n WHERE ${IN_DECKS} AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.user_id = u.id AND c.note_id = n.id AND c.state != 'new'))) AS new_n
      FROM users u WHERE u.next_daily_at <= ${NOW} AND ${READY}
      ORDER BY u.next_daily_at, u.id LIMIT ${MAX_SENDS}`).bind(now),
    db.prepare(`SELECT u.id, u.chat_id, u.lang, u.tz_offset_min, u.streak, u.last_study_day FROM users u
      WHERE u.next_evening_at <= ${NOW} AND ${READY} ORDER BY u.next_evening_at, u.id LIMIT ${EVENING_SCAN}`).bind(now),
    db.prepare(`SELECT u.id, u.chat_id, u.lang,
        (SELECT COUNT(*) FROM cards c WHERE c.user_id = u.id AND c.state IN ('learning','relearning') AND c.due <= ${NOW}) AS waiting
      FROM users u WHERE u.last_review_at BETWEEN ${NOW} - 86400000 AND ${NOW} - 180000 AND ${READY}
        AND (u.last_step_ping_at IS NULL OR u.last_step_ping_at < u.last_review_at)
        AND ${LOCAL_MIN} >= 480 AND ${LOCAL_MIN} < 1380
        AND EXISTS (SELECT 1 FROM cards c WHERE c.user_id = u.id AND c.state IN ('learning','relearning') AND c.due <= ${NOW})
      ORDER BY u.id LIMIT ${MAX_SENDS}`).bind(now),
  ]);

  const marks: D1PreparedStatement[] = [];
  const plan: Planned[] = [];
  const room = () => MAX_SENDS - plan.length;

  for (const r of daily!.results as { id: number; chat_id: number; lang: Lang; tz_offset_min: number; remind_at: string; due_n: number; new_n: number }[]) {
    marks.push(repo.updateUserStmt(r.id, { nextDailyAt: nextOccurrence(r.tz_offset_min, r.remind_at, now) }));
    const n = r.due_n + r.new_n;
    if (n > 0) {
      const t = dict(r.lang);
      plan.push({ userId: r.id, push: { chat_id: r.chat_id, text: t.pushDaily(n, Math.max(1, Math.ceil(n / 3))), reply_markup: button(t.startBtn), parse_mode: "HTML" } });
    }
  }
  for (const r of evening!.results as { id: number; chat_id: number; lang: Lang; tz_offset_min: number; streak: number; last_study_day: string | null }[]) {
    const atRisk = r.streak >= 2 && r.last_study_day === localDay(r.tz_offset_min, now - 86_400_000);
    if (atRisk && room() <= 0) continue; // stays due; handled next minute
    marks.push(repo.updateUserStmt(r.id, { nextEveningAt: nextOccurrence(r.tz_offset_min, EVENING_AT, now) }));
    if (!atRisk) continue;
    const t = dict(r.lang);
    plan.push({ userId: r.id, push: { chat_id: r.chat_id, text: t.pushEvening(r.streak), reply_markup: button(t.saveStreakBtn), parse_mode: "HTML" } });
  }
  for (const r of step!.results as { id: number; chat_id: number; lang: Lang; waiting: number }[]) {
    if (room() <= 0) break;
    marks.push(repo.updateUserStmt(r.id, { lastStepPingAt: now }));
    const t = dict(r.lang);
    plan.push({ userId: r.id, push: { chat_id: r.chat_id, text: t.pushStep(r.waiting), reply_markup: button(t.continueBtn), parse_mode: "HTML" } });
  }
  if (marks.length) await repo.batch(marks);

  let sent = 0;
  let limitedUntil: number | null = null;
  const after: D1PreparedStatement[] = [];
  /** Sends one push; on 429 the rest of this tick's pushes are queued for later. */
  const send = async (userId: number | null, p: Push): Promise<"ok" | "limited" | "error"> => {
    if (limitedUntil != null) { after.push(enqueueStmt(db, p, limitedUntil)); return "limited"; }
    try {
      await tg.call("sendMessage", p as unknown as Record<string, unknown>);
      sent++;
      return "ok";
    } catch (e) {
      const info = tgErrorInfo(e);
      if (info?.code === 429) {
        limitedUntil = now + (info.retryAfter ?? 30) * 1000;
        after.push(enqueueStmt(db, p, limitedUntil));
        return "limited";
      }
      if (info?.code === 403 && userId != null) after.push(repo.updateUserStmt(userId, { active: false }));
      else console.error("push failed", info ?? String(e));
      return "error";
    }
  };
  for (const p of plan) await send(p.userId, p.push);

  if (limitedUntil == null && sent < MAX_SENDS) {
    const jobs = await claim(db, now, Math.min(10, MAX_SENDS - sent));
    const done: number[] = [];
    let voice = 0;
    for (const j of jobs) {
      try {
        if (j.kind === "push") {
          const res = await send(null, j.payload as unknown as Push);
          done.push(j.id);
          if (res === "limited") break;
        } else if (j.kind === "voice") {
          if (voice++ >= MAX_VOICE_JOBS) break;
          await runVoiceJob(repo, tg, d.adminChatId, j.payload as { noteId: number; audioUrl: string });
          done.push(j.id);
        } else done.push(j.id);
      } catch (e) {
        await fail(db, j.id, String((e as Error).message ?? e), now);
      }
    }
    await completeMany(db, done, now);
  }
  if (after.length) await repo.batch(after);
  return { sent };
}

function enqueueStmt(db: D1Database, payload: Push, runAt: number): D1PreparedStatement {
  return db.prepare("INSERT INTO jobs (kind, payload, run_at) VALUES ('push', ?, ?)").bind(JSON.stringify(payload), runAt);
}

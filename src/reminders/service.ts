import { runVoiceJob } from "../content/audio";
import type { Lang, Repo } from "../db/repo";
import { dict } from "../i18n";
import { claim, completeMany, enqueue, fail } from "../jobs/queue";
import { type TgApi, tgErrorInfo } from "../tg/client";

export interface TickDeps { repo: Repo; tg: TgApi; adminChatId: number; now: number }

const MAX_SENDS = 35;
const MAX_VOICE_JOBS = 3;

/* SQL fragments; ?1 = now (ms). Local day uses the 04:00 boundary. */
const NOW = "CAST(?1 AS INTEGER)";
const LOCAL_MIN = `(((${NOW} / 60000) + u.tz_offset_min) % 1440)`;
const LOCAL_DAY = `date((${NOW} / 1000) + (u.tz_offset_min - 240) * 60, 'unixepoch')`;
const DAY_START = `(((${NOW} + (u.tz_offset_min - 240) * 60000) / 86400000) * 86400000 - (u.tz_offset_min - 240) * 60000)`;
const REMIND_MIN = "(CAST(substr(u.remind_at, 1, 2) AS INTEGER) * 60 + CAST(substr(u.remind_at, 4, 2) AS INTEGER))";
const READY = "u.active = 1 AND u.onboarding_step IS NULL";
const IN_DECKS = "n.deck_id IN (SELECT deck_id FROM user_decks WHERE user_id = u.id)";

interface Target { id: number; chat_id: number; lang: Lang; local_day: string }
interface Push { chat_id: number; text: string; reply_markup: unknown; parse_mode: "HTML" }

const button = (text: string) => ({ inline_keyboard: [[{ text, callback_data: "learn", style: "primary" }]] });

/** Runs every minute: daily reminders, evening streak saves, learning-step pings, then queued jobs. */
export async function tick(d: TickDeps): Promise<{ sent: number }> {
  const { repo, tg, now } = d;
  const db = repo.db;
  const [daily, evening, step] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT u.id, u.chat_id, u.lang, ${LOCAL_DAY} AS local_day,
        (SELECT COUNT(*) FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.user_id = u.id AND c.state != 'new' AND c.due < ${DAY_START} + 86400000 AND ${IN_DECKS}) AS due_n,
        MIN(MAX(0, u.new_per_day - (SELECT COUNT(*) FROM review_log r WHERE r.user_id = u.id AND r.was_new = 1 AND r.undone = 0 AND r.reviewed_at >= ${DAY_START})),
            (SELECT COUNT(*) FROM notes n WHERE ${IN_DECKS} AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.user_id = u.id AND c.note_id = n.id AND c.state != 'new'))) AS new_n
      FROM users u WHERE ${READY} AND ${LOCAL_MIN} >= ${REMIND_MIN}
        AND (u.last_daily_push_day IS NULL OR u.last_daily_push_day != ${LOCAL_DAY})
      ORDER BY u.remind_at, u.id LIMIT ${MAX_SENDS}`).bind(now),
    db.prepare(`SELECT u.id, u.chat_id, u.lang, u.streak, ${LOCAL_DAY} AS local_day FROM users u
      WHERE ${READY} AND ${LOCAL_MIN} >= 1200 AND ${LOCAL_MIN} < 1380 AND u.streak >= 2
        AND u.last_study_day = date(${LOCAL_DAY}, '-1 day')
        AND (u.last_evening_push_day IS NULL OR u.last_evening_push_day != ${LOCAL_DAY})
      ORDER BY u.id LIMIT ${MAX_SENDS}`).bind(now),
    db.prepare(`SELECT u.id, u.chat_id, u.lang, ${LOCAL_DAY} AS local_day,
        (SELECT COUNT(*) FROM cards c WHERE c.user_id = u.id AND c.state IN ('learning','relearning') AND c.due <= ${NOW}) AS waiting
      FROM users u WHERE ${READY} AND u.last_review_at IS NOT NULL AND u.last_review_at < ${NOW} - 180000
        AND (u.last_step_ping_at IS NULL OR u.last_step_ping_at < u.last_review_at)
        AND ${LOCAL_MIN} >= 480 AND ${LOCAL_MIN} < 1380
        AND EXISTS (SELECT 1 FROM cards c WHERE c.user_id = u.id AND c.state IN ('learning','relearning') AND c.due <= ${NOW})
      ORDER BY u.id LIMIT ${MAX_SENDS}`).bind(now),
  ]);

  const marks: D1PreparedStatement[] = [];
  let sent = 0;
  let blocked = false;

  /** Returns false when Telegram rate-limited us (stop sending this tick). */
  const send = async (userId: number | null, p: Push): Promise<"ok" | "gone" | "limited" | "error"> => {
    try {
      await tg.call("sendMessage", p as unknown as Record<string, unknown>);
      sent++;
      return "ok";
    } catch (e) {
      const info = tgErrorInfo(e);
      if (info?.code === 429) {
        blocked = true;
        await enqueue(db, "push", p, now + (info.retryAfter ?? 30) * 1000);
        return "limited";
      }
      if (info?.code === 403 && userId != null) {
        marks.push(repo.updateUserStmt(userId, { active: false }));
        return "gone";
      }
      console.error("push failed", info ?? e);
      return "error";
    }
  };
  const budgetLeft = () => !blocked && sent < MAX_SENDS;

  for (const r of daily!.results as unknown as (Target & { due_n: number; new_n: number })[]) {
    if (!budgetLeft()) break;
    const n = r.due_n + r.new_n;
    if (n > 0) {
      const t = dict(r.lang);
      const res = await send(r.id, { chat_id: r.chat_id, text: t.pushDaily(n, Math.max(1, Math.ceil(n / 3))), reply_markup: button(t.startBtn), parse_mode: "HTML" });
      if (res === "error") continue;
    }
    marks.push(repo.updateUserStmt(r.id, { lastDailyPushDay: r.local_day }));
  }
  for (const r of evening!.results as unknown as (Target & { streak: number })[]) {
    if (!budgetLeft()) break;
    const t = dict(r.lang);
    const res = await send(r.id, { chat_id: r.chat_id, text: t.pushEvening(r.streak), reply_markup: button(t.saveStreakBtn), parse_mode: "HTML" });
    if (res !== "error") marks.push(repo.updateUserStmt(r.id, { lastEveningPushDay: r.local_day }));
  }
  for (const r of step!.results as unknown as (Target & { waiting: number })[]) {
    if (!budgetLeft()) break;
    const t = dict(r.lang);
    const res = await send(r.id, { chat_id: r.chat_id, text: t.pushStep(r.waiting), reply_markup: button(t.continueBtn), parse_mode: "HTML" });
    if (res !== "error") marks.push(repo.updateUserStmt(r.id, { lastStepPingAt: now }));
  }
  if (marks.length) await repo.batch(marks);

  if (budgetLeft()) {
    const jobs = await claim(db, now, Math.min(10, MAX_SENDS - sent));
    const done: number[] = [];
    let voice = 0;
    for (const j of jobs) {
      try {
        if (j.kind === "push") {
          if (!budgetLeft()) break;
          const res = await send(null, j.payload as unknown as Push);
          if (res === "limited") { done.push(j.id); break; }
          done.push(j.id);
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
  return { sent };
}

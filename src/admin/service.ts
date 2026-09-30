import { parseCsv } from "../content/csv";
import type { Repo, User } from "../db/repo";
import type { Config } from "../env";
import type { TgApi } from "../tg/client";

export const FREE_ROWS_WRITTEN_PER_DAY = 100_000;
const WARN_SHARE = 0.8;
const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

export const isAdmin = (u: User, c: Config) => u.tgId === c.adminTgId;

export async function adminStatsText(repo: Repo, now: number): Promise<string> {
  const day = utcDay(now);
  const since = now - 86_400_000;
  const r = await repo.db.prepare(
    `SELECT (SELECT COUNT(*) FROM users) AS users,
            (SELECT COUNT(*) FROM users WHERE last_review_at >= ?1) AS active,
            (SELECT COUNT(*) FROM users WHERE created_at >= ?1) AS new_users,
            (SELECT COALESCE(SUM(reviews), 0) FROM usage_daily WHERE day = ?2) AS reviews,
            (SELECT COALESCE(SUM(rows_written_est), 0) FROM usage_daily WHERE day = ?2) AS rows,
            (SELECT COUNT(*) FROM jobs WHERE error IS NOT NULL AND done_at >= ?1) AS failed`,
  ).bind(since, day).first<Record<string, number>>();
  const pct = Math.round((100 * r!.rows!) / FREE_ROWS_WRITTEN_PER_DAY);
  return `🛠 <b>Админ</b> · ${day} (UTC)\n\nПользователей: ${r!.users}\nАктивных за сутки: ${r!.active}\nНовых за сутки: ${r!.new_users}\nПовторов сегодня: ${r!.reviews}\nЗаписей в D1 (оценка): ${r!.rows} · ${pct}% лимита\nОшибок задач за сутки: ${r!.failed}`;
}

/** Caption format: "deck: <title_ru> | <title_en> | <level>". Creates or extends a catalog deck. */
export async function importDeckCsv(repo: Repo, csv: string, caption: string, now: number): Promise<string> {
  const m = caption.match(/^deck:\s*([^|]+)\|([^|]+)(?:\|(.*))?$/i);
  if (!m) return "Подпись файла: <code>deck: Название | Title | A2</code>";
  const [titleRu, titleEn, level] = [m[1]!.trim(), m[2]!.trim(), (m[3] ?? "").trim() || null];
  const rows = parseCsv(csv).filter((r) => r.word?.trim() && r.translation?.trim());
  if (!rows.length) return "В файле нет строк с колонками word и translation.";
  const slug = titleEn.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40).replace(/_$/, "") || `deck_${now}`;
  const existing = await repo.getDeckBySlug(slug);
  const deckId = existing?.id ?? (await repo.insertDeck({ slug, kind: "catalog", titleRu, titleEn, level, ownerId: null }));
  await repo.insertNotes(deckId, rows.map((r) => ({
    word: r.word!, ipa: r.ipa || null, pos: r.pos ?? "", translation: r.translation!, exampleEn: r.example_en ?? "", exampleRu: r.example_ru ?? "",
    audioFileId: r.audio_file_id || null,
  })));
  return `✅ Колода «${titleRu}» (${slug}): загружено ${rows.length} слов.`;
}

/** Warns the admin once a day when D1 writes pass 80% of the free limit. */
export async function checkUsage(repo: Repo, tg: TgApi, adminChatId: number, now: number): Promise<boolean> {
  const day = utcDay(now);
  const r = await repo.db.prepare(
    `UPDATE usage_daily SET warned = 1 WHERE day = ? AND warned = 0 AND rows_written_est >= ? RETURNING rows_written_est`,
  ).bind(day, Math.floor(FREE_ROWS_WRITTEN_PER_DAY * WARN_SHARE)).first<{ rows_written_est: number }>();
  if (!r) return false;
  await tg.call("sendMessage", { chat_id: adminChatId, text: `⚠️ Бот использовал ~${Math.round(r.rows_written_est / 1000)}k из 100k записей D1 за сегодня (UTC). При исчерпании бот встанет до 03:00 МСК. Подумайте о Workers Paid ($5/мес).` });
  return true;
}

/** Registers the webhook and bot commands. Env: BOT_TOKEN, WEBHOOK_SECRET, WORKER_URL. */
export {};
const { BOT_TOKEN, WEBHOOK_SECRET, WORKER_URL } = process.env;
if (!BOT_TOKEN || !WEBHOOK_SECRET || !WORKER_URL) throw new Error("BOT_TOKEN, WEBHOOK_SECRET and WORKER_URL are required");

async function api(method: string, body: unknown) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; description?: string };
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  console.log(`${method}: ok`);
}

const ru = [
  ["learn", "Повторять слова"], ["add", "➕ Добавить своё слово"], ["mywords", "📒 Мои слова"], ["decks", "Колоды"], ["gen", "AI-колода по теме"], ["stats", "Прогресс"],
  ["settings", "Настройки"], ["undo", "Отменить оценку"], ["help", "Помощь"],
];
const en = [
  ["learn", "Review words"], ["add", "➕ Add your own word"], ["mywords", "📒 My words"], ["decks", "Decks"], ["gen", "AI deck by topic"], ["stats", "Progress"],
  ["settings", "Settings"], ["undo", "Undo last rating"], ["help", "Help"],
];
const cmds = (l: string[][]) => l.map(([command, description]) => ({ command, description }));

await api("setWebhook", {
  url: `${WORKER_URL.replace(/\/$/, "")}/tg`, secret_token: WEBHOOK_SECRET,
  allowed_updates: ["message", "callback_query"], drop_pending_updates: false, max_connections: 40,
});
await api("setMyCommands", { commands: cmds(en) });
await api("setMyCommands", { commands: cmds(ru), language_code: "ru" });
await api("setMyDescription", { description: "Учу английские слова по методу интервальных повторений, как Anki: готовые колоды A1–B2, свои слова со ссылками, AI-колоды и одно напоминание в день.", language_code: "ru" });
await api("setMyDescription", { description: "Learn English words with spaced repetition, like Anki: ready decks A1–B2, your own words with links, AI decks and one reminder a day." });

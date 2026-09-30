import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { playVoice, runVoiceJob } from "../../src/content/audio";
import { fakeTelegram } from "../helpers/fakeTelegram";
import { seedUser } from "../helpers/seed";

const T = Date.UTC(2026, 8, 30, 6);

describe("audio", () => {
  it("voice job stores the Telegram file id", async () => {
    const { repo, noteIds } = await seedUser(env.DB, { now: T, words: 1 });
    const tg = fakeTelegram();
    await runVoiceJob(repo, tg, 999, { noteId: noteIds[0]!, audioUrl: "https://d.dev/a.mp3" });
    expect(tg.of("sendVoice")[0]!.payload).toMatchObject({ chat_id: 999, voice: "https://d.dev/a.mp3" });
    expect((await repo.getNote(noteIds[0]!))!.audioFileId).toMatch(/^voice-/);
    await runVoiceJob(repo, tg, 999, { noteId: noteIds[0]!, audioUrl: "https://d.dev/a.mp3" });
    expect(tg.of("sendVoice")).toHaveLength(1);
  });

  it("voice button sends by file id and deletes the previous voice", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 2 });
    await repo.setNoteAudio(noteIds[0]!, "FILE0");
    await repo.setNoteAudio(noteIds[1]!, "FILE1");
    await repo.saveSession({ userId: user.id, chatId: 1, messageId: 50, cardId: null, stale: false, lastVoiceMessageId: null });
    const tg = fakeTelegram();
    const first = await playVoice(repo, tg, user, noteIds[0]!);
    expect(first).toBe(true);
    await playVoice(repo, tg, user, noteIds[1]!);
    expect(tg.of("sendVoice").map((c) => c.payload.voice)).toEqual(["FILE0", "FILE1"]);
    expect(tg.of("deleteMessage")[0]!.payload).toMatchObject({ chat_id: 1, message_id: 100 });
    expect((await repo.getSession(user.id))!.lastVoiceMessageId).toBe(101);
  });

  it("voice button without audio does nothing", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 1 });
    const tg = fakeTelegram();
    expect(await playVoice(repo, tg, user, noteIds[0]!)).toBe(false);
    expect(tg.calls).toHaveLength(0);
  });
});

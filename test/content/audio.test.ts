import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { playVoice, runVoiceJob } from "../../src/content/audio";
import { fakeTelegram } from "../helpers/fakeTelegram";
import { TgUpload } from "../../src/tg/client";
import { toBytes } from "../../src/tts/workersAi";
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

  it("a word without audio is synthesised once, uploaded and cached", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 1 });
    const tg = fakeTelegram();
    const spoken: string[] = [];
    const synth = async (text: string) => { spoken.push(text); return new Uint8Array([1, 2, 3]); };
    expect(await playVoice(repo, tg, user, noteIds[0]!, synth)).toBe(true);
    const upload = tg.of("sendVoice")[0]!.payload.voice as TgUpload;
    expect(upload).toBeInstanceOf(TgUpload);
    expect([...upload.bytes]).toEqual([1, 2, 3]);
    expect((await repo.getNote(noteIds[0]!))!.audioFileId).toMatch(/^voice-/);
    expect(await playVoice(repo, tg, user, noteIds[0]!, synth)).toBe(true);
    expect(spoken).toEqual(["borrow"]);
    expect(tg.of("sendVoice")[1]!.payload.voice).toMatch(/^voice-/);
  });

  it("falls back to synthesis when Telegram can't fetch the dictionary audio url", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 1 });
    await env.DB.prepare("UPDATE notes SET audio_url = 'https://d.dev/broken.mp3' WHERE id = ?").bind(noteIds[0]).run();
    const tg = fakeTelegram();
    tg.failNext("sendVoice", 400, "Bad Request: failed to get HTTP URL content");
    expect(await playVoice(repo, tg, user, noteIds[0]!, async () => new Uint8Array([9]))).toBe(true);
    expect(tg.of("sendVoice")).toHaveLength(2);
  });

  it("returns false when synthesis is unavailable or fails", async () => {
    const { repo, user, noteIds } = await seedUser(env.DB, { now: T, words: 1 });
    const tg = fakeTelegram();
    expect(await playVoice(repo, tg, user, noteIds[0]!)).toBe(false);
    expect(await playVoice(repo, tg, user, noteIds[0]!, async () => null)).toBe(false);
    expect(await playVoice(repo, tg, user, noteIds[0]!, async () => { throw new Error("neurons exhausted"); })).toBe(false);
    expect(tg.calls).toHaveLength(0);
  });

  it("toBytes understands base64 json, binary and stream outputs of Workers AI", async () => {
    expect([...(await toBytes({ audio: btoa("\x01\x02\xff") }))!]).toEqual([1, 2, 255]);
    expect([...(await toBytes(new Uint8Array([4, 5]).buffer))!]).toEqual([4, 5]);
    expect([...(await toBytes(new Response(new Uint8Array([6, 7])).body))!]).toEqual([6, 7]);
    expect(await toBytes({ nothing: true })).toBeNull();
    expect(await toBytes({ audio: "" })).toBeNull();
  });
});

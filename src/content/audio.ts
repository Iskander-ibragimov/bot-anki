import type { Repo, User } from "../db/repo";
import { type TgApi, type TgMessage, TgUpload, tgErrorInfo } from "../tg/client";

/** Job: upload a dictionary mp3 once (to the admin chat) and cache Telegram's file_id on the note. */
export async function runVoiceJob(repo: Repo, tg: TgApi, adminChatId: number, p: { noteId: number; audioUrl: string }): Promise<void> {
  const note = await repo.getNote(p.noteId);
  if (!note || note.audioFileId) return;
  const msg = await tg.call<TgMessage>("sendVoice", { chat_id: adminChatId, voice: p.audioUrl, disable_notification: true });
  const fileId = msg.voice?.file_id ?? msg.audio?.file_id;
  if (fileId) await repo.setNoteAudio(p.noteId, fileId);
}

export type Synth = (text: string) => Promise<Uint8Array | null>;

/**
 * 🔊 button: sends the word's voice and removes the previous one so the chat stays clean.
 * Source order: cached Telegram file → dictionary mp3 url → speech synthesis (then cached for everyone).
 * Returns false when nothing could be played; never throws for Telegram or synthesis failures.
 */
export async function playVoice(repo: Repo, tg: TgApi, user: User, noteId: number, synth?: Synth, opts: { synthTimeoutMs?: number } = {}): Promise<boolean> {
  const note = await repo.getNoteForUser(user.id, noteId);
  if (!note) return false;
  const synthesise = async (): Promise<TgUpload | null> => {
    if (!synth) return null;
    try {
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), opts.synthTimeoutMs ?? 8000));
      const bytes = await Promise.race([synth(note.word), timeout]);
      return bytes ? new TgUpload(bytes, "word.mp3") : null;
    } catch (e) {
      console.error("speech synthesis failed", String(e));
      return null;
    }
  };
  let voice: string | TgUpload | null = note.audioFileId ?? note.audioUrl ?? (await synthesise());
  if (!voice) return false;
  const session = await repo.getSession(user.id);
  if (session?.lastVoiceMessageId) {
    await tg.call("deleteMessage", { chat_id: user.chatId, message_id: session.lastVoiceMessageId }).catch(() => undefined);
  }
  const sendVoice = async (v: string | TgUpload): Promise<TgMessage | number> => {
    try {
      return await tg.call<TgMessage>("sendVoice", { chat_id: user.chatId, voice: v, disable_notification: true });
    } catch (e) {
      const code = tgErrorInfo(e)?.code ?? 0;
      console.error("sendVoice failed", code);
      return code;
    }
  };
  let msg = await sendVoice(voice);
  if (typeof msg === "number") {
    // 400 for a file id or url means Telegram can't use that source (dead link, stale id): try our own synthesis once.
    if (msg !== 400 || voice instanceof TgUpload) return false;
    voice = await synthesise();
    if (!voice) return false;
    msg = await sendVoice(voice);
    if (typeof msg === "number") return false;
  }
  const fileId = msg.voice?.file_id ?? msg.audio?.file_id;
  if (fileId && fileId !== note.audioFileId) await repo.setNoteAudio(noteId, fileId);
  await repo.setLastVoice(user.id, user.chatId, msg.message_id);
  return true;
}

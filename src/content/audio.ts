import type { Repo, User } from "../db/repo";
import { type TgApi, type TgMessage, TgUpload } from "../tg/client";

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
 */
export async function playVoice(repo: Repo, tg: TgApi, user: User, noteId: number, synth?: Synth): Promise<boolean> {
  const note = await repo.getNote(noteId);
  if (!note) return false;
  const synthesise = async (): Promise<TgUpload | null> => {
    if (!synth) return null;
    try {
      const bytes = await synth(note.word);
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
  const sendVoice = (v: string | TgUpload) => tg.call<TgMessage>("sendVoice", { chat_id: user.chatId, voice: v, disable_notification: true });
  let msg: TgMessage;
  try {
    msg = await sendVoice(voice);
  } catch (e) {
    // A dictionary url Telegram can't fetch, or a stale file id: try our own synthesis once.
    if (voice instanceof TgUpload) throw e;
    voice = await synthesise();
    if (!voice) return false;
    msg = await sendVoice(voice);
  }
  const fileId = msg.voice?.file_id ?? msg.audio?.file_id;
  if (fileId && fileId !== note.audioFileId) await repo.setNoteAudio(noteId, fileId);
  await repo.saveSession({
    userId: user.id, chatId: user.chatId, messageId: session?.messageId ?? null, cardId: session?.cardId ?? null,
    stale: session?.stale ?? false, lastVoiceMessageId: msg.message_id,
  });
  return true;
}

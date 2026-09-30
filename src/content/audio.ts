import type { Repo, User } from "../db/repo";
import type { TgApi, TgMessage } from "../tg/client";

/** Job: upload a dictionary mp3 once (to the admin chat) and cache Telegram's file_id on the note. */
export async function runVoiceJob(repo: Repo, tg: TgApi, adminChatId: number, p: { noteId: number; audioUrl: string }): Promise<void> {
  const note = await repo.getNote(p.noteId);
  if (!note || note.audioFileId) return;
  const msg = await tg.call<TgMessage>("sendVoice", { chat_id: adminChatId, voice: p.audioUrl, disable_notification: true });
  const fileId = msg.voice?.file_id ?? msg.audio?.file_id;
  if (fileId) await repo.setNoteAudio(p.noteId, fileId);
}

/** 🔊 button: sends the word's voice and removes the previous one so the chat stays clean. */
export async function playVoice(repo: Repo, tg: TgApi, user: User, noteId: number): Promise<boolean> {
  const note = await repo.getNote(noteId);
  const voice = note?.audioFileId ?? note?.audioUrl;
  if (!note || !voice) return false;
  const session = await repo.getSession(user.id);
  if (session?.lastVoiceMessageId) {
    await tg.call("deleteMessage", { chat_id: user.chatId, message_id: session.lastVoiceMessageId }).catch(() => undefined);
  }
  const msg = await tg.call<TgMessage>("sendVoice", { chat_id: user.chatId, voice, disable_notification: true });
  const fileId = msg.voice?.file_id ?? msg.audio?.file_id;
  if (!note.audioFileId && fileId) await repo.setNoteAudio(noteId, fileId);
  await repo.saveSession({
    userId: user.id, chatId: user.chatId, messageId: session?.messageId ?? null, cardId: session?.cardId ?? null,
    stale: session?.stale ?? false, lastVoiceMessageId: msg.message_id,
  });
  return true;
}

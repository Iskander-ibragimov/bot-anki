import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo } from "../../src/db/repo";
import { harness } from "../helpers/botHarness";

const T = Date.UTC(2026, 8, 30, 6);
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

async function seedCatalog(db: D1Database) {
  const repo = new Repo(db);
  for (const slug of ["a1", "a2", "b1", "b2"]) {
    const id = await repo.insertDeck({ slug, kind: "catalog", titleRu: slug.toUpperCase(), titleEn: slug.toUpperCase(), level: slug.toUpperCase(), ownerId: null });
    await repo.insertNotes(id, [
      { word: `${slug}-one`, ipa: null, pos: "noun", translation: "один", exampleEn: "One.", exampleRu: "Один." },
      { word: `${slug}-two`, ipa: null, pos: "noun", translation: "два", exampleEn: "Two.", exampleRu: "Два." },
    ]);
  }
}
const callbacks = (m: { inline_keyboard?: { callback_data: string }[][] }) => (m.inline_keyboard ?? []).flat().map((b) => b.callback_data);

describe("bot handlers", () => {
  it("start runs onboarding to the first card", async () => {
    await seedCatalog(env.DB);
    const h = harness(env.DB, { now: T });
    await h.text("/start");
    expect(callbacks(h.lastMarkup())).toEqual(["ob:ru", "ob:en"]);
    await h.press("ob:ru");
    expect(h.lastText()).toContain("1/10");
    for (let i = 0; i < 10; i++) await h.press("ob:1");
    expect(h.lastText()).toContain("B2");
    await h.press("ob:10");
    expect(callbacks(h.lastMarkup())).toContain("ob:09:00");
    await h.press("ob:09:00");
    expect(callbacks(h.lastMarkup())).toContain("ob:180");
    await h.press("ob:180");
    expect(callbacks(h.lastMarkup())).toEqual(["ob:b2", "ob:other"]);
    await h.press("ob:b2");
    expect(h.lastText()).toContain("09:00");
    expect(callbacks(h.lastMarkup())).toEqual(["learn"]);
    await h.press("learn");
    const card = h.tg.of("sendMessage").at(-1)!;
    expect(String(card.payload.text)).toContain("b2-one");
    expect(callbacks(card.payload.reply_markup as never).slice(0, 4)).toEqual([expect.stringMatching(/^g:\d+:0:1$/), expect.stringMatching(/:2$/), expect.stringMatching(/:3$/), expect.stringMatching(/:4$/)]);
    expect(card.payload.link_preview_options).toEqual({ is_disabled: true });
  });

  async function startSession() {
    await seedCatalog(env.DB);
    const h = harness(env.DB, { now: T });
    await h.text("/start");
    const repo = new Repo(env.DB);
    const u = (await repo.getUserByTg(42))!;
    await repo.updateUser(u.id, { onboardingStep: null });
    await repo.subscribe(u.id, (await repo.getDeckBySlug("a1"))!.id, T);
    await h.text("/learn");
    const cardMsg = h.tg.lastMessageId();
    const grade = callbacks(h.tg.of("sendMessage").at(-1)!.payload.reply_markup as never)[2]!;
    return { h, repo, u, cardMsg, grade };
  }

  it("grade shows the next card as a new message and deletes the old one (fresh spoiler)", async () => {
    const { h, repo, u, cardMsg, grade } = await startSession();
    const editsBefore = h.tg.of("editMessageText").length;
    await h.press(grade, cardMsg);
    expect(h.tg.of("editMessageText")).toHaveLength(editsBefore);
    const next = h.tg.of("sendMessage").at(-1)!;
    expect(String(next.payload.text)).toContain("<b>a1-two</b>");
    expect(String(next.payload.text)).not.toContain("a1-one");
    expect(String(next.payload.text)).toContain("<tg-spoiler>");
    expect(next.payload.disable_notification).toBe(true);
    expect(h.tg.of("deleteMessage").map((c) => c.payload.message_id)).toEqual([cardMsg]);
    expect((await repo.getSession(u.id))!.messageId).toBe(h.tg.lastMessageId());
    expect(h.tg.lastMessageId()).not.toBe(cardMsg);
    await h.press(grade, cardMsg);
    expect(h.tg.of("answerCallbackQuery").at(-1)!.payload.text).toBe("Эта кнопка уже неактуальна");
    expect(h.tg.of("deleteMessage")).toHaveLength(1);
  });

  it("undo also re-sends the card as a new message", async () => {
    const { h, cardMsg, grade } = await startSession();
    await h.press(grade, cardMsg);
    const second = h.tg.lastMessageId();
    await h.press("u", second);
    expect(h.tg.of("deleteMessage").map((c) => c.payload.message_id)).toEqual([cardMsg, second]);
    expect(String(h.tg.of("sendMessage").at(-1)!.payload.text)).toContain("a1-one");
  });

  it("if the old card can't be deleted, its buttons are removed instead", async () => {
    const { h, cardMsg, grade } = await startSession();
    h.tg.failNext("deleteMessage", 400, "Bad Request: message can't be deleted for everyone");
    await h.press(grade, cardMsg);
    const strip = h.tg.of("editMessageReplyMarkup").at(-1)!;
    expect(strip.payload.message_id).toBe(cardMsg);
    expect(String(h.tg.of("sendMessage").at(-1)!.payload.text)).toContain("<b>a1-two</b>");
  });

  it("a deck added after today's new words are done says its words come tomorrow", async () => {
    const { h, repo, u } = await startSession();
    await repo.updateUser(u.id, { newPerDay: 1 });
    const first = callbacks(h.tg.of("sendMessage").at(-1)!.payload.reply_markup as never)[3]!; // "easy": the only new card of today
    await h.press(first, h.tg.lastMessageId());
    expect(h.lastText()).toContain("лимит — 1 в день");
    const b1 = (await repo.getDeckBySlug("b1"))!.id;
    await h.press(`sub:${b1}`, 300);
    expect(h.lastText()).toContain("B1");
    expect(h.lastText()).toContain("появятся завтра");
    await repo.updateUser(u.id, { newPerDay: 20 });
    const b2 = (await repo.getDeckBySlug("b2"))!.id;
    await h.press(`sub:${b2}`, 301);
    expect(h.lastText()).not.toContain("появятся завтра");
  });

  it("an AI deck added after today's new words are done says the same", async () => {
    await seedCatalog(env.DB);
    const h = harness(env.DB, { now: T, fetch: (async () => json({ choices: [{ message: { content: JSON.stringify({ cards: [{ word: "deploy", ipa: null, pos: "verb", translation: "выкатывать", exampleEn: "We deploy on Fridays.", exampleRu: "Мы выкатываем по пятницам." }] }) } }] })) as typeof fetch });
    await h.text("/start");
    const repo = new Repo(env.DB);
    const u = (await repo.getUserByTg(42))!;
    await repo.updateUser(u.id, { onboardingStep: null, newPerDay: 1 });
    await repo.subscribe(u.id, (await repo.getDeckBySlug("a1"))!.id, T);
    await h.text("/learn");
    await h.press(callbacks(h.tg.of("sendMessage").at(-1)!.payload.reply_markup as never)[3]!, h.tg.lastMessageId());
    await h.text("/gen devops");
    const ok = callbacks(h.lastMarkup()).find((c) => c.startsWith("gen:ok:"))!;
    await h.press(ok, h.tg.lastMessageId());
    expect(h.lastText()).toContain("devops");
    expect(h.lastText()).toContain("появятся завтра");
  });

  it("the voice message of the previous card is removed with it", async () => {
    const { h, repo, u, cardMsg, grade } = await startSession();
    await repo.saveSession({ userId: u.id, chatId: 42, messageId: cardMsg, cardId: null, stale: false, lastVoiceMessageId: 77 });
    await h.press(grade, cardMsg);
    expect(h.tg.of("deleteMessage").map((c) => c.payload.message_id).sort()).toEqual([77, cardMsg].sort());
    expect((await repo.getSession(u.id))!.lastVoiceMessageId).toBeNull();
  });

  it("voice button speaks any word through synthesis, or says it is unavailable", async () => {
    await seedCatalog(env.DB);
    const h = harness(env.DB, { now: T, synth: async () => new Uint8Array([1, 2, 3]) });
    await h.text("/start");
    const repo = new Repo(env.DB);
    const u = (await repo.getUserByTg(42))!;
    await repo.updateUser(u.id, { onboardingStep: null });
    await repo.subscribe(u.id, (await repo.getDeckBySlug("a1"))!.id, T);
    await h.text("/learn");
    const voiceBtn = callbacks(h.tg.of("sendMessage").at(-1)!.payload.reply_markup as never).find((c) => c.startsWith("v:"))!;
    await h.press(voiceBtn, h.tg.lastMessageId());
    expect(h.tg.of("sendVoice")).toHaveLength(1);

    const h2 = harness(env.DB, { now: T });
    await env.DB.prepare("UPDATE notes SET audio_file_id = NULL").run();
    await h2.press(voiceBtn, 1);
    expect(h2.tg.of("sendVoice")).toHaveLength(0);
    expect(h2.tg.of("answerCallbackQuery").at(-1)!.payload.text).toBe("Озвучка сейчас недоступна");
  });

  it("a card comes without sound: voice is sent only on the speaker button, or when autoplay is switched on in settings", async () => {
    await seedCatalog(env.DB);
    const h = harness(env.DB, { now: T, synth: async () => new Uint8Array([1, 2, 3]) });
    await h.text("/start");
    const repo = new Repo(env.DB);
    const u = (await repo.getUserByTg(42))!;
    expect(u.autoplay).toBe(false);
    await repo.updateUser(u.id, { onboardingStep: null });
    await repo.subscribe(u.id, (await repo.getDeckBySlug("a1"))!.id, T);
    await h.text("/learn");
    const buttons = callbacks(h.tg.of("sendMessage").at(-1)!.payload.reply_markup as never);
    await h.press(buttons[2]!, h.tg.lastMessageId()); // grade: the next card is shown
    expect(h.tg.of("sendVoice")).toHaveLength(0);
    const speaker = callbacks(h.tg.of("sendMessage").at(-1)!.payload.reply_markup as never).find((c) => c.startsWith("v:"))!;
    await h.press(speaker, h.tg.lastMessageId());
    expect(h.tg.of("sendVoice")).toHaveLength(1);

    await h.text("/settings");
    await h.press("set:auto", h.tg.lastMessageId());
    expect(JSON.stringify(h.lastMarkup())).toContain("Автоозвучка: вкл");
    await h.text("/learn");
    expect(h.tg.of("sendVoice")).toHaveLength(2);
  });

  it("the picture button on a card asks for a photo, shows the card with it, and can remove it again", async () => {
    const { h, repo, u, cardMsg } = await startSession();
    const picBtn = callbacks(h.tg.of("sendMessage").at(-1)!.payload.reply_markup as never).find((c) => c.startsWith("pic:"))!;
    await h.press(picBtn, cardMsg);
    expect(h.lastText()).toContain("Пришлите фото для «a1-one»");
    await h.photo("PIC1");
    const sent = h.tg.of("sendPhoto").at(-1)!;
    expect(sent.payload.photo).toBe("PIC1");
    expect(sent.payload.has_spoiler).toBe(true);
    expect(String(sent.payload.caption)).toContain("<b>a1-one</b>");
    expect(callbacks(sent.payload.reply_markup as never).filter((c) => c.startsWith("g:"))).toHaveLength(4);
    expect(h.tg.of("deleteMessage").map((c) => c.payload.message_id)).toEqual([cardMsg]);
    const photoCard = h.tg.lastMessageId();
    expect((await repo.getSession(u.id))!.messageId).toBe(photoCard);

    await h.press(picBtn, photoCard);
    expect(h.lastText()).toContain("уже есть картинка");
    const rm = callbacks(h.lastMarkup()).find((c) => c.startsWith("pic:rm:"))!;
    await h.press(rm, h.tg.lastMessageId());
    expect(h.tg.of("sendPhoto")).toHaveLength(1);
    expect(String(h.tg.of("sendMessage").at(-1)!.payload.text)).toContain("<b>a1-one</b>");
    expect((await repo.findNoteForUser(u.id, "a1-one"))!.imageFileId).toBeNull();
    expect((await repo.getSession(u.id))!.messageId).toBe(h.tg.lastMessageId());
  });

  it("a photo without a caption never touches the card on screen: it starts a new card", async () => {
    const { h, repo, u } = await startSession();
    await h.photo("PIC0");
    expect(h.tg.of("sendPhoto")).toHaveLength(0);
    expect(h.tg.of("deleteMessage")).toHaveLength(0);
    expect(h.lastText()).toContain("Напишите слово");
    expect(callbacks(h.lastMarkup())).toEqual([expect.stringMatching(/^ph:no:\w+$/)]);
    await h.text("уютный cozy");
    expect(h.lastText()).toContain("🖼");
    await h.press(callbacks(h.lastMarkup())[0]!, h.tg.lastMessageId());
    expect((await repo.findNoteForUser(u.id, "cozy"))!.imageFileId).toBe("PIC0");
    expect((await repo.findNoteForUser(u.id, "a1-one"))!.imageFileId).toBeNull();

    await h.photo("PIC9");
    await h.press(callbacks(h.lastMarkup())[0]!, h.tg.lastMessageId());
    expect(h.lastText()).toBe("Не добавляю.");
    expect((await repo.getUser(u.id))!.pendingEdit).toBeNull();
  });

  it("a photo card falls back to text if Telegram rejects the picture", async () => {
    const { h, repo, u } = await startSession();
    const card = (await repo.getSession(u.id))!.cardId!;
    await repo.setUserMedia(u.id, (await repo.getCard(u.id, card))!.noteId, { imageFileId: "BROKEN" });
    h.tg.failNext("sendPhoto", 400, "Bad Request: wrong file identifier");
    await h.text("/learn");
    expect(String(h.tg.of("sendMessage").at(-1)!.payload.text)).toContain("<b>a1-one</b>");
  });

  it("extra photos of an album do not touch the card on screen", async () => {
    const { h } = await startSession();
    await h.photo("ALB2", undefined, undefined, "group-1");
    expect(h.tg.of("sendPhoto")).toHaveLength(0);
    expect(h.tg.of("deleteMessage")).toHaveLength(0);
  });

  it("the voice button only plays words from the user's own decks", async () => {
    await seedCatalog(env.DB);
    const repo = new Repo(env.DB);
    const strangerDeck = await repo.insertDeck({ slug: null, kind: "custom", titleRu: "Чужие", titleEn: "Other", level: null, ownerId: null });
    const [secret] = await repo.insertNotes(strangerDeck, [{ word: "secretword", ipa: null, pos: "", translation: "секрет", exampleEn: "", exampleRu: "" }]);
    let spoken = 0;
    const h = harness(env.DB, { now: T, synth: async () => { spoken++; return new Uint8Array([1]); } });
    await h.text("/start");
    await repo.updateUser((await repo.getUserByTg(42))!.id, { onboardingStep: null });
    await h.press(`v:${secret}`, 1);
    expect(spoken).toBe(0);
    expect(h.tg.of("sendVoice")).toHaveLength(0);
  });

  it("a photo captioned '/add word — перевод' adds the word, not the command", async () => {
    const h = harness(env.DB, { now: T });
    await h.text("/start");
    const repo = new Repo(env.DB);
    await repo.updateUser((await repo.getUserByTg(42))!.id, { onboardingStep: null });
    await h.photo("PIC3", "/add cozy — уютный");
    expect(h.lastText()).toContain("<b>cozy</b>");
    expect(h.lastText()).not.toContain("/add");
  });

  const ready = async (f?: typeof fetch) => {
    const h = harness(env.DB, { now: T, ...(f ? { fetch: f } : {}) });
    await h.text("/start");
    const repo = new Repo(env.DB);
    const u = (await repo.getUserByTg(42))!;
    await repo.updateUser(u.id, { onboardingStep: null });
    return { h, repo, u };
  };
  const aiFetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("dictionaryapi")) return json({}, 404);
    return json({ choices: [{ message: { content: JSON.stringify({ cards: [{ word: "cozy", ipa: null, pos: "adj", translation: "уютный", exampleEn: "A cozy room.", exampleRu: "Уютная комната." }] }) } }] });
  }) as typeof fetch;

  it("a pair typed in any order is previewed and saved to My words", async () => {
    const { h, repo, u } = await ready();
    await h.text("растопить лёд break the ice");
    expect(h.lastText()).toContain("<b>break the ice</b>");
    expect(h.lastText()).toContain("растопить лёд");
    expect(callbacks(h.lastMarkup())).toEqual([expect.stringMatching(/^add:ok:/), expect.stringMatching(/^add:edit:/), expect.stringMatching(/^add:no:/)]);
    await h.press(callbacks(h.lastMarkup())[0]!, h.tg.lastMessageId());
    expect(h.lastText()).toContain("«Мои слова»");
    expect(h.lastText()).toContain("всего 1");
    expect(callbacks(h.lastMarkup())).toEqual(["learn", "help:add", "mywords"]);
    expect((await repo.findNoteForUser(u.id, "break the ice"))!.translation).toBe("растопить лёд");
  });

  it("one side first: the bot waits for the other side or translates on request", async () => {
    const { h } = await ready(aiFetch);
    await h.text("cozy https://example.com/a", [{ type: "url", offset: 5, length: 21 }]);
    expect(h.lastText()).toContain("<b>cozy</b>");
    expect(callbacks(h.lastMarkup())).toEqual([expect.stringMatching(/^tr:auto:\w+$/), expect.stringMatching(/^tr:no:\w+$/)]);
    await h.press(callbacks(h.lastMarkup())[0]!, h.tg.lastMessageId());
    expect(h.lastText()).toContain("уютный");
    expect(h.lastText()).toContain("🔗 example.com");
    expect(callbacks(h.lastMarkup())[0]).toMatch(/^add:ok:/);

    await h.text("thrive");
    await h.text("процветать");
    expect(h.lastText()).toContain("<b>thrive</b>");
    expect(h.lastText()).toContain("процветать");

    await h.text("счастливая случайность");
    expect(h.lastText()).toContain("по-английски");
    await h.press(callbacks(h.lastMarkup())[1]!, h.tg.lastMessageId());
    expect(callbacks(h.lastMarkup())).toEqual([]);
  });

  it("auto-translation that fails keeps the word and lets the user retry or type the other side", async () => {
    const { h, repo, u } = await ready(); // the default fetch answers 500: no AI available
    await h.text("serendipity");
    const buttons = callbacks(h.lastMarkup());
    await h.press(buttons[0]!, h.tg.lastMessageId());
    expect(h.lastText()).toContain("Не получилось перевести «serendipity»");
    expect(callbacks(h.lastMarkup())).toEqual(buttons);
    await h.text("счастливая случайность");
    expect(h.lastText()).toContain("<b>serendipity</b>");
    await h.press(callbacks(h.lastMarkup())[0]!, h.tg.lastMessageId());
    expect((await repo.findNoteForUser(u.id, "serendipity"))!.translation).toBe("счастливая случайность");
  });

  it("buttons under an older word do not act on the newest one; a second tap on Add changes nothing", async () => {
    const { h, repo, u } = await ready(aiFetch);
    h.setNow(T + 1000);
    await h.text("cat");
    const catMsg = h.tg.lastMessageId();
    const catButtons = callbacks(h.lastMarkup());
    h.setNow(T + 2000);
    await h.text("dog");
    const editsBefore = h.tg.of("editMessageText").length;
    await h.press(catButtons[0]!, catMsg);
    expect(h.tg.of("answerCallbackQuery").at(-1)!.payload.text).toBe("Эта кнопка уже неактуальна");
    expect(h.tg.of("editMessageText")).toHaveLength(editsBefore); // the message is left as it is
    expect(h.tg.of("editMessageReplyMarkup").at(-1)!.payload.message_id).toBe(catMsg); // only its dead buttons go
    await h.press(catButtons[1]!, catMsg);
    expect(JSON.parse((await repo.getUser(u.id))!.pendingEdit!).await.text).toBe("dog");

    await h.text("thrive — процветать");
    const ok = callbacks(h.lastMarkup())[0]!;
    await h.press(ok, h.tg.lastMessageId());
    await h.press(ok, h.tg.lastMessageId());
    expect(h.lastText()).toContain("«Мои слова»");
    expect(h.tg.of("answerCallbackQuery").at(-1)!.payload.text).toBe("Эта кнопка уже неактуальна");
    expect((await repo.listCustomNotes(u.id, 10)).total).toBe(1);
  });

  it("after Edit and then Add, the next message is a new card, not a translation for the old one", async () => {
    const { h } = await ready();
    await h.text("Tom & Jerry — Том и Джерри");
    const [ok, edit] = callbacks(h.lastMarkup());
    const preview = h.tg.lastMessageId();
    await h.press(edit!, preview);
    const ask = h.tg.of("sendMessage").at(-1)!;
    expect(ask.payload.text).toContain("Tom &amp; Jerry");
    expect(ask.payload.parse_mode).toBe("HTML");
    await h.press(ok!, preview);
    await h.text("thrive — процветать");
    expect(h.lastText()).toContain("<b>thrive</b>");
  });

  it("a photo sent right after a word goes to the card being built", async () => {
    const { h, repo, u } = await ready();
    await h.text("cozy");
    await h.photo("PIC7");
    expect(h.lastText()).toContain("🖼");
    expect(h.lastText()).toContain("<b>cozy</b>");
    expect(callbacks(h.lastMarkup())[0]).toMatch(/^tr:auto:/);
    await h.text("уютный");
    expect(h.lastText()).toContain("🖼");
    await h.press(callbacks(h.lastMarkup())[0]!, h.tg.lastMessageId());
    expect((await repo.findNoteForUser(u.id, "cozy"))!.imageFileId).toBe("PIC7");
  });

  it("several cards in one message get a hint instead of being added", async () => {
    const { h } = await ready();
    await h.text("cozy\nthrive\nawkward");
    expect(h.lastText()).toContain("по одной");
    await h.text("https://youtu.be/q", [{ type: "url", offset: 0, length: 18 }]);
    expect(h.lastText()).toContain("youtu.be");
  });

  it("/add explains the formats and accepts a card right away; /mywords shows the dictionary", async () => {
    const { h } = await ready();
    await h.text("/add");
    expect(h.lastText()).toContain("в любом порядке");
    await h.text("/mywords");
    expect(h.lastText()).toContain("пока пуст");
    await h.text("/add thrive — процветать");
    expect(h.lastText()).toContain("<b>thrive</b>");
    await h.press(callbacks(h.lastMarkup())[0]!, h.tg.lastMessageId());
    await h.press("mywords", h.tg.lastMessageId());
    expect(h.lastText()).toContain("Мои слова");
    expect(h.lastMarkup().inline_keyboard![0]![0]).toMatchObject({ text: "thrive — процветать", callback_data: expect.stringMatching(/^mw:o:\d+:0$/) });
  });

  const filmFetch = (seen: string, sawImage: { type?: string; urls: string[] } = { urls: [] }) => (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sawImage.urls.push(url);
    if (url.includes("api.telegram.org/file/")) return new Response(new Uint8Array([255, 216, 255, 1, 2, 3]));
    if (url.startsWith("https://vision/")) {
      sawImage.type = JSON.parse(String(init!.body)).messages[0].content.find((p: { type: string }) => p.type === "image_url").image_url.url.slice(0, 23);
      return json({ choices: [{ message: { content: seen } }] });
    }
    if (url.includes("dictionaryapi")) return json({}, 404);
    return json({ choices: [{ message: { content: JSON.stringify({ cards: [{ word: "twist", ipa: null, pos: "verb", translation: "крутить", exampleEn: "...and not twist.", exampleRu: "…а не крутить." }] }) } }] });
  }) as typeof fetch;
  const readyWithVision = async (f: typeof fetch) => {
    const h = harness(env.DB, { now: T, fetch: f, vision: true });
    await h.text("/start");
    const repo = new Repo(env.DB);
    const u = (await repo.getUserByTg(42))!;
    await repo.updateUser(u.id, { onboardingStep: null });
    return { h, repo, u };
  };

  it("a film frame: the subtitle is read, and a tapped word becomes a card with the frame and the line", async () => {
    const saw = { urls: [] as string[] } as { type?: string; urls: string[] };
    const { h, repo, u } = await readyWithVision(filmFetch("...and not twist.", saw));
    await h.photo("FRAME");
    expect(h.tg.of("getFile").at(-1)!.payload.file_id).toBe("FRAME");
    expect(saw.type).toBe("data:image/jpeg;base64,");
    expect(saw.urls.some((x) => x.includes("vision") && x.includes("1:x"))).toBe(false); // the bot token never leaves Telegram
    expect(String(h.tg.of("sendMessage").at(-1)!.payload.text)).toContain("Читаю");
    expect(h.lastText()).toContain("На картинке: «...and not twist.»");
    const buttons = callbacks(h.lastMarkup());
    expect(buttons).toEqual([expect.stringMatching(/^ph:w:\w+:0$/), expect.stringMatching(/^ph:all:/), expect.stringMatching(/^ph:no:/)]);
    await h.press(buttons[0]!, h.tg.lastMessageId());
    expect(h.lastText()).toContain("<b>twist</b>");
    expect(h.lastText()).toContain("крутить");
    expect(h.lastText()).toContain("...and not twist.");
    expect(h.lastText()).toContain("🖼");
    await h.press(callbacks(h.lastMarkup())[0]!, h.tg.lastMessageId());
    expect(await repo.findNoteForUser(u.id, "twist")).toMatchObject({ imageFileId: "FRAME", exampleEn: "...and not twist.", translation: "крутить" });
    await h.press(buttons[0]!, h.tg.lastMessageId());
    expect(h.tg.of("answerCallbackQuery").at(-1)!.payload.text).toBe("Эта кнопка уже неактуальна");
    expect(h.lastText()).toContain("«Мои слова»"); // a second tap does not wipe the result
  });

  it("a picture with no readable text asks for the word; a failing reader does the same", async () => {
    const { h } = await readyWithVision(filmFetch("NONE"));
    await h.photo("CAT");
    expect(h.lastText()).toContain("не прочитался");
    const broken = await readyWithVision((async () => { throw new Error("network down"); }) as unknown as typeof fetch);
    await broken.h.photo("CAT");
    expect(broken.h.lastText()).toContain("не прочитался");
    expect(callbacks(broken.h.lastMarkup())).toEqual([expect.stringMatching(/^ph:no:/)]);
  });

  it("a word typed while the picture is still being read takes the picture; the reading message disappears", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const slow = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://vision/")) await gate;
      return filmFetch("...and not twist.")(input, init);
    }) as typeof fetch;
    const { h, repo, u } = await readyWithVision(slow);
    const first = h.photo("FRAME"); // the handler has answered; reading goes on in the background
    await new Promise((r) => setTimeout(r, 50));
    const reading = h.tg.lastMessageId();
    const repoUser = (await repo.getUser(u.id))!;
    expect(JSON.parse(repoUser.pendingEdit!).photo.fileId).toBe("FRAME");
    await new Repo(env.DB).updateUser(u.id, { pendingEdit: JSON.stringify({ await: { side: "en", text: "cozy", url: null, imageFileId: "FRAME", at: T } }) });
    release();
    await first;
    expect(h.tg.of("deleteMessage").map((c) => c.payload.message_id)).toEqual([reading]);
    expect(JSON.parse((await repo.getUser(u.id))!.pendingEdit!).await.text).toBe("cozy");
  });

  it("an Edit or picture request that was left behind does not capture what the user does next", async () => {
    const { h, repo, u } = await ready();
    await h.text("cozy — уютный");
    await h.press(callbacks(h.lastMarkup())[0]!, h.tg.lastMessageId());
    await h.text("/mywords");
    const list = h.tg.lastMessageId();
    await h.press(callbacks(h.lastMarkup())[0]!, list);
    const [edit, pic, , back] = callbacks(h.lastMarkup());

    // Edit, then back to the list: the next message is a new card
    await h.press(edit!, list);
    await h.press(back!, list);
    await h.text("pillow");
    expect(h.lastText()).toContain("перевод по-русски");
    expect((await repo.findNoteForUser(u.id, "cozy"))!.translation).toBe("уютный");
    await h.press(callbacks(h.lastMarkup())[1]!, h.tg.lastMessageId());

    // Edit, then a command
    await h.press(edit!, list);
    await h.text("/stats");
    await h.text("подушка");
    expect(h.lastText()).toContain("по-английски");
    await h.press(callbacks(h.lastMarkup())[1]!, h.tg.lastMessageId());

    // Edit, then the cancel button under the request
    await h.press(edit!, list);
    const cancel = callbacks(h.lastMarkup());
    expect(cancel).toEqual(["pend:x"]);
    await h.press("pend:x", h.tg.lastMessageId());
    expect((await repo.getUser(u.id))!.pendingEdit).toBeNull();
    expect(callbacks(h.lastMarkup())).toEqual([]);

    // Picture, then anything else: the next bare photo is a new card, not a picture for cozy
    await h.press(pic!, list);
    expect(callbacks(h.lastMarkup())).toEqual(["pend:x"]);
    await h.press(back!, list);
    await h.photo("STRAY");
    expect(h.lastText()).toContain("Напишите слово");
    expect((await repo.findNoteForUser(u.id, "cozy"))!.imageFileId).toBeNull();
  });

  it("a mis-tapped picture button on a card is forgotten as soon as the card is graded", async () => {
    const { h, repo, u, cardMsg, grade } = await startSession();
    const picBtn = callbacks(h.tg.of("sendMessage").at(-1)!.payload.reply_markup as never).find((c) => c.startsWith("pic:"))!;
    await h.press(picBtn, cardMsg);
    await h.press(grade, cardMsg);
    await h.photo("FRAME");
    expect(h.tg.of("sendPhoto")).toHaveLength(0);
    expect(h.lastText()).toContain("Напишите слово");
    expect((await repo.findNoteForUser(u.id, "a1-one"))!.imageFileId).toBeNull();
  });

  it("an album is treated as one picture: one reply, never one per photo", async () => {
    const { h } = await ready();
    await h.photo("ALB1", undefined, undefined, "g1");
    await h.photo("ALB2", undefined, undefined, "g1");
    await h.photo("ALB3", undefined, undefined, "g1");
    expect(h.tg.of("sendMessage").filter((c) => String(c.payload.text).includes("Напишите слово"))).toHaveLength(1);

    const before = h.tg.of("sendMessage").length;
    await h.photo("CAP1", "уютный cozy", undefined, "g2");
    await h.photo("CAP2", undefined, undefined, "g2");
    expect(h.tg.of("sendMessage")).toHaveLength(before + 1);
    expect(h.lastText()).toContain("<b>cozy</b>");
  });

  it("a photo with a caption adds a card with that picture", async () => {
    const { h, repo, u } = await ready();
    await h.photo("PIC2", "уютный cozy");
    expect(h.lastText()).toContain("🖼");
    await h.press(callbacks(h.lastMarkup())[0]!, h.tg.lastMessageId());
    expect((await repo.findNoteForUser(u.id, "cozy"))!.imageFileId).toBe("PIC2");
    await h.text("/learn");
    expect(h.tg.of("sendPhoto").at(-1)!.payload.photo).toBe("PIC2");
  });

  it("My words: open a word, edit it, give it a picture, delete it", async () => {
    const { h, repo, u } = await ready();
    for (const text of ["cosy — уютный", "thrive — процветать"]) {
      await h.text(text);
      await h.press(callbacks(h.lastMarkup())[0]!, h.tg.lastMessageId());
    }
    await h.text("/mywords");
    const list = h.tg.lastMessageId();
    expect(h.lastText()).toContain("Мои слова</b> · 2");
    const open = callbacks(h.lastMarkup()).filter((c) => c.startsWith("mw:o:"));
    expect(open).toHaveLength(2);
    const sendsBefore = h.tg.of("sendMessage").length;
    await h.press(open[1]!, list); // the older word: cosy
    expect(h.tg.of("sendMessage")).toHaveLength(sendsBefore); // shown in place
    expect(h.lastText()).toContain("<b>cosy</b>");
    const [edit, pic, del, back] = callbacks(h.lastMarkup());

    await h.press(edit!, list);
    expect(h.lastText()).toContain("новый вариант для «cosy»");
    await h.text("cozy");
    expect(h.lastText()).toContain("<b>cozy</b>");
    expect(h.lastText()).toContain("уютный");
    expect(callbacks(h.lastMarkup())[0]).toMatch(/^mw:e:/);
    expect(await repo.findNoteForUser(u.id, "cosy")).toBeNull();

    await h.press(edit!, list);
    await h.text("thrive");
    expect(h.lastText()).toContain("уже есть");
    await h.text("тёплый и уютный");
    expect((await repo.findNoteForUser(u.id, "cozy"))!.translation).toBe("тёплый и уютный");

    await h.press(pic!, list);
    expect(h.lastText()).toContain("Пришлите фото для «cozy»");
    await h.photo("MYPIC");
    expect(h.lastText()).toContain("<b>cozy</b>");
    expect(h.lastText()).toContain("🖼");
    expect((await repo.findNoteForUser(u.id, "cozy"))!.imageFileId).toBe("MYPIC");

    await h.press(del!, list);
    expect(h.lastText()).toContain("Удалить «cozy»");
    const [yes, no] = callbacks(h.lastMarkup());
    await h.press(no!, list);
    expect(h.lastText()).toContain("<b>cozy</b>");
    await h.press(yes!, list);
    expect(h.tg.of("answerCallbackQuery").at(-1)!.payload.text).toBe("«cozy» удалено");
    expect(h.lastText()).toContain("Мои слова</b> · 1");
    expect(await repo.findNoteForUser(u.id, "cozy")).toBeNull();
    await h.press(yes!, list);
    expect(h.tg.of("answerCallbackQuery").at(-1)!.payload.text).toBe("Этого слова уже нет в словаре");
    await h.press(back!, list);
    expect(callbacks(h.lastMarkup()).filter((c) => c.startsWith("mw:o:"))).toHaveLength(1);
  });

  it("D1 daily limit error answers with maintenance and does not throw", async () => {
    const broken = new Repo(env.DB);
    broken.getUserByTg = async () => { throw new Error("D1_ERROR: Your account has exceeded D1's free tier daily row write limit."); };
    const h = harness(env.DB, { now: T, repo: broken });
    await h.text("/learn");
    expect(h.lastText()).toContain("Технический перерыв");
  });

  it("settings buttons cycle values in place", async () => {
    const h = harness(env.DB, { now: T });
    await h.text("/start");
    const repo = new Repo(env.DB);
    const u = (await repo.getUserByTg(42))!;
    await repo.updateUser(u.id, { onboardingStep: null });
    await h.text("/settings");
    await h.press("set:ret", 200);
    expect(h.lastText()).toContain("Настройки");
    expect((await repo.getUser(u.id))!.retention).toBe(0.95);
    await h.press("set:dir", 200);
    expect((await repo.getUser(u.id))!.direction).toBe("ru_en");
    await h.press("set:ord", 200);
    expect((await repo.getUser(u.id))!.newOrder).toBe("random");
    expect(JSON.stringify(h.lastMarkup())).toContain("вперемешку");
  });
});

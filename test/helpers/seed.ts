import { Repo, type User } from "../../src/db/repo";

export const WORDS: [string, string][] = [
  ["borrow", "брать взаймы"], ["receipt", "чек"], ["journey", "поездка"], ["quiet", "тихий"], ["decide", "решать"],
  ["weather", "погода"], ["luggage", "багаж"], ["often", "часто"], ["forget", "забывать"], ["advice", "совет"],
  ["careful", "осторожный"], ["repair", "чинить"],
];

export async function seedUser(db: D1Database, opts: { words?: number; now: number; patch?: Partial<User>; tgId?: number } ) {
  const repo = new Repo(db);
  const deckId = await repo.insertDeck({ slug: `a2-${opts.tgId ?? 1}`, kind: "catalog", titleRu: "A2 · Базовый", titleEn: "A2 · Elementary", level: "A2", ownerId: null });
  const noteIds = await repo.insertNotes(deckId, WORDS.slice(0, opts.words ?? 5).map(([word, translation]) => ({
    word, ipa: null, pos: "verb", translation, exampleEn: `I ${word}.`, exampleRu: `Я ${translation}.`,
  })));
  const userId = await repo.insertUser({ tgId: opts.tgId ?? 1, chatId: opts.tgId ?? 1, lang: "ru", now: opts.now });
  await repo.updateUser(userId, { onboardingStep: null, tzOffsetMin: 180, ...(opts.patch ?? {}) });
  await repo.subscribe(userId, deckId, opts.now);
  const user = (await repo.getUser(userId))!;
  return { repo, user, deckId, noteIds };
}

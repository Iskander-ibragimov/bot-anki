import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Repo } from "../../src/db/repo";
import { PLACEMENT_WORDS, placementLevel } from "../../src/users/placement";
import { advanceOnboarding, getOrCreate, langFromTelegram, nextOccurrence, offsetFromReported, setSetting, startOnboarding } from "../../src/users/service";

const T = Date.UTC(2026, 8, 30, 6, 0);

describe("users", () => {
  it("offset across midnight", () => {
    expect(offsetFromReported(0, 30, Date.UTC(2026, 8, 29, 21, 30))).toBe(180);
  });
  it("negative offset", () => {
    expect(offsetFromReported(5, 0, Date.UTC(2026, 8, 30, 10, 0))).toBe(-300);
  });
  it("offset rounds to 30 minutes and India works", () => {
    expect(offsetFromReported(11, 32, Date.UTC(2026, 8, 30, 6, 0))).toBe(330);
  });
  it("lang detection", () => {
    expect(langFromTelegram("ru")).toBe("ru");
    expect(langFromTelegram("uk")).toBe("ru");
    expect(langFromTelegram("kk")).toBe("ru");
    expect(langFromTelegram("en-US")).toBe("en");
    expect(langFromTelegram(undefined)).toBe("en");
  });
  it("placement levels", () => {
    expect(PLACEMENT_WORDS).toHaveLength(10);
    expect([2, 5, 8, 10].map(placementLevel)).toEqual(["A1", "A2", "B1", "B2"]);
  });
  it("invalid settings rejected", async () => {
    const repo = new Repo(env.DB);
    const { user } = await getOrCreate(repo, 5, 5, "ru", T);
    await expect(setSetting(repo, user.id, "retention", 0.5)).rejects.toThrow();
    await expect(setSetting(repo, user.id, "newPerDay", 7)).rejects.toThrow();
    await expect(setSetting(repo, user.id, "remindAt", "25:00")).rejects.toThrow();
    await expect(setSetting(repo, user.id, "newOrder", "sideways")).rejects.toThrow();
    await setSetting(repo, user.id, "newOrder", "random");
    expect((await repo.getUser(user.id))!.newOrder).toBe("random");
    await setSetting(repo, user.id, "retention", 0.95);
    await setSetting(repo, user.id, "direction", "both");
    const u = (await repo.getUser(user.id))!;
    expect(u.retention).toBe(0.95);
    expect(u.direction).toBe("both");
  });
  it("getOrCreate is idempotent", async () => {
    const repo = new Repo(env.DB);
    const a = await getOrCreate(repo, 7, 7, "en", T);
    const b = await getOrCreate(repo, 7, 7, "en", T);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.user.id).toBe(a.user.id);
    expect(b.user.lang).toBe("en");
  });

  it("full onboarding flow subscribes the level deck", async () => {
    const repo = new Repo(env.DB);
    const deckId = await repo.insertDeck({ slug: "a2", kind: "catalog", titleRu: "A2", titleEn: "A2", level: "A2", ownerId: null });
    let { user } = await getOrCreate(repo, 9, 9, "ru", T);
    expect(startOnboarding(user)).toEqual({ kind: "lang" });
    const step = async (answer: string) => { const s = await advanceOnboarding(repo, user, answer, T); user = (await repo.getUser(user.id))!; return s; };
    expect(await step("ru")).toMatchObject({ kind: "placement", index: 0, word: "house" });
    for (let i = 0; i < 10; i++) await step(i < 4 ? "1" : "0");
    expect(user.level).toBe("A2");
    expect(user.onboardingStep).toBe("goal");
    expect(await step("20")).toEqual({ kind: "remind" });
    const tz = await step("08:00");
    expect(tz.kind).toBe("tz");
    expect(await step("hello")).toMatchObject({ kind: "invalid" });
    const deck = await step("180");
    expect(deck).toMatchObject({ kind: "deck", slug: "a2" });
    expect(await step("a2")).toMatchObject({ kind: "finished", remindAt: "08:00", tzOffsetMin: 180 });
    expect(user.onboardingStep).toBeNull();
    expect(user.newPerDay).toBe(20);
    expect(await repo.userDeckIds(user.id)).toEqual([deckId]);
  });

  it("first reminder is scheduled for the next occurrence, not right after onboarding", async () => {
    const repo = new Repo(env.DB);
    await repo.insertDeck({ slug: "a1", kind: "catalog", titleRu: "A1", titleEn: "A1", level: "A1", ownerId: null });
    let { user } = await getOrCreate(repo, 11, 11, "ru", T);
    await repo.updateUser(user.id, { onboardingStep: "deck", level: "A1", remindAt: "09:00", tzOffsetMin: 180 });
    user = (await repo.getUser(user.id))!;
    const at1500 = Date.UTC(2026, 8, 30, 12, 0); // 15:00 local
    await advanceOnboarding(repo, user, "a1", at1500);
    const u = (await repo.getUser(user.id))!;
    expect(u.nextDailyAt).toBe(Date.UTC(2026, 9, 1, 6, 0)); // tomorrow 09:00 local
    expect(u.nextEveningAt).toBe(Date.UTC(2026, 8, 30, 17, 0)); // today 20:00 local
    expect(nextOccurrence(180, "09:00", Date.UTC(2026, 8, 30, 5, 0))).toBe(Date.UTC(2026, 8, 30, 6, 0));
  });

  it("changing the reminder time reschedules it", async () => {
    const repo = new Repo(env.DB);
    const { user } = await getOrCreate(repo, 12, 12, "ru", T);
    await repo.updateUser(user.id, { onboardingStep: null, tzOffsetMin: 180 });
    await setSetting(repo, user.id, "remindAt", "21:00", T);
    expect((await repo.getUser(user.id))!.nextDailyAt).toBe(Date.UTC(2026, 8, 30, 18, 0));
  });

  it("typed local time answers the timezone step", async () => {
    const repo = new Repo(env.DB);
    let { user } = await getOrCreate(repo, 10, 10, "ru", T);
    await repo.updateUser(user.id, { onboardingStep: "tz", level: "B1" });
    user = (await repo.getUser(user.id))!;
    const s = await advanceOnboarding(repo, user, "14:00", T);
    expect(s).toMatchObject({ kind: "deck", slug: "b1" });
    expect((await repo.getUser(user.id))!.tzOffsetMin).toBe(480);
  });
});

import { describe, expect, it } from "vitest";
import { dayWindow, localDay, localMinutes } from "../../src/users/service";

describe("local day", () => {
  it("day boundary is 04:00 local", () => {
    const at = (h: number, m: number) => Date.UTC(2026, 8, 30, h, m) - 180 * 60_000; // local +03:00
    expect(localDay(180, at(3, 59))).toBe("2026-09-29");
    expect(localDay(180, at(4, 0))).toBe("2026-09-30");
    const w = dayWindow(180, at(10, 0));
    expect(w.dayStartMs).toBe(at(4, 0));
    expect(w.dayEndMs - w.dayStartMs).toBe(86_400_000);
    expect(localMinutes(180, at(9, 5))).toBe(9 * 60 + 5);
  });
});

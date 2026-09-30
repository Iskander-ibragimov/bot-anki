/** Ten words of rising difficulty for the 30-second level check. */
export const PLACEMENT_WORDS = [
  "house", "answer", "borrow", "journey", "improve", "reliable", "approach", "thorough", "reluctant", "ubiquitous",
] as const;

export type Level = "A1" | "A2" | "B1" | "B2";

export function placementLevel(known: number): Level {
  if (known <= 2) return "A1";
  if (known <= 5) return "A2";
  if (known <= 8) return "B1";
  return "B2";
}

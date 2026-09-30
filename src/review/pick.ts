import type { Candidates, CardRow, NewNote } from "../db/repo";

export type Pick = { kind: "card"; card: CardRow } | { kind: "new"; note: NewNote };
const LEARN_AHEAD_MS = 60_000;

/**
 * Anki-style order: due learning cards, then reviews with new cards spread evenly
 * (one new after every ceil(reviews/newLeft) reviews), then learn-ahead within 60 s.
 */
export function pick(c: Candidates, newLeft: number, now: number, mix: number): Pick | null {
  const due = c.learning.find((x) => x.mem.due <= now);
  if (due) return { kind: "card", card: due };
  const review = c.review[0];
  const fresh = newLeft > 0 ? c.newNotes[0] : undefined;
  if (review && fresh) {
    const every = Math.max(1, Math.ceil(c.review.length / newLeft));
    return mix % (every + 1) === every ? { kind: "new", note: fresh } : { kind: "card", card: review };
  }
  if (review) return { kind: "card", card: review };
  if (fresh) return { kind: "new", note: fresh };
  const ahead = c.learning.find((x) => x.mem.due - now <= LEARN_AHEAD_MS);
  return ahead ? { kind: "card", card: ahead } : null;
}

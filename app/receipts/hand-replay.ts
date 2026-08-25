import type { TableProofBundle } from "../../worker/table-engine.ts";

/**
 * Steps a completed hand's TableProofBundle forward one transcript entry at
 * a time - board-so-far, pot, and each seat's contribution/folded status
 * after that entry. Pure and derived entirely from data already stored in
 * the `hands` table's bundle JSON (worker/poker-table.ts's
 * recordHandHistory) - no new capture needed, no timestamps (none exist
 * per action), so this is a step-through replay, not a real-time-paced one.
 *
 * Deliberately does NOT reconstruct absolute stack sizes - TableProofBundle
 * has no starting-stack field (stacks aren't part of the cryptographic
 * receipt, only contributions/pot are), so inventing one would be showing
 * a number the receipt doesn't actually support. `contributed` (chips each
 * seat has put in this hand so far) is the analogous quantity that IS
 * grounded in the transcript.
 */

export type ReplayStep = {
  sequence: number;
  street: string;
  actor: string; // "protocol" | "seat_N"
  action: string;
  amount: number;
  board: string[]; // card codes visible after this step
  pot: number;
  contributed: number[];
  folded: boolean[];
};

export type ReplayData = {
  seatCount: number;
  holeCards: ([string, string] | null)[];
  steps: ReplayStep[];
};

const CONTRIBUTION_ACTIONS = new Set(["post_small_blind", "post_big_blind", "call", "bet"]);
const VISIBLE_COUNT_BY_STREET: Record<string, number> = { preflop: 0, flop: 3, turn: 4, river: 5, complete: 5 };

export function buildReplay(bundle: TableProofBundle): ReplayData {
  const holeCards: ([string, string] | null)[] = bundle.holeCardDeckIndices.map((indices) =>
    indices ? [bundle.deck[indices[0]], bundle.deck[indices[1]]] : null,
  );
  const boardCodes = bundle.boardDeckIndices.map((index) => bundle.deck[index]);
  const contributed = new Array(bundle.seatCount).fill(0);
  const folded = new Array(bundle.seatCount).fill(false);

  const steps: ReplayStep[] = bundle.transcript.map((entry) => {
    const seatMatch = /^seat_(\d+)$/.exec(entry.actor);
    if (seatMatch) {
      const seat = Number(seatMatch[1]);
      if (entry.action === "fold") {
        folded[seat] = true;
      } else if (CONTRIBUTION_ACTIONS.has(entry.action) || entry.action.startsWith("raise_to_")) {
        if (Number.isFinite(entry.amount) && entry.amount >= 0) contributed[seat] += entry.amount;
      }
    }
    const visibleCount = VISIBLE_COUNT_BY_STREET[entry.street] ?? 0;
    return {
      sequence: entry.sequence,
      street: entry.street,
      actor: entry.actor,
      action: entry.action,
      amount: entry.amount,
      board: boardCodes.slice(0, visibleCount),
      pot: contributed.reduce((sum, c) => sum + c, 0),
      contributed: [...contributed],
      folded: [...folded],
    };
  });

  return { seatCount: bundle.seatCount, holeCards, steps };
}

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The seat-claim rule, guarded at the source.
 *
 * PokerTable is a Durable Object and imports db/index.ts, so it cannot be
 * loaded by this runner (see the note in worker/table-engine.ts about why the
 * pure modules exist). The rule being protected is one predicate, so this
 * asserts the predicate's SHAPE in the source rather than silently testing
 * nothing.
 *
 * What it protects: a player who drops their connection mid-hand keeps their
 * seat. Treating "disconnected" as "free" let a stranger claim the seat of
 * anyone who refreshed, and handleSit would then send them that player's hole
 * cards, overwrite their stack with a fresh buy-in, and null out their userId
 * so their own reconnect could no longer find the seat. handleLeave already
 * refuses to let a player leave mid-hand; this keeps resolveSeat consistent
 * with that.
 */
const source = readFileSync(new URL("../worker/poker-table.ts", import.meta.url), "utf8");

test("a disconnected seat is only reclaimable when it is not in a live hand", () => {
  const isFree = source.match(/const isFree = \(seat: Seat\) =>\s*([\s\S]*?);/);
  assert.ok(isFree, "resolveSeat's isFree predicate not found - did it get renamed?");
  const body = isFree[1].replace(/\s+/g, " ");

  assert.match(body, /connected === false/, "still keys off the connection");
  assert.match(
    body,
    /!inLiveHand\(seat\)/,
    "a disconnected seat must NOT be claimable while that seat is still in a live hand",
  );
});

test("private state is only resent to the seat's rightful owner", () => {
  assert.match(
    source,
    /const mayReceivePrivateState = isReturningOwner \|\| priorOccupant\?\.userId == null;/,
    "the second guard on resending hole cards / mental-poker partials is missing",
  );
  // Both resends must sit behind it - the server-dealt one and the trustless one.
  assert.match(source, /mayReceivePrivateState && this\.hand/, "hole-card resend is unguarded");
  assert.match(source, /mayReceivePrivateState && this\.isTrustless/, "trustless partial resend is unguarded");
});

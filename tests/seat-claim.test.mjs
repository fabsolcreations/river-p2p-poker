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

test("a trustless player cannot see their cards and leave before paying", () => {
  // Cards are dealt during the mental-poker phases; blinds are only posted
  // once maybeStartTrustlessBetting runs at phase "betting". So this.hand is
  // null while a player already holds their hole cards, and a leave guard
  // keyed only on this.hand would grant a free look.
  const guard = source.match(/const midHand =\s*([\s\S]*?);/);
  assert.ok(guard, "handleLeave's midHand guard not found - did it get renamed?");
  assert.match(
    guard[1].replace(/\s+/g, " "),
    /this\.inLiveTrustlessDeal\(seat\)/,
    "leaving must also be refused during a live trustless deal",
  );
});

test("the live-deal check covers the phases before betting starts", () => {
  const helper = source.match(/private inLiveTrustlessDeal\(seat: Seat\): boolean \{([\s\S]*?)\n  \}/);
  assert.ok(helper, "inLiveTrustlessDeal not found");
  const body = helper[1].replace(/\s+/g, " ");
  // Only the terminal phases release the seat; every dealing phase counts.
  assert.match(body, /phase === "complete"/);
  assert.match(body, /phase === "aborted"/);
});

test("the seat is claimed before the first await, not after the buy-in", () => {
  // Seat resolution and the buy-in are separated by a real D1 round-trip, and
  // a Durable Object yields at every await. If the seat were only written
  // after that, two sits arriving together would both resolve the same free
  // seat: one player's buy-in is debited and then overwritten, and two sockets
  // end up attached to one seat, after which socketFor() routes that seat's
  // private state to whichever it finds first.
  const body = source.slice(source.indexOf("private async handleSit("));
  const claim = body.indexOf("this.seats[seat] = { connected: true, userId: attachment.userId };");
  const firstAwait = body.indexOf("await this.buyIn(");
  assert.ok(claim > 0, "seat claim not found in handleSit");
  assert.ok(firstAwait > 0, "buyIn call not found in handleSit");
  assert.ok(claim < firstAwait, "the seat must be reserved BEFORE the awaited buy-in");

  // And a failed buy-in must not leave the reservation behind.
  assert.match(body.slice(0, firstAwait + 900), /this\.seats\[seat\] = priorOccupant;/,
    "a failed buy-in must release the seat it reserved");
});

test("an already-seated socket cannot move to a different seat", () => {
  // findSeatForUser only pins authenticated users, so without this an
  // anonymous socket could pass a new seatHint and take a second seat while
  // the first stayed occupied with no socket pointing at it - disconnectSocket
  // keys off the current attachment, so nothing would ever release it.
  const body = source.slice(source.indexOf("private async handleSit("));
  assert.match(
    body.slice(0, 1400),
    /if \(attachment\.seat !== null && this\.seats\[attachment\.seat\]\?\.connected\)/,
    "handleSit must short-circuit when this socket already holds a live seat",
  );
});

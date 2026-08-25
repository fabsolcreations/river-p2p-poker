# RIVER — handoff brief

Context for an AI assistant picking this project up cold. Read this before
touching anything.

---

## What this is

**RIVER** — a real, live multiplayer poker site at **https://playriver.gg**
(Cloudflare Workers). Test chips only; no real-money path is active.

The product's whole differentiator is **provable fairness**. That is not
marketing here — it is the actual engineering thesis, and claims about it
must stay precise. This project has repeatedly caught itself overclaiming
and corrected it. Keep doing that.

**Stack:** Next 16 + `vinext` on Cloudflare Workers · Durable Objects (one
per poker room) · D1/SQLite via Drizzle · React 19 · viem/wagmi + Hardhat
for the escrow contract.

---

## Architecture in one pass

- `worker/table-engine.ts` — pure hold'em rules engine. **No Cloudflare
  APIs**, so it unit-tests in plain Node. Owns betting, side pots, hand
  evaluation, and the `TableProofBundle` receipt + `verifyTableBundle`.
- `worker/poker-table.ts` — the `PokerTable` Durable Object. Owns
  WebSockets, storage, timers. One per room.
- `worker/mental-poker-protocol.ts` — pure phase machine for trustless
  hands (see below). Same purity split as the engine.
- `app/play/mental-poker.ts` — ElGamal card masking on secp256k1
  (Phase 1 crypto core, complete and tested).
- `app/play/table-transport.ts` — browser WebSocket wrapper.
- `db/schema.ts` — D1 schema (users, sessions, tables, hands, clubs, …).

### Hard constraint that shapes everything

Any file importing `db/index.ts` (which does `import { env } from
"cloudflare:workers"`) **cannot be imported by the Node test runner**. That
is why the rules engine and protocol machine are kept pure and framework-
free, and why `worker/poker-table.ts` has no unit tests. Preserve this
split — put logic in the pure modules, I/O in the Durable Object.

---

## The fairness model (three layers — do not conflate them)

**1. Shuffle entropy — provably fair.**
Each player's browser generates a seed. The server commits to its *own*
seed for the next hand (publishing `H(seed)`) **before** collecting any
player seeds, and pins the hand ID at the same moment. Seeds for players
who don't respond are derived deterministically from that commitment —
never freshly rolled. Result: the server cannot re-roll or grind the deck.
`verifyTableBundle` runs 11 checks including `serverCommitment` and
`fallbackSeeds`.

**2. Seed substitution — provable, not just detectable.**
The server signs an acknowledgement of every seed it receives
(`worker/fairness-attestation.ts`, ECDSA P-256), bound to the hand ID, and
hands it to that player. If a receipt later shows a different seed for that
seat, the player holds the operator's own signature contradicting the
operator's own receipt. Public key at `/api/fairness/public-key` — it
should be **pinned**, since an operator free to swap keys could disown its
signatures.

**3. The dealer still sees hole cards — NOT solved by layers 1–2.**
This is the honest limit of a trusted-dealer model, and it is the same
standard PokerNow and similar sites hold. **Never describe the current
server-dealt tables as "trustless" or imply the server can't see cards.**
The correct phrase is *"provably fair shuffle."*

### In progress: trustless heads-up mode

Mental poker, reviving the parked Phase 1 crypto, so the dealer genuinely
cannot see cards. **Backend is complete and tested; UI is not built.**

- The two browsers mask and shuffle the deck in turn under a joint ElGamal
  key. Neither can read a card alone.
- The Durable Object is a **relay**, not a dealer — it holds no key.
- Hole-card partials are forwarded only to the seat that owns the card.
- Board cards unseal **per street**, so a turn partial is refused during
  the flop.
- At showdown the server verifies a claimed hand with no key at all: the
  revealer's partial plus the opponent's already-relayed one decrypt the
  committed ciphertext. A lie fails to decrypt.
- Betting reuses the normal engine. **Key insight:** the engine needs hole
  cards in exactly one place (`bestHandSeats`, at a contested showdown), so
  it can referee betting blind. `deferShowdown` parks the hand in street
  `"showdown"`; `finishShowdown(state, holeCards, board)` completes it.
- **Stall policy:** if a party doesn't complete a protocol step within 45s,
  the hand aborts and **all contributions are returned**. With dealing
  incomplete there is no honest winner, and paying out a staller would make
  stalling a strategy.
- Cost: real curve work in the browser (~300ms/deal on a fast machine, plus
  round trips). Genuinely slower than server-dealt. That's why it's a
  separate mode, not the default.

**Remaining:** trustless UI states in `app/play/table-lab/page.tsx`, a lobby
entry point, `/fairness` copy, live two-tab verification, deploy.

---

## Deployment

Live at playriver.gg + www. Cloudflare account is already authenticated.

```bash
npm run cf:deploy      # preflight + build + deploy
npm run cf:schema      # apply drizzle migrations to remote D1 (idempotent)
```

- Real config lives in **gitignored `.env.deploy`** (see
  `.env.deploy.example`). `CF_D1_DATABASE_ID` must be the real database —
  the original scaffold's placeholder is all-zeroes and binds to *nothing*
  in production while working fine locally.
- Preflight (`tools/deploy/preflight.mjs`) blocks: placeholder D1, missing
  wrangler auth, a non-`local` chain network, and Hardhat's public test key
  as a secret.
- Attaching custom domains **disabled the workers.dev URL** — playriver.gg
  is the only address now.
- Secrets are Worker secrets, not env files: `FAIRNESS_SIGNING_KEY` (set),
  `OPERATOR_PRIVATE_KEY` (deliberately **not** set in production).

---

## Verification — always do all of these

```bash
npx tsc --noEmit
npm test          # 75 tests; also runs the build
npm run lint
```

Chain tests need a local node: `npm run chain:node`, then
`npm run chain:deploy:local`. **Restart the node before redeploying** — an
accumulated-nonce chain deploys the vault to a different address than
`worker/chain-config.ts` expects, and the tests then silently run against
the *old* contract.

**Unit tests are not sufficient in this codebase.** Every serious bug in its
history was found by driving two browser tabs against a running dev server,
not by review or tests: hydration mismatches, Durable Object fields that
silently reverted after hibernation, off-screen layout, orphaned balances, a
React effect that advanced exactly one step and stalled. Drive the real
thing.

---

## Standing rules from the project owner

- **Do not fabricate safety, legal, or fairness claims.** Build ambitious
  money/gambling features, but never overstate what is proven. Where
  something is trust rather than math, say so.
- **Do not remove the disclaimers** on the sibling merch site
  (`tools/duelmerch`) that state it is an independent fan project not
  affiliated with Duel. That is impersonation, not styling.
- Real-money paths stay gated on actual licensing. The escrow contract is
  built and audited, but production has no operator key and
  `ACTIVE_NETWORK` is `"local"`.
- Skip infrastructure/CLI explanations — absorb the plumbing and report on
  the product.
- **Never run a long-lived `next dev` watcher outside the project's own
  `npm run dev`** — file watchers have frozen this machine before.

---

## Known gaps (deliberate, not oversights)

- A compromised `operator` key can drain the escrow vault in one call — no
  per-tx cap, daily limit, or timelock, only `pause`.
- Deposits are credited at confirmation depth 0, so a reorg could leave a
  credited balance behind an un-mined deposit.
- `baseUnitsToChips` truncates; sub-chip dust is stranded in the vault.
- The wallet/deposit UI renders on the live site but cannot work there
  (chain config points at localhost). Honest, but rough.

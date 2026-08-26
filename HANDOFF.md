# RIVER — handoff brief

Everything an assistant needs to pick this project up cold. Current as of
the `24966ca` commit.

---

## What this is

**RIVER** — a live multiplayer poker site at **https://playriver.gg**
(Cloudflare Workers). Test chips only; the real-money path is built but not
switched on (see *Money stack* below).

The differentiator is **provable fairness**, and that is an engineering
claim, not a marketing one. This project has repeatedly caught itself
overclaiming and corrected it. Keep that habit: where something is trust
rather than math, say so.

**Stack:** Next 16 + `vinext` on Cloudflare Workers · Durable Objects (one
per room) · D1/SQLite via Drizzle · React 19 · viem/wagmi + Hardhat.

---

## Architecture

- `worker/table-engine.ts` — pure hold'em rules. **No Cloudflare APIs**, so
  it unit-tests in plain Node. Betting, side pots, hand evaluation,
  `TableProofBundle` + `verifyTableBundle` (11 checks).
- `worker/poker-table.ts` — the `PokerTable` Durable Object (~1,500 lines).
  WebSockets, storage, timers, and the trustless relay.
- `worker/mental-poker-protocol.ts` — pure phase machine for trustless
  hands, plus `buildMentalPokerBundle`.
- `worker/fairness-attestation.ts` — ECDSA P-256 signed seed receipts.
- `app/play/mental-poker.ts` — ElGamal masking on secp256k1 (the crypto
  core; complete, 15 verifier checks).
- `app/play/mental-poker-client.ts` — browser protocol driver.
- `worker/chain.ts` + `contracts/` — escrow contract and on-chain plumbing.

### Hard constraint

Any file importing `db/index.ts` (which does `import { env } from
"cloudflare:workers"`) **cannot be imported by the Node test runner.** That
is why the engine and protocol machine are pure and framework-free, and why
the Durable Object has no unit tests. Keep logic in the pure modules and I/O
in the DO — this split is what makes the project testable at all.

---

## The fairness model — three distinct layers, do not conflate

**1. Shuffle entropy (server-dealt tables) — provably fair.**
Each browser generates a seed. The server commits to its own seed for the
*next* hand (publishing `H(seed)`) **before** collecting player seeds, and
pins the hand ID at the same moment. A player who doesn't respond gets a
seed derived deterministically from that commitment, never a fresh roll.
The server therefore cannot grind the deck. Verified by `serverCommitment`
and `fallbackSeeds` in `verifyTableBundle`.

**2. Seed substitution — provable, not merely detectable.**
The server signs every seed it receives, bound to the hand ID, and gives
that signature to the player. A receipt showing a different seed contradicts
a signature the operator cannot disown. Public key at
`/api/fairness/public-key` — it should be **pinned**, since an operator free
to rotate keys could disown its own signatures.

**3. The dealer sees hole cards — true on server-dealt tables ONLY.**
Layers 1 and 2 do not touch this. **Never call server-dealt tables
"trustless" or imply the server can't see cards.** The correct phrase is
*"provably fair shuffle."*

### Trustless heads-up tables — shipped and live

Mental poker. The dealer genuinely cannot see cards.

- Both browsers mask and shuffle the deck under a joint ElGamal key.
- The Durable Object is a **relay** holding no key. Hole-card partials are
  forwarded only to the seat that owns the card.
- Board cards unseal **per street** — a turn partial is refused during the
  flop, otherwise either party could read ahead.
- At showdown the server verifies a claimed hand **with no key**: the
  revealer's partial plus the opponent's already-relayed one decrypt the
  committed ciphertext. A lie fails to decrypt.
- Betting reuses the normal engine. It needs hole cards in exactly one place
  (`bestHandSeats`, contested showdown), so it referees blind.
  `deferShowdown` parks the hand in street `"showdown"`;
  `finishShowdown(state, holeCards, board)` completes it.
- **Stall policy:** 45s per protocol step, then the hand aborts and **all
  contributions are returned**. With dealing incomplete there is no honest
  winner, and paying a staller would make stalling a strategy.
- Cost: real curve work in-browser, noticeably slower than server-dealt.
  That is why it is a separate mode, heads-up only.

**Three bugs were found here by live stall testing, not by unit tests** —
all interactions between the engine's street advance, the single DO alarm,
and the phase machine: betting accepted on a sealed street; the action clock
armed against undealt cards; and an action alarm overwriting the protocol
stall deadline. If you touch this area, re-run a live stall test.

---

## Money stack — built, deliberately not switched on

This is the part most likely to be misread, so precisely:

**What exists and works:** `contracts/contracts/EscrowVault.sol` — a pooled
custody vault (OpenZeppelin `Ownable`/`Pausable`/`ReentrancyGuard`,
`SafeERC20`), with `usedRefIds` replay protection so a given ledger entry
can never be paid twice. Wallet linking via signed challenge (EOA +
ERC-1271). Deposit confirmation with idempotency keyed on tx hash.
Withdrawals with a 1% fee (`WITHDRAWAL_FEE_BPS = 100`) and a per-withdrawal
gross/net choice. 14 Solidity tests, plus JS integration tests against a
local Hardhat chain.

**What is NOT switched on:**
- `ACTIVE_NETWORK = "local"` in `worker/chain-config.ts` — points at
  `127.0.0.1:8545`. The `BASE` config holds deliberate placeholders.
- No `OPERATOR_PRIVATE_KEY` secret is set in production, so
  `/api/wallet/withdraw-request` returns a clean 503.
- Consequence: the wallet/deposit UI renders on the live site but cannot
  function. Honest, but it looks broken — hide or label it before showing
  the site to anyone.

**Withdrawal limits (added; bound a leaked hot key):** the vault takes
`maxWithdrawalPerTx` and `dailyWithdrawalLimit` as constructor arguments
(base units; 0 disables), enforced in `withdraw`, adjustable only by the
`owner` — so a compromised operator cannot raise its own ceiling.
`remainingDailyAllowance()` reports headroom. The daily window is FIXED, not
sliding: an attacker timing a drain across a boundary can move up to twice
the limit. That is deliberate — the goal is to bound the loss and buy time
to `pause`, not to make theft impossible. `deploy.ts` refuses to deploy to a
real network with either limit disabled.

**Deposit finality (added):** `minConfirmations` per network (0 local, 12 on
Base). `verifyDepositTx` checks depth against the chain head and refuses to
credit until it is met, so a reorg cannot leave a credited balance behind an
un-mined deposit.

**Known gaps in the money path (real, unfixed):**
- `baseUnitsToChips` truncates; a deposit that is not a whole number of
  chips credits the floor and strands the remainder in the vault. It is
  auditable — `onchainTransactions.tokenBaseUnits` records the exact amount
  received, so the dust is derivable per row — but it is not credited back.
  The deposit UI only ever sends whole chips, so this needs a direct
  transfer to trigger.
- No timelock on `setOperator`/`setLimits`: a compromised OWNER key is
  still total loss. The owner is meant to be a cold key held offline.

**Non-technical gate:** operating real-money gambling requires actual
gambling and money-transmitter licensing in the relevant jurisdictions.
That is a legal process with regulators, not a code change, and no
assistant can supply it. Treat any claim that it's unnecessary as false.

---

## Deployment

```bash
npm run cf:deploy   # preflight + build + deploy
npm run cf:schema   # apply drizzle migrations to remote D1 (idempotent)
```

- Real config in **gitignored `.env.deploy`** (see `.env.deploy.example`).
  `CF_D1_DATABASE_ID` must be the real database — the original scaffold's
  placeholder is all-zeroes and binds to **nothing** in production while
  working fine locally.
- Preflight blocks: placeholder D1, missing wrangler auth, a non-`local`
  chain network, and Hardhat's public test key as a secret.
- Attaching custom domains disabled the workers.dev URL. playriver.gg is the
  only address.
- Worker secrets (not env files): `FAIRNESS_SIGNING_KEY` (set),
  `OPERATOR_PRIVATE_KEY` (deliberately unset).

---

## Verification — do all of these

```bash
npx tsc --noEmit
npm test        # 75 tests; also runs the build
npm run lint
```

Chain tests need `npm run chain:node` then `npm run chain:deploy:local`.
**Restart the node before redeploying** — an accumulated-nonce chain
deploys the vault to a different address than `chain-config.ts` expects, and
tests then silently run against the *old* contract.

**Unit tests are not sufficient here.** Every serious bug in this project's
history came from driving two browser tabs against a running server:
hydration mismatches, DO fields that silently reverted after hibernation,
a React effect that advanced one step and stalled, and all three trustless
timing bugs. Drive the real thing.

---

## Standing rules from the owner

- **Do not fabricate safety, legal, or fairness claims.** Build ambitious
  features; never overstate what is proven.
- **Do not remove the disclaimers** on the sibling merch site
  (`tools/duelmerch`) stating it is an independent fan project unaffiliated
  with Duel. That is impersonation, not styling.
- Skip infrastructure/CLI explanations — absorb the plumbing, report on the
  product.
- Never run a long-lived file watcher outside `npm run dev` — that has
  frozen this machine before.

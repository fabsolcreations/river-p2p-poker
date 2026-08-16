# RIVER

RIVER is a real multiplayer poker product: a Cloudflare Durable Object
deals every hand server-side over WebSockets, real accounts hold a
persistent bankroll in D1, and every hand produces an independently
verifiable, hash-chained proof receipt. Money today is test chips
everywhere — no real-value path is live yet (see below).

## What's actually live

- Real accounts: password auth (PBKDF2 + signed session cookies) and a
  persistent bankroll (`users.balance` in D1) that survives across
  sessions and tables.
- Real multiplayer tables: 2–10 seats, real no-limit betting (variable
  sizing, min-raise, unlimited re-raising, all-in-for-less), multi-way
  side pots.
- Provably fair dealing: every seat's own browser contributes randomness
  to the shuffle via commit-reveal before the hand deals, so the server
  can't unilaterally choose a favorable deck. Every hand produces a
  hash-chained transcript and a `TableProofBundle`, independently
  re-verifiable via `verifyTableBundle`.
- A lobby of real open rooms, hand history, and stats.
- Table chat and peer-to-peer voice chat.
- Host-configurable blinds/buy-in range, PokerNow-style spectate/sit-down,
  and rabbit hunting.
- A real on-chain escrow contract (`contracts/contracts/EscrowVault.sol`) —
  built, unit-tested, and verified end-to-end against a local test chain
  (deposit, operator-authorized withdrawal, fee on withdrawal). **Not
  deployed anywhere real funds could reach** — see below.

## Real-money status

Every balance is a test chip. The on-chain escrow contract above is real
code, not a mockup, but it isn't deployed to any network where it could
hold real value, and there's no real payment path live. Operating
custodial real-money gambling for the public requires actual gambling and
money-transmitter licensing — that's the remaining gate, not a technical
one.

## Also in the repo, kept separate on purpose

`/play` and `/play/deal-lab` are an earlier research prototype: two-party
mental poker via ElGamal card masking, so no single party — not even a
server — needs to see a card before it's dealt. It works and is tested,
but it isn't the live product's dealing model; the tables above use a
conventional trusted-server dealer instead, which is what actually shipped.

## Run locally

```bash
npm install
npm run dev
```

Quality checks:

```bash
npm run lint
npx tsc --noEmit
npm test               # build + the full app test suite
npm run chain:test     # contracts/ - Solidity unit tests, own toolchain
```

The wallet's deposit/withdraw flow needs a local chain to talk to:

```bash
npm run chain:node          # separate terminal - a local Hardhat node
npm run chain:deploy:local  # deploys MockUSDC + EscrowVault to it
```

Copy `.dev.vars.example` to `.dev.vars` and fill in `OPERATOR_PRIVATE_KEY`
(a throwaway local test key is fine — see the file's own comment) before
withdrawals will work locally; deposits and wallet linking work without it.

The production target is vinext on Cloudflare through Sites. Project
metadata and optional bindings live in `.openai/hosting.json`.

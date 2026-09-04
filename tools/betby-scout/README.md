# Betby Scout

Analytics for BETBY-powered sportsbooks. It ingests the public bets feed and
odds that your already-logged-in browser receives, stores everything
historically, and — as later milestones land — ranks candidate +EV bets for you
to review by hand.

**Duel is the first supported book. Everything sportsbook-specific lives in
`src/adapters/`, so adding the next BETBY site is one file.**

## What it does not do

- **It never places a bet.** No code path submits a wager, touches the betslip,
  or clicks a confirm control. It analyses and alerts; you act.
- **It never bypasses anything.** No auth bypass, no captcha solving, no
  rate-limit evasion, no automated login, no stored credentials. It reads
  responses the page already received and originates zero requests to the
  sportsbook.
- **It never invents data.** A field it cannot parse is `null` with a warning
  attached. An estimate is labelled an estimate. The words "lock",
  "guaranteed" and "free money" are not in its vocabulary, and there is a test
  that fails if they appear.

One thing worth stating plainly: reading a sportsbook's community feed at volume
may be against that site's terms of service, even though nothing here breaks a
security control. That is your call to make, not something this tool settles for
you.

## Run it

```bash
cd tools/betby-scout && npm install && npm run dev
```

- Dashboard: <http://127.0.0.1:5273>
- API + WebSocket: <http://127.0.0.1:8787>
- Database: `data/scout.db` (SQLite via Node's built-in `node:sqlite` — no
  native build step)

Everything binds to loopback. Then install the collector — see
[docs/INSTALL.md](docs/INSTALL.md) for the click-by-click, including what to do
on the site once it is running.

```bash
npm run build      # collector + dashboard + server
npm test           # 87 tests
npm run typecheck
```

### Exercising the collector without a sportsbook

```bash
npm run build:collector && node harness/serve.mjs   # then open http://127.0.0.1:8790
```

A local page that loads the real built collector and fires fetch, XHR and
WebSocket traffic at it, so the whole path — hook, ring, classifier, redactor,
uploader, server, dashboard — runs end to end against fixtures instead of a live
book. Its fixtures are **invented shapes**, clearly labelled as such on the page;
a classification there says nothing about how real BETBY traffic will classify.

It exists because it caught four integration bugs that every unit test passed
straight through — the two sides of an interface can each be internally
consistent and still disagree with each other. Use it before and after touching
anything in `src/collector/`.

## How it works

```
 sportsbook page
   ├─ hook.js  (MAIN world)  ── wraps fetch / XHR / WebSocket / EventSource
   │                            redacts, classifies, buffers in a bounded ring
   │                            renders the floating debug panel
   └─ content.js (ISOLATED)  ── bridge to the extension only
                │
                │  WebSocket, HTTP POST fallback
                ▼
        server (Fastify, 8787)  ──  SQLite, append-only
                │
                ▼
        dashboard (React, 5273)
```

### The rule that shapes everything

**We do not know BETBY's API.** Not the endpoint paths, not the hostnames, not
the field names. So nothing in this codebase branches on a guessed URL.

Classification is done on payload **structure**: how many objects are in the
biggest array, what fraction carry a number in the decimal-odds band, whether
there are many distinct masked handles or only one. Field *reading* tries a long
list of spellings case- and separator-insensitively, so `odds`, `price`,
`coefficient` and `koef` all resolve.

The most important discriminator is embarrassingly simple and works without
knowing anything about BETBY: **a public feed shows many different bettors; a
personal bet history shows one.** That single signal separates `bets_feed` from
`user_bets`, and it is the reason the classifier can find the feed at all before
anyone has seen a real payload.

Host names are an **output** of discovery (`/api/hosts`, the Frames page), never
an input. When the classifier is unsure it says so: confidence below 0.55 renders
as a guess, with the reasons it did and did not find spelled out. "Unknown, and
here is exactly what I looked for" is a successful result at this stage.

### Redaction

Runs **in the page**, before anything is stored or uploaded — because the export
button exists to send captures to someone else. It drops `Authorization` and
`Cookie` headers, and masks JWTs, emails, long opaque tokens and wallet
addresses in bodies, query strings and headers, including camelCase keys like
`accessToken`. It deliberately leaves odds, stakes, timestamps and masked
handles alone, since destroying those would make the tool useless.

It reduces exposure; it is not a guarantee. Skim an export before sharing it.

### Storage

Append-only where it counts. `odds_snapshots` and `feed_bet_status_history` are
never rewritten — a resettlement is a new row, not an edit. That is what makes
closing-line value computable after the fact, and it is the only real defence
against quietly revising history so a signal looks better than it was. Retention
defaults to **forever**.

## Status

**Milestone 1 is complete: instrumentation.** The tool can capture, classify,
store, and display real traffic. It has not yet seen any.

| | |
|---|---|
| ✅ M1 | Project structure, collector, debug panel, server, live dashboard |
| ⬜ M2 | **Capture real Duel/BETBY feed data** ← next, and it needs you in a browser |
| ⬜ M3 | Normalize bets/events/markets into the schema (tables already exist) |
| ⬜ M4–M5 | Realtime opportunity dashboard, odds history and line movement |
| ⬜ M6–M7 | Bettor tracking, sharpness score |
| ⬜ M8 | Signal engine |
| ⬜ M9 | Backtesting |
| ⬜ M10 | Draggable overlay on Duel |

The dashboard lists the unbuilt sections in its nav as disabled, labelled with
the milestone that delivers them. There is no sample data anywhere — a screen
with nothing in it says what is missing and what to do about it.

### Why M2 needs you

Every fixture in `tests/adapters.test.ts` is an **invented shape**, and the file
says so at the top. They prove the scoring machinery reasons correctly about
structure. They do not prove it will read real BETBY traffic, and no amount of
work at this desk can change that.

Run the collector on Duel, click **Export raw capture**, and send the NDJSON
back. Then the field names become real, `src/adapters/betby/duel.ts` stops being
an empty override point, and the fixtures get replaced with captures that mean
something.

## Design philosophy

The goal is not "find bets that won recently" — it is "find repeatable signals
that predict better-than-market prices." So the analytics that follow are built
to be sceptical of themselves:

- **Closing line value** is treated as the strongest evidence a strategy holds
  information, ahead of realised profit.
- **Win rate is never used alone.** `wilsonInterval()` exists so that a 3-for-3
  bettor renders as "44%–100%", not "100%".
- **De-vig is honest about its own bias.** Proportional removal overstates
  longshot fair value — exactly the direction that manufactures fake +EV — so
  `fairProbabilitiesShin()` is implemented alongside it and there is a test
  asserting Shin puts the longshot *below* proportional. `evWarnings()` attaches
  the structural caveats to any EV number.
- **Small samples are labelled.** `samplesForSignificance()` says how many bets
  an edge needs before it is distinguishable from noise. It is usually a
  humbling number.
- **Backtesting (M9) exists to disprove signals**, not to advertise them.

## Layout

```
src/shared/       types, deterministic ids, odds math, redaction, shape analysis
src/adapters/     the only place a sportsbook name appears in logic
src/collector/    MAIN-world hook, debug panel, MV3 extension, userscript
src/server/       Fastify, node:sqlite, WebSocket fan-out
src/dashboard/    React + Vite + Tailwind + Recharts
tests/            84 tests, node:test
```

`CONTRACT.md` is the binding spec every module builds against. Read it before
changing anything structural.

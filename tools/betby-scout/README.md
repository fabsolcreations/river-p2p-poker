# Betby Scout

Analytics for BETBY-powered sportsbooks. It ingests the public bets feed and the
odds your browser already receives, stores everything historically, and — as
later milestones land — ranks candidate +EV bets for you to review by hand.

On Duel the feed turns out to be a **public** endpoint: no login required to
watch what other people are betting.

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
npm test           # 197 tests
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

**Nothing branches on a guessed URL.** We now know a great deal about Duel's
BETBY API — but every bit of it was *observed and written down with a date*, and
it is confined to `duel.ts` where it only ever raises confidence in a verdict the
shape analysis already reached. The generic layer still assumes it knows nothing,
because the next BETBY book will differ and a guess that happens to be right
today is still a guess.

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

Parsed captures become rows in `events`, `markets`, `selections`,
`odds_snapshots`, `bettors`, `feed_bets` and `feed_bet_legs`. Three properties
make that history trustworthy, and each has a test:

- **Idempotent.** The feed is polled every few seconds and returns the same 50
  rows. Re-ingesting an identical poll writes *nothing* — otherwise every stake
  and every sample count would inflate without bound.
- **First-seen wins.** A bet's timestamp is when we first observed it and never
  moves, because BETBY's feed carries no time of its own.
- **Prices are stored on change, not on observation.** "Never discard historical
  odds" means keeping every move; a row per poll per selection would add millions
  of identical rows a day and bury the few that matter.

Append-only where it counts. `odds_snapshots` and `feed_bet_status_history` are
never rewritten — a resettlement is a new row, not an edit. That is what makes
closing-line value computable after the fact, and it is the only real defence
against quietly revising history so a signal looks better than it was. Retention
defaults to **forever**.

## Status

**Milestones 1 through 5 are complete.** The tool captures, classifies, stores
and analyses real traffic from Duel's live sportsbook.

| | |
|---|---|
| ✅ M1 | Project structure, collector, debug panel, server, live dashboard |
| ✅ M2 | **Duel's BETBY API reverse-engineered from real traffic** — see below |
| ✅ M3 | Feed legs named, and normalized rows persisted with odds history |
| ✅ M4–M5 | Margin measurement, line movement, closing-line value |
| ✅ M6–M7 | Bettor profiles and a sharpness score built on closing line value |
| ✅ M8a | Independent price source, consensus fair value, and real +EV edges |
| ⬜ M8 | Signal engine |
| ⬜ M9 | Backtesting |
| ⬜ M10 | Draggable overlay on Duel |

The dashboard lists the unbuilt sections in its nav as disabled, labelled with
the milestone that delivers them. There is no sample data anywhere — a screen
with nothing in it says what is missing and what to do about it.

### What Duel's BETBY actually looks like

Captured 2026-09-04 from `https://duel.com/sports`, logged out, by observing
what the page itself requested. Real responses are checked in under
`tests/fixtures/` and `tests/duel.test.ts` runs against them.

- **Duel proxies BETBY under its own domain**: `sports-proxy.duel.com`. There is
  no cross-origin sportsbook iframe — the only frames on the page are
  Cookiebot's. A userscript on `duel.com` is therefore sufficient.
- **The bets feed is public**: `/api/v1/promo/bets_feed/brand/{brand}` answers
  200 with 50 rows to a plain `curl`. No cookie, no token, no account.
- **A feed row looks like this**, and every field name here was observed:

  ```json
  { "id": "31909500350537", "odds": "2.130", "stake": "5.00 $",
    "pot_win": "10.65 $", "player": "****707", "type": "combo",
    "selections": [ { "event_id": "2704263723815669762", "market_id": "68",
                      "outcome_id": "12", "specifiers": "total=0.5", "k": "1.5" } ] }
  ```

  Numbers are strings; `stake` and `pot_win` carry a currency *symbol* (`$`,
  `€`, `₹`), the line hides inside `specifiers`, leg odds are `k`, and **there is
  no timestamp anywhere** — ordering has to come from observation time.
- Live prices arrive over `wss://sports-proxy.duel.com/api/v1/ws_new`, and the
  prematch/live trees are long-polled with an incrementing cursor.
- Event, market and outcome are **ids only**. Names live in
  `/api/v3/descriptions/.../markets/{lang}` and the prematch/live trees, and
  Scout now joins them automatically — see below.

On that captured sample the classifier returns `bets_feed` at **0.97**, and the
reason it gives is the one that generalises to any BETBY book: *35 distinct
masked handles across 50 rows* — a public feed, not one account's history.

### Naming a leg

A feed row names nothing: market 68, outcome 12, `total=0.5`, event
2704263723815669762. The names come from two other payloads the page also
fetches, so Scout watches for them, keeps them, and joins:

```
Soccer | LaLiga · Real Betis Seville vs Real Madrid
  1x2 → Real Madrid @ 1.46
American Football | NCAA · Oklahoma Sooners vs UTEP Miners
  Handicap (incl. overtime) → Oklahoma Sooners (-37.5) @ 1.63  (now 1.64)
```

That "(now 1.64)" is the event tree's current price for the same selection — the
first hint of closing-line value the tool can compute, and it comes free with
the join.

Outcome names are templates (`over {total}`, `{$competitor1}`, `{!setnr} set
game {gamenr}`) — seven forms across 2111 markets, all rendered by
`dictionary.ts`. A token that cannot be resolved is **left visible** rather than
blanked, so a gap looks like a gap instead of a plausible name. Coverage depends
on what has been captured: `/api/refs` reports exactly what the dictionaries
hold, and an unnamed leg says so in the parse warnings.

`duel.ts` records the observed endpoints, but only to **raise confidence in a
verdict the shape analysis already reached**. Move the endpoint and the tool
still finds the feed; put an unexpected payload on a known path and it keeps the
shape verdict and says the endpoint may have changed. There is a test for each.

## What one book can honestly tell you

Scout has prices from a single sportsbook, and that decides what it may claim.
De-vigging Duel's market gives a fair price derived from Duel's own numbers, and
betting that back into Duel returns

```
EV = p * d - 1 = (1/d)/overround * d - 1 = 1/overround - 1
```

which is **minus the margin** - identical for every outcome, never zero, never
positive. On a 1.90/1.90 market it is -5%. That is arithmetic, not a limitation
to engineer around, and `isEdgeClaimable()` enforces it in code rather than in a
comment: an edge may only be claimed against a fair value from an independent
source, and there is none yet.

So the analysis layer reports what is genuinely measurable from one book:

- **Margins** - the overround per market, by sport and by market type. Real,
  directly measured, and comparable. On the captured sample Duel prices soccer
  at a 3.3% median margin over 115 markets and rugby union at 8.9% over 12.
- **Line movement** - a price against its own past, measured in implied
  probability points because an odds ratio ranks 1.10 to 1.05 the same as 11.00
  to 10.50 when the first is ten times the move.
- **Closing line value** - the last price before kickoff versus the price taken.
  The strongest evidence available that a bettor or signal holds information.

The movement thresholds are **uncalibrated**, which the UI says out loud. A row
labelled "steam" means a price moved quickly; whether that carries information
is what Milestone 9 exists to find out.

### The feed reports no results

Duel's feed rows carry `id, odds, stake, pot_win, player, type, selections` and
**no status field**. A bet appears and, as far as the feed is concerned, never
resolves. So wins, losses, ROI and profit are not "not yet computed" — they are
not obtainable from this source at all, and nothing in Scout reports them.

Closing line value survives, because it needs only the price taken and the price
at kickoff, both of which are recorded. So a bettor is scored on **price-taking**
and the score says so. It refuses to exist below 30 measurable legs — returning
the specific blockers instead of a small number dressed up as a rating — and an
observed CLV is shrunk toward zero by `n/(n+30)` so a short hot streak cannot
manufacture a rating. Confidence is reported separately from the score, so a
high number on a thin record cannot pass for a strong one.

## Getting real edges: add a second price source

Everything above measures Duel against itself, which by arithmetic can never
show an edge. One independent source changes that.

1. Get a free key at <https://the-odds-api.com> — 500 credits a month, no card.
2. Set it before starting the server:

```bash
ODDS_API_KEY=your_key npm start
```

3. Check `/api/edges/status`, then read the **Edges** data at `/api/edges`.

Optional: `ODDS_API_REGIONS` (default `eu`) and `ODDS_API_MARKETS` (default
`h2h`). Leave them alone unless you know why — a request costs
`markets × regions` credits, so asking for three regions triples the burn for
prices that mostly agree.

**Budget discipline.** 500 credits a month is about 16 a day, so Scout never
polls. It fetches only when asked, caches every response for 30 minutes, and
reports `x-requests-remaining` so you can see what is left rather than
discovering the limit by hitting it.

**How an edge is computed**, and what it refuses:

- Each external book is de-vigged **separately**, then the fair probabilities
  are combined by **median**. Averaging raw prices first would leave every
  book's margin baked into the "fair" number.
- **Duel is excluded** from the consensus it is judged against. A book cannot
  help price itself, and the circularity would be invisible in the output.
- Fewer than **three** independent books → refused. Below three the median has
  no resistance to one bad price, which is the only reason to use one.
- Stale quotes (older than 6h) are dropped and the drop is reported.
- An **unmapped league is refused, never guessed.** Matching "LaLiga" to a
  second-division key by string similarity would produce a large and entirely
  fictional edge.
- **Fixture matching is the most dangerous step in the project**, because a
  wrong match yields a number that is arithmetically perfect and complete
  nonsense. Both teams must match, kickoffs must agree within two hours, and two
  equally plausible fixtures are refused rather than guessed between. Every edge
  carries its match confidence and the reasoning so you can check it.
- An edge above 15% flags itself as suspicious, because at that size a bad match
  is more likely than an opportunity.

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

# Duel Live Verifier v3.2

A userscript that captures settled Duel bets and independently recomputes their
provably-fair results in your browser. It never claims a bet is *verified* when all it
did was recompute something nobody cross-checked — COMPUTED and MATCHED stay separate.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Dashboard → **+** → paste [`duel-live-verifier.user.js`](duel-live-verifier.user.js) → Ctrl+S.
3. Open duel.com. The panel appears on the left; it starts recording as soon as bets settle.

## What changed from v2.7

**Capture moved from the DOM to the network layer.** v2.7 located fields by matching
rendered labels (`"Client seed"`, `"Nonce"`), which only exist in English — Duel ships
~20 locales — and recovered CSS-truncated hashes by guessing at ordered `[seed][hex64][int]`
runs. v3 hooks `fetch` and `XMLHttpRequest`, walks any JSON body from an `/api/` request,
and keeps objects carrying a usable fairness tuple. Locale-proof, truncation-proof, and it
sees fields the modal never renders.

**The engines are real.** v2.7 refused to compute anything (`supported: false`), which was
the honest answer at the time. v3 implements the actual algorithms for:

| Game | Inputs | Output |
| --- | --- | --- |
| Dice | client seed, server seed, nonce | 0.00–100.00 |
| Limbo | client seed, server seed, nonce | multiplier ≥ 1 |
| Plinko | + rows | bucket index |
| Mines | + mine count, grid size | sorted mine positions |
| Beef (cross road) | + death points, grid size | sorted death positions |
| Keno | client seed, server seed, nonce | 10 numbers, **draw order** |
| Blackjack | + cursor | card sequence (infinite deck) |
| Video poker | client seed, server seed, nonce | shuffled deck → 5 + 5 |
| Crash | server seed, drand randomness | multiplier ≥ 1 |
| Coinflip | server seed, drand randomness | 1 Crown / 2 Swords |
| Castle roulette | server seed, drand randomness | 0–47 |

## Result fields are per game, not sniffed

A generic sweep for `result`/`multiplier`/`value` picks up wagers, payouts and cashouts.
Comparing against those produces confident nonsense: a crash bet's `multiplier` is the
player's cashout, which is **below** the crash point by definition, so every won bet would
report MISMATCHED. Each game therefore has an explicit key list with a type check, and the
key that supplied the number is recorded in `reportedFrom` (and in the CSV).

Where a field is ambiguous — limbo's `multiplier`, coinflip's `side` — no comparison is made
and the bet stays COMPUTED. Better a gap than a false accusation. Feed a real payload through
`window.DuelLiveVerifier.state()`, find the true result key, add it to `RESULT_KEYS`.

## Units differ between the API and the algorithm

Dice is computed as `0.00–100.00` and displayed that way on Duel's own Verify page, but the
API reports it as **basis points**: a roll of `8.21` comes back as `821`. A naive numeric
comparison turns that into a MISMATCHED accusation against an honest bet — which is exactly
what v3.1 did to bet #749774 before this was fixed.

Numeric comparisons therefore accept either reading (and, for crash, the 2dp-truncated form),
and record which one fitted in `reportedScale`. A genuinely wrong result still fails: none of
the accepted forms will line up.

## The detail that breaks reimplementations

The HMAC key is the server seed **decoded from hex to raw bytes**, not the 64-character hex
string:

```js
crypto.subtle.importKey('raw', hexToBytes(serverSeed), { name: 'HMAC', hash: 'SHA-256' }, ...)
```

Key it with the hex text instead and every honest round reads as a mismatch. The test suite
asserts both forms and that they differ, so this can't silently regress.

Drand games (crash, coinflip, roulette) hash `${hexToUtf8(drandRandomness)}:0` — the
randomness is hex-*decoded to text* first, then interpolated.

## Tests

```bash
node tools/duel-live-verifier/engines.test.cjs
```

27 checks, including a real captured bet (#749774) whose result is pinned to what duel.com's
own Verify page renders for the same inputs. The interesting ones are differential: the test resolves Duel's current asset
hashes from duel.com, downloads `blackjackFairness-*.js` and `videoPokerFairness-*.js` into
`.vendor/` (gitignored), imports them, and asserts our output is byte-identical to theirs
across randomised inputs for eight games. Crash/coinflip/roulette live inside a Vue chunk
that can't be imported, so those are guarded by asserting the constants we transcribed
(0.1% edge, `% 2 + 1`, range 48) are still what duel.com ships.

If Duel changes an algorithm, this test fails — that's the point. It already caught one bug
during development: keno returns numbers in **draw order** while mines and beef sort theirs.

Without network the vendor comparison reports SKIPPED rather than passing.

## Mock harness

To exercise capture without a duel.com session:

```bash
python -m http.server 5601 --directory tools/duel-live-verifier
```

Then open <http://localhost:5601/mock/index.html> and click either button. The fixture
contains a correct dice bet, a dice bet with a deliberately wrong result, and a crash bet —
they should land as MATCHED / MISMATCHED / MATCHED. The fixture deliberately reports dice in
basis points and carries decoy `value` and `multiplier` fields, so it exercises both traps.

## Honest limits

- **Field names are inferred** from Duel's fairness UI and verify page, not from API docs.
  The scan is shape-agnostic and looks for aliases (`client_seed`/`clientSeed`, etc.), but
  if a payload uses a name not in the alias table the bet is skipped rather than guessed at.
  `window.DuelLiveVerifier.state()` shows the raw captured node so you can extend the list.
- **MATCHED requires a comparable result in the payload.** If the response carries no result
  field, the bet stays COMPUTED — recomputation alone proves nothing about what you were paid.
- **Blackjack and video poker are computed, not compared.** Mapping a card sequence onto a
  played hand (splits, hits, dealer draws) isn't implemented, so those stay COMPUTED.
- **The server-seed commitment preimage is unstated by Duel.** Both SHA-256 of the hex string
  and of the raw bytes are tried, and whichever matched is recorded. Only if *neither* matches
  is it reported as a mismatch.
- Crash comparison truncates to 2dp, matching how the multiplier is displayed.
- The panel remembers where you dragged it. Drag handling is bound to the panel element, not
  the header, because `render()` replaces the panel's inner HTML on every capture — anything
  bound to the header stops working the moment the first bet lands.

## Observed in live sessions

- **Commitment preimage.** Across ~2,650 captured bets every commitment resolved the same way:
  Duel's published server-seed hash is **SHA-256 of the raw seed bytes**, not of the hex
  string. Both are still tried, in case that changes.
- **Dice is reported in basis points** (`821` for a roll of `8.21`). See above.
- **Video poker stays COMPUTED** — the payload carries no field that represents the shuffled
  deck, so there is nothing to compare the computed cards against.
- A small number of captures come back as game `unknown`: a fairness tuple was present but
  nothing identified the game. They are recorded rather than dropped; check `raw` via
  `window.DuelLiveVerifier.state()` and add a pattern to `GAME_PATTERNS` if it matters.

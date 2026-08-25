# PokerNow Panel (Tampermonkey)

A single-file userscript that overlays a live equity / hand-strength / suggested-action
panel on a PokerNow table — the same idea as the panel in the screenshot, but the maths
runs locally in your browser and nothing is sent anywhere.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome/Edge/Firefox).
2. Tampermonkey → Dashboard → **+** (new script) → paste the contents of
   [`pokernow-panel.user.js`](pokernow-panel.user.js) → Ctrl+S.
3. Open any `pokernow.club` table. The panel appears top-right.

Or drag the `.user.js` file onto the Tampermonkey dashboard.

## What it shows

| Row | Meaning |
| --- | --- |
| `Hand: …` | your current made hand (preflop: the `AKs`-style label) |
| cards line | your hole cards + the board, as read from the DOM |
| meta line | hand label · SPR · MDF · pot · amount to call · your position |
| ⚠ warnings | trips/paired board, flush possible, straight possible, playing the board |
| Win / Equity | Monte Carlo vs N random opponent hands (equity = win + share of ties) |
| Pot odds | `toCall / (pot + toCall)` — the number your equity has to beat |
| `Action:` | FOLD / CHECK / CALL / BET / RAISE plus a one-line reason |
| notes | draws and outs, SPR advice, position, opponent count |
| bottom grid | probability your final 7-card hand ends in each category by the river |

Controls: drag the header to move it, `NORMAL` cycles TIGHT → NORMAL → LOOSE (changes the
call/fold margins and whether it semi-bluffs), `–` collapses, **Ctrl+Shift+P** hides it,
`debug` in the footer logs every scrape to the console. Position and settings persist in
`localStorage`.

## How it works

- **Engine** — a 7-card evaluator (bit-mask straights, per-suit flush masks, base-14 packed
  kickers) plus a partial Fisher–Yates Monte Carlo. Opponents are modelled as *random*
  hands, so equity is a range-free estimate: it is the honest number heads-up and against
  loose fields, and optimistic against tight players who only continue with strong hands.
- **Scraper** — everything DOM-specific lives in the `SEL` object near the top of the
  browser half of the file. If PokerNow changes markup, that's the only block to patch.
  Card reading falls back to a regex over the element text, so minor changes usually
  survive.
- Simulation count auto-scales (`40000 / (opponents + 1)`, capped by `cfg.sims = 6000`) and
  results are cached per game state, so it only re-runs when the hand actually changes.

## Tests

```bash
node tools/pokernow-panel/engine.test.cjs
```

38 checks: hand naming and ordering (incl. wheel, no wrap-around straights, best-5-of-7),
draw/outs detection, board texture, Chen scores, and Monte Carlo values against known
equities (AA heads-up 85.2%, 72o 35.2%, AKs six-way ~29%).

There is also a mock table for working on the UI without sitting in a real game:

```bash
python -m http.server 5599 --directory tools/pokernow-panel
```

then open <http://localhost:5599/mock-table.html>.

## Caveats

- Opponents are random hands, not ranges — treat Win% as an upper-ish bound in tight games.
- Pot is read from the pot chip plus visible bets; if PokerNow renames those elements the
  pot-odds line goes stale before the equity line does. Turn on `debug` to see what it read.
- Real-time assistance is against the rules of many poker games and clubs, PokerNow's
  own terms included. That's between you and whoever runs your table.

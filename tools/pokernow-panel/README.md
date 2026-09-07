# PokerNow Panel v2.0

One Tampermonkey script for PokerNow: live equity and advice, an opponent HUD built from the
table log, hand history, and export. Everything runs in your browser; nothing is sent anywhere.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Dashboard → **+** → paste [`pokernow-panel.user.js`](pokernow-panel.user.js) → Ctrl+S.
3. Open a table. The panel appears top-right. Drag it by its header; `Ctrl+Shift+P` hides it.

> **PokerNow moved from `pokernow.club` to `pokernow.com`.** v1 only matched `.club`, so it
> silently stopped loading. v2 matches both.

## The two sources, and why

**The log is the primary source.** PokerNow writes one structured English line per event — the
same text its official hand-history export is built from. It survives re-skins and seat-layout
changes, and it carries what the felt never shows: who folded, what everyone paid, who won.
Stats and history come from there.

**The felt (DOM) is used only for right-now state** the log has not written yet: your hole
cards this instant, the board, the pot, whether it is your turn and what a call costs. This is
the layer that breaks, so every selector has fallbacks and the **Diag** tab names which one
fired and which returned nothing.

## Tabs

| Tab | Shows |
| --- | --- |
| **Play** | Hand class, win / equity / pot-odds bars, an action call with its reasoning, board warnings, and the distribution of your final hand class |
| **HUD** | Per-player hands, VPIP, PFR, aggression factor, net — accumulated across the session |
| **Hands** | The last completed hands: board, your cards, pot, winner |
| **Diag** | Which selectors resolved, how the log is being read, unparsed lines, socket recorder state |

Header buttons cycle **TIGHT / NORMAL / LOOSE** (which shifts the calling threshold) and export
— click for a stats CSV, shift-click for full JSON.

## Two bugs worth knowing about, because they are easy to reintroduce

**Never dedupe log lines by their text.** `"Bob @ bbb" folds` recurs every few hands. Content
dedupe drops all but the first and corrupts every stat downstream. Lines are claimed per DOM
node (`data-pnp-seen`), and completed hands are banked once under a key scoped to the table URL,
so a page reload cannot replay the visible log into stats that were already counted.

**`raises to X` is a street total; `bets X` is not.** Mixing them up corrupts every pot figure.
The replay tracks per-street contribution per player, which is also what makes `Uncalled bet
returned` come out right. The tests assert each hand's books balance — chips in equal chips out.

## Tests

```bash
node tools/pokernow-panel/engine.test.cjs
```

89 checks. The userscript is loaded in a bare VM (no `document`), so only the engine half runs.
Covers hand evaluation and ordering, draws and outs, board texture, Monte Carlo equity against
known figures (AA 85.2%, 72o 35.2%, AKs 6-way ~29%), log parsing, hand replay, stats, and advice.

Note on the evaluator: ranks are packed **base-14**, not base-13. Base-13 lets a nut flush
overflow into the full-house band — it misclassified hands during development.

## Mock harness

```bash
python -m http.server 5599 --directory tools/pokernow-panel
```

Open <http://localhost:5599/mock-table.html>. **Play hand history** streams the same two-hand
fixture the Node suite uses into a DOM log panel, so ingestion → stats → HUD can be watched
end to end. Add `?reverse=1` to render the log newest-first and exercise orientation detection.

Verified there: pots 65 / 130, nets +105 / −65 / −40 summing to zero, identical in both log
orders; replaying the same hands changes nothing; a new hand whose lines repeat earlier text
verbatim still counts.

## Honest limits

- **Equity assumes opponents hold random cards.** Nobody calls a raise with a random hand, so
  your real equity against a range that keeps betting is lower than the number shown. Treat it
  as an upper bound, not a read.
- **Advice is heuristics, not a solver.** Chen preflop, pot odds and equity postflop. It has no
  model of your opponents' ranges and no concept of bluffing you specifically.
- **Selectors are inferred from a live table's markup, not from documentation.** PokerNow's game
  bundle is only served on a real table URL, so it cannot be checked from public assets. If the
  Play tab reads "Waiting for your hole cards", open **Diag** — it names the selector that failed.
- **The WebSocket recorder has no parser, deliberately.** It records message shapes only.
  `PokerNowPanel.dumpProtocol()` in the console prints what it saw. Writing a parser against
  guessed shapes would produce confident nonsense; that stays unbuilt until there is real data.
- **Stats need the table's Log panel open.** With it closed there is nothing to read, and the
  HUD stays empty rather than inventing figures.
- Using assistance software may breach PokerNow's terms and your home game's house rules. Your
  call.

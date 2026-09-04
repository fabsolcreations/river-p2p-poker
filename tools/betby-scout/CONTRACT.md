# Betby Scout — build contract

This file is the spine. Every module builds against it. If you need something
that is not here, add it here first rather than inventing a local convention.

## Non-negotiable rules

1. **No invented endpoints.** We do not know BETBY's real API. Nothing may
   branch on a guessed URL path, hostname or parameter name. Classification is
   done by payload *shape* (`src/shared/shape.ts`). Host names are an *output*
   of discovery (`observed_frames`, `/api/hosts`), never an input.
2. **Never place a bet.** No code path may submit a wager, mutate a betslip,
   click a confirm control, or automate login. The collector is read-only with
   respect to the page.
3. **Never bypass anything.** No auth bypass, no captcha solving, no rate-limit
   evasion, no requests the page did not already make. We observe traffic the
   authenticated browser receives anyway; we do not originate sportsbook
   traffic.
4. **Never fabricate a value.** A field we could not parse is `null`, and the
   reason lands in `warnings`. An estimate is labelled an estimate. Words like
   "lock", "guaranteed" and "free money" must not appear in any user-facing
   string.
5. **Redact before it leaves the page.** `src/shared/redact.ts` runs in the
   collector, not on the server. The export button must be safe to use.
6. **Append, never overwrite history.** `odds_snapshots`, `feed_bet_status_history`
   and `signals.snapshot` are immutable once written.

## Layout

```
tools/betby-scout/
  src/
    shared/          types.ts ids.ts odds.ts redact.ts shape.ts   (isomorphic)
    adapters/
      registry.ts
      betby/
        generic-betby.ts   shape-driven, works on any BETBY book
        duel.ts            host matching + Duel-specific overrides only
    collector/
      core/          hook.ts ring.ts uploader.ts frames.ts dom-fallback.ts
      panel/         panel.ts (draggable debug panel, shadow DOM)
      extension/     manifest.json background.ts popup.ts popup.html
      hook.entry.ts        MAIN-world bundle (extension + userscript share it)
      content.entry.ts     ISOLATED-world bridge (extension only)
      userscript.entry.ts  userscript bootstrap
      userscript.meta.js   ==UserScript== banner
    server/
      index.ts       Fastify bootstrap
      db/            schema.sql db.ts (node:sqlite)
      routes/        ingest.ts captures.ts stats.ts config.ts export.ts
      hub.ts         WebSocket fan-out
    dashboard/       React + Vite + Tailwind SPA
  tests/             node --test, *.test.ts
```

**Isolation rule:** `src/adapters/**` is the only place a sportsbook name may
appear in logic. The server, collector core and dashboard must work against
`SportsbookAdapter` and never import `duel.ts` directly — only `registry.ts`.

## Adapter contract

```ts
classify(input: ClassifyInput): CaptureClassification
parse(input: ParseInput): ParsePreview
```

- `classify` scores a payload on structural evidence and returns `reasons[]`
  written for a human to read in the debug panel ("array of 40 objects, 92% have
  an odds-like number and a nested legs array").
- `confidence` is 0..1. Below `MIN_CLASSIFY_CONFIDENCE` (0.55) the UI renders it
  as a guess, not a fact.
- `parse` may return empty arrays. At Milestone 1 that is the *expected* result
  for most traffic and must not be treated as an error.
- `unmappedFields` is the schema-discovery output: every dotted path present in
  the payload that no rule consumed. Do not suppress it.

## Server API (port 8787)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | liveness + schema version |
| POST | `/api/ingest` | `IngestBatch` → `IngestResult` |
| POST | `/api/frames` | `FrameReport` (iframe origin discovery) |
| GET | `/api/captures` | filter: `limit,offset,kind,host,transport,session,shape,since,q` |
| GET | `/api/captures/:id` | one capture, full body |
| GET | `/api/captures/:id/parse` | re-run the adapter live, returns `ParsePreview` |
| GET | `/api/stats` | `CaptureStats` |
| GET | `/api/hosts` | `HostStat[]`, ranked by data-likeness |
| GET | `/api/shapes` | `ShapeStat[]`, clusters of unknown traffic |
| GET | `/api/config` / POST | `CollectorConfig` |
| GET | `/api/export/captures.json` | full export, same filters as `/api/captures` |
| GET | `/api/export/captures.ndjson` | streaming export |
| WS | `/ws` | dashboard ← `ServerEvent` |
| WS | `/ws/collector` | collector ↔ server (ingest + `CollectorCommand`) |

Bind to `127.0.0.1` only. CORS allows the page origins the collector runs on
(the collector POSTs cross-origin from e.g. `https://duel.com`), plus the
dashboard dev origin.

## Collector

Two shipping shapes, one source:

- **MV3 extension** — `all_frames: true`, `world: "MAIN"`. This is the one that
  can see a cross-origin BETBY iframe. Host access is granted at runtime via
  `chrome.permissions.request` + `chrome.scripting.registerContentScripts`, so
  no host list is baked into the manifest.
- **Userscript** — Tampermonkey, top frame + same-origin frames only. Easier to
  install, strictly less capable. The hook bundle is byte-identical.

Hooks: `fetch`, `XMLHttpRequest`, `WebSocket` (both directions, text + binary),
`EventSource`. Plus a `MutationObserver` fallback that is **off by default** and
only engages when told to.

Hard requirements:

- Must not break the page. Every hook wraps in try/catch and falls through to
  the original on any error. `fetch` responses are read via `response.clone()`.
- Must survive the page overwriting `window.fetch` after us (re-check on flush).
- Binary WS frames are base64'd with `bodyEncoding: 'base64'`, never dropped.
- Bounded memory: ring buffer of `ringSize`, per-body cap `maxBodyBytes`,
  truncation flagged not silent.
- Drop counts are reported, never hidden.

## Debug panel

Draggable, collapsible, position persisted, rendered in a **shadow root** so the
page's CSS cannot touch it and ours cannot touch the page's. Sections exactly as
specified:

```
Endpoint:      method, url, host, path, status, transport, frame
Payload:       pretty JSON, collapsible, byte size, truncation flag
Parsed event:  NormalizedEvent[]  (empty is a valid, honest answer)
Parsed market: NormalizedMarket[] + NormalizedSelection[]
Parsed bet:    NormalizedFeedBet[] with legs expanded
```

Plus: capture list with live filter, classification badge + reasons, an
"Export raw capture" button (downloads NDJSON of the in-page ring buffer), a
"Discover frames" button, and a server-connection indicator.

## Design tokens

Taken from Duel's own stylesheet (`../../duel.css`), not invented:

```
dark-900 #070b23   dark-800 #0c102b   dark-700 #121731   dark-600 #181e3c
dark-500 #1f2546   dark-400 #343c64   dark-300 #47507c   dark-200 #767faa
dark-100 #a4aac6
blue-500 #5e6eff   blue-600 #4558ff   blue-700 #2133dc
green-500 #6de8bf  green-600 #20d095  green-700 #19a375
red-500  #e8305e   red-600  #cf1745   red-700  #a11236
yellow-500 #ff9900 yellow-600 #db8504
purple-500 #8a70e2 purple-600 #765dc5
radius: 12px cards, 8px controls, 4px chips
font: system-ui stack (Duel ships TT-Interphases-Pro, which we do not have);
      ui-monospace for all numbers, tabular-nums everywhere
```

Numbers are tabular and right-aligned. Odds always show 2 decimals. Never use
colour alone to encode win/loss — pair it with a sign or label.

## Milestone 1 definition of done

- `npm install && npm run build` clean, `npm run typecheck` clean, `npm test` green.
- Server starts, creates `data/scout.db`, serves `/api/health`.
- Extension loads unpacked in Chrome and the userscript installs in Tampermonkey.
- Panel appears on the target site, shows live captures, exports NDJSON.
- Frame discovery reports the iframe origins present on the page.
- **No real BETBY schema is assumed anywhere.** Milestone 2 begins only after a
  real capture export comes back from the browser.

# Installing the collector

The collector is the part that runs inside your browser and records the traffic
the sportsbook page already makes. It ships in two shapes.

**For Duel, either works — the userscript is the simpler choice.** Duel proxies
BETBY under its own domain (`sports-proxy.duel.com`) and there is no
cross-origin sportsbook iframe on the page at all, so a userscript running on
`duel.com` sees every sportsbook request. Observed 2026-09-04; if that ever
changes, frame discovery will show it.

Use the **extension** for other BETBY books, which typically do embed a
third-party widget frame that a userscript cannot reach.

Build both first:

```bash
cd tools/betby-scout && npm install && npm run build
```

That produces:

```
dist/collector/extension/          <- load this in Chrome
dist/collector/betby-scout.user.js <- open this in Tampermonkey
dist/dashboard/                    <- static dashboard build
dist/server/index.js               <- the local server
```

## Chrome / Edge / Brave (recommended)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select `tools/betby-scout/dist/collector/extension`.
5. Pin "Betby Scout" to the toolbar so you can reach the popup.

The extension asks for access to `duel.com` only. It does **not** ship a
blanket permission for every site — additional origins are granted one at a
time, by you, from the popup.

After you edit collector source, run `npm run build:collector` and hit the
reload arrow on the extension card.

## Tampermonkey (fallback)

1. Install Tampermonkey.
2. Open `dist/collector/betby-scout.user.js` in a browser tab — Tampermonkey
   offers to install it.
3. Confirm.

Limitation, stated plainly: a userscript only runs in the top frame and in
same-origin frames. That is fine for Duel, whose sportsbook is not in a
cross-origin frame — but on a BETBY book that *does* use one, the userscript
will capture the shell page and **not the sportsbook data**. You will see this
immediately: the panel fills with page traffic but nothing classifies as
`bets_feed`. That is when you switch to the extension.

## Start the local side

```bash
npm run dev
```

- Server + API + WebSocket: `http://127.0.0.1:8787`
- Dashboard: `http://127.0.0.1:5273`
- SQLite database: `tools/betby-scout/data/scout.db`

Everything binds to loopback. Nothing is exposed to your network.

## What to do on the site

1. You do **not** need to log in to capture the feed — Duel's bets feed is a
   public endpoint. Log in only if you want your own betslip and balance traffic
   captured too, and do it **yourself**: the tool never automates login and
   never stores credentials.
2. Open **Sports**, then the **Bets Feed** tab, and let it run.
3. The debug panel appears at the left edge. Drag it wherever you like — it
   defaults to the left so it does not sit on top of the betslip.
4. Click **Discover frames**. On Duel this should report no sportsbook frame —
   that is the expected result, not a failure. On another BETBY book, any widget
   origin it finds appears in the extension popup under "discovered".
5. If an origin does appear there, click **Allow** next to it. Chrome asks you
   to confirm, and the collector is then injected into that frame too.
6. Watch the panel — or the dashboard's **Live captures** page — and let it run
   for a few minutes with the feed visible. Scroll the feed, open an event, open
   a market. More interaction means more distinct endpoints captured.
7. Check the dashboard's **Shapes** page. Each row is one distinct payload
   structure. The bets feed shows up as a repeatedly-polled cluster carrying a
   `Bets feed` chip — on the captured sample it classifies at 97% confidence,
   on the strength of there being 35 distinct masked handles across 50 rows.
8. Click **Export raw capture**. That downloads an NDJSON file of everything the
   collector holds.

Send that export back and Milestone 2 can begin: real fixtures, real field
names, real parsing.

## Before you export

Redaction is **on by default** and runs in the page, before anything is stored
or uploaded. It strips `Authorization` and `Cookie` headers outright, and masks
JWTs, emails, long opaque tokens and wallet addresses inside bodies and query
strings — while deliberately leaving odds, stakes, timestamps and masked
handles intact, because those are the data.

It reduces exposure. It is not a guarantee. Skim the export before you send it
anywhere. If you turn redaction off in the settings drawer, assume the file
contains a live session token and treat it accordingly.

## What this does and does not do

- It reads responses the page already received. It does not originate a single
  request to the sportsbook.
- It never places, modifies, or confirms a bet, and never touches the betslip.
- It does not bypass authentication, captchas, or rate limits, and it does not
  automate login.
- Reading a sportsbook's community feed at volume may still be against that
  site's terms of service. That is your call to make, not something this tool
  can settle for you.

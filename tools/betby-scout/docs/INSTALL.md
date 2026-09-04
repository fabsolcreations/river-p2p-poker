# Installing the collector

The collector is the part that runs inside your browser and records the traffic
the sportsbook page already makes. It ships in two shapes. **Use the extension**
unless you have a reason not to — the userscript cannot see inside a
cross-origin iframe, and BETBY widgets are usually embedded in one.

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
same-origin frames. If the sportsbook is rendered inside an iframe served from a
different host, the userscript will capture the shell page and **not the
sportsbook data**. You will see this immediately: the panel fills with page
traffic but nothing classifies as `bets_feed`. That is when you switch to the
extension.

## Start the local side

```bash
npm run dev
```

- Server + API + WebSocket: `http://127.0.0.1:8787`
- Dashboard: `http://127.0.0.1:5273`
- SQLite database: `tools/betby-scout/data/scout.db`

Everything binds to loopback. Nothing is exposed to your network.

## What to do on the site

1. Log into the sportsbook **normally, yourself**. The tool never automates
   login and never stores credentials.
2. Open the sportsbook section and let the bets feed load.
3. The debug panel appears at the left edge. Drag it wherever you like — it
   defaults to the left so it does not sit on top of the betslip.
4. Click **Discover frames**. If the sportsbook is in a cross-origin iframe, its
   origin now appears in the extension popup under "discovered".
5. If an origin appears there, click **Allow** next to it. Chrome asks you to
   confirm. The collector is then injected into that frame too, and real
   sportsbook traffic starts arriving.
6. Watch the panel — or the dashboard's **Live captures** page — and let it run
   for a few minutes with the feed visible. Scroll the feed, open an event, open
   a market. More interaction means more distinct endpoints captured.
7. Check the dashboard's **Shapes** page. Each row is one distinct payload
   structure. The bets feed will be a cluster with a high count and, if the
   classifier did its job, a `bets_feed` chip.
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

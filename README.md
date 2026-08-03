# Market Sentinel

A live market dashboard with an app-owned collection API. The dashboard starts the source collectors itself, displays page-by-page progress, and reloads each dataset as soon as its collector completes.

## Run the live app

Node.js 22 or newer and Chrome or Edge are required for the all-page Capitol Trades collector.

```bash
npm start
```

Then open `http://localhost:4173`. Do not open `index.html` directly: direct-file and static-only hosting cannot start server-side website collectors.

- 48 continuous futures contracts from the TradingView futures scanner
- WTI, Brent, natural gas, a complete futures board, and a 1-day heatmap
- Automatic refresh every 60 seconds
- CNN Fear & Greed data and a live US equity heatmap when those feeds are available
- OpenInsider SEC Form 4 activity across cluster buys, insider buys, penny-stock buys, large sales, and the latest trades
- In-app live collection controls and visible progress for OpenInsider, Capitol Trades, and committee rosters
- Every buy and sell disclosed on all Capitol Trades pages for the latest 90-day window
- Sortable congressional trade columns, text/CSV exports, and politician trade-summary views
- Current House, Senate, select, and joint committee assignments sourced from the linked Wikipedia committee pages
- No generated quote history or hard-coded congressional/insider dataset

The free futures feed reports a 10–15 minute exchange delay. Finviz's free futures
page reports a 20-minute delay, so the dashboard uses the fresher TradingView
source and displays the delay and fetch time in the UI.

OpenInsider only serves its public screener over HTTP, which an HTTPS browser page
cannot request directly. `server.mjs` starts `scripts/fetch-openinsider.mjs` from the
app and exposes live job progress to the UI.

`scripts/fetch-capitol-trades.mjs` drives an installed Chromium browser through every
result page and validates the complete record count. `scripts/fetch-committee-memberships.mjs`
uses the MediaWiki API to rebuild current committee rosters. The JSON files under
`data/` are last-successful-run caches written only after parsing and validation finish;
they are not the primary refresh mechanism.

The scheduled GitHub Actions jobs remain as recovery automation, while the normal
interactive path is the app's **Fetch All Live Website Data** button or the source-specific
live-fetch buttons.

The former GitHub Pages URL can display the last cache but cannot run collectors; deploy `server.mjs` on a Node-capable host for the full live app.

# Market Sentinel

A live market and public-disclosure dashboard designed to work from ordinary static hosting. Browser collectors are the default; the Node collector API remains available as an optional fallback.

## Use the static app

Publish the repository through GitHub Pages or any HTTPS static host and open `index.html` through that host. No npm process is required.

- Dated bundled snapshots render immediately and remain visible if a live feed fails.
- Successful browser refreshes are saved in IndexedDB and restored on the next visit.
- Heavy website datasets are refreshed only when the user presses a refresh button. The lightweight rates matrix refreshes on first load, every 15 minutes while visible, and on demand.
- Scheduled market and rates refreshes can be turned off from the sidebar; that preference is remembered in the browser.
- The sidebar lets users select any combination of market feeds, rates, corporate insiders, recent Congress trades, and committee rosters, or run any one source directly.
- Each OpenInsider-style category has an independent refresh button, progress indicator, and status.
- Congressional trades and Wikipedia committee rosters have separate manual refresh controls.
- The sidebar and dashboard retain independent scrolling, including after network errors.

Opening the file through a `file://` URL is not recommended because browsers commonly block its requests for the adjacent JSON snapshot files. Static HTTP hosting is sufficient.

## Browser data sources

- 48 continuous futures contracts, energy quotes, and the futures heatmap: TradingView scanner, refreshed every 60 seconds while the page is visible.
- Fear & Greed and the equity heatmap: live network feeds when available. Their failure does not remove the other dashboards.
- SEC Form 4 activity: Xoomar's open-CORS, no-key SEC feed. The browser derives cluster buys, latest buys, penny-stock buys, sales of at least $100,000, and latest trading lists from current filings.
- Congressional trades: CapitolExposed's open-CORS API. The collector walks every 100-row page until it crosses the 90-day transaction-date boundary, then loads member records for party, chamber, and state.
- Committee assignments: Wikipedia's MediaWiki API. A manual refresh reads the House and Senate indexes and every current committee roster while showing progress.
- U.S. rates: official U.S. Treasury daily yield-curve XML plus the New York Fed's EFFR, SOFR, OBFR, TGCR, and BGCR reference-rate API.
- Euro-area rates and macro: ECB policy-rate and modelled government yield-curve series, with Eurostat HICP and unemployment data.
- Swedish rates and FX: Sveriges Riksbank policy-rate, government-bond, and SEK exchange-rate series. The browser uses the corrected Riksbank proxy route first, with official BIS policy-rate and ECB/Eurostat FX and yield fallbacks so a blocked Riksbank CORS response does not blank the Swedish board.
- Household transmission: official ECB new-business mortgage rates for Sweden and the euro area, plus Sweden's 3-month money-market rate and mortgage-to-policy transmission signals.
- U.S. inflation and labour: CPI from FRED at the Federal Reserve Bank of St. Louis, with seasonally adjusted monthly unemployment from Eurostat's comparable international table. Each route is optional and preserves its last successful browser value if it times out.

The rates board compares monetary-policy settings, government curves, 1-day/1-week/1-month changes, household borrowing rates, real policy rates, funding stress, SEK FX, inflation, unemployment, cross-country policy/yield gaps, and derived regime signals. Every value box exposes source dates and underlying values on hover or keyboard focus, includes a direct source button, and the full matrix can be exported as text or CSV.

Dashboard order is sentiment first, a compact one-row WTI/Brent/natural-gas strip, market timelines and heatmaps, then the market-transmission map, rates, futures, insider, and congressional boards. Each major section includes a compact expandable interpretation guide and a direct source link; rates and macro sub-panels also explain the common causal chain behind the displayed indicators. These guides describe typical relationships and explicitly avoid treating correlation as certainty.

The congressional table keeps all buy and sell disclosures in the 90-day window, sortable columns, pagination, text/CSV exports, source links, and politician summary views. Committee membership is matched into those summaries.

## Optional local collector service

Node.js 22 or newer and Chrome or Edge are required for the original all-page Capitol Trades scraper:

```bash
npm start
```

Then open `http://localhost:4173`. If a browser collector fails, the UI will try this local API when it is available. The service can still run the original OpenInsider HTML scraper, Chromium-based Capitol Trades scraper, and MediaWiki roster collector. Successful server runs update the JSON files under `data/` atomically.

## Verification

```bash
npm test
```

This checks all JavaScript, validates the bundled datasets, and runs the local server smoke test. Additional Playwright scripts under `scripts/` cover static/no-API startup and end-to-end browser collection when Playwright is available.

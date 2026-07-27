# Market Sentinel

A static market dashboard that requests its data at runtime.

- 48 continuous futures contracts from the TradingView futures scanner
- WTI, Brent, natural gas, a complete futures board, and a 1-day heatmap
- Automatic refresh every 60 seconds
- CNN Fear & Greed data and a live US equity heatmap when those feeds are available
- No generated quote history, hard-coded market matrix, or stale session restoration

The free futures feed reports a 10–15 minute exchange delay. Finviz's free futures
page reports a 20-minute delay, so the dashboard uses the fresher TradingView
source and displays the delay and fetch time in the UI.

Live site: https://nomsams.github.io/sentinel/

import { createRequire } from "node:module";
import { resolve } from "node:path";

const moduleRoot = process.env.SENTINEL_NODE_MODULES;
if (!moduleRoot) throw new Error("Set SENTINEL_NODE_MODULES to a node_modules directory containing Playwright.");
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(moduleRoot, "playwright"));
const baseURL = process.argv[2] || "http://127.0.0.1:8765/index.html";
const baseOrigin = new URL(baseURL).origin;
const executablePath = process.env.SENTINEL_CHROMIUM_PATH;

const browser = await chromium.launch({ headless: true, executablePath, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const apiRequests = [];
  const failedRequests = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.origin === baseOrigin && url.pathname.startsWith("/api/")) apiRequests.push(request.url());
  });
  page.on("requestfailed", request => failedRequests.push(`${request.url()}: ${request.failure()?.errorText || "failed"}`));
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const legacy = [...document.querySelectorAll('[data-live-job]:not([data-live-job="macro"]) [data-job-status]')];
    return document.querySelectorAll("[data-live-job] [data-job-status]").length === 4
      && legacy.length === 3 && legacy.every(node => node.textContent === "SAVED");
  }, null, { timeout: 20000 });
  try {
    await page.waitForSelector(".insider-board", { timeout: 30000 });
    await page.waitForSelector(".congressional-board", { timeout: 30000 });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      status: document.getElementById("dataStatus")?.textContent,
      dashboardText: document.getElementById("dashboardGrid")?.innerText.slice(0, 1000),
      logText: document.getElementById("logScroll")?.innerText.slice(-2000)
    }));
    throw new Error(`${error.message}\n${JSON.stringify({ diagnostics, errors, failedRequests: failedRequests.slice(-12) })}`);
  }
  await page.evaluate(() => {
    if (document.querySelector(".macro-explainer")) return;
    const source = { label: "Official test provider", url: "https://example.com/official-data" };
    const point = (term, years, value) => ({ term, years, value, date: "2026-08-07", changes: { day: 1, week: -2, month: 3 } });
    const payload = {
      source: { fetchedAt: new Date().toISOString(), providerCount: 2, successfulProviders: 2, failures: [], urls: { riksPolicy: source.url, ecbBankRates: source.url } },
      providers: { riksPolicy: "live", ecbBankRates: "live" }, regime: "Mixed / neutral macro regime",
      policy: [
        { region: "US", regionName: "United States", benchmark: "Policy rate", rate: 4.25, date: "2026-08-07", secondary: [], source },
        { region: "EU", regionName: "Euro area", benchmark: "Deposit facility", rate: 2.25, date: "2026-08-07", secondary: [], source },
        { region: "SE", regionName: "Sweden", benchmark: "Policy rate", rate: 1.75, date: "2026-08-07", secondary: [], source }
      ],
      curves: {
        US: { region: "US", regionName: "United States", date: "2026-08-07", points: [point("2Y", 2, 3.8), point("5Y", 5, 4), point("10Y", 10, 4.2)], slope10y2y: 40, slope10y3m: null, source },
        SE: { region: "SE", regionName: "Sweden", date: "2026-08-07", points: [point("3M", .25, 1.9), point("10Y", 10, 2.8)], slope10y2y: null, slope10y3m: 90, fallback: true, coverage: "3M + 10Y", source }
      },
      realPolicy: [{ region: "SE", regionName: "Sweden", value: -.15, policy: 1.75, inflation: 1.9, date: "2026-07", source }],
      funding: [{ label: "SOFR", rate: 4.3, date: "2026-08-07", volume: 2100, percentile1: 4.25, percentile99: 4.4, source }],
      fx: [{ pair: "EUR/SEK", value: 10.9, date: "2026-08-07", changes: { day: .1, week: -.2, month: 1.1 }, source }],
      bankRates: [{ region: "SE", regionName: "Sweden", label: "New mortgage rate", value: 2.8, date: "2026-06", changes: { month: -2, quarter: -8, year: -40 }, source }],
      moneyMarket: [{ region: "SE", regionName: "Sweden", label: "3M money-market rate", value: 1.9, date: "2026-06", changes: { month: 1, quarter: -5, year: -30 }, source }],
      inflation: [{ region: "SE", regionName: "Sweden", value: 1.9, date: "2026-07", source }], labour: [{ region: "SE", regionName: "Sweden", value: 8.4, date: "2026-06", source }],
      signals: [{ label: "SE mortgage-policy", value: "+105 bp", state: "Normal premium", tone: "calm", detail: "Synthetic render check.", source }]
    };
    document.querySelector(".macro-card")?.remove();
    sentinel.renderMacroDashboard(document.getElementById("dashboardGrid"), payload);
  });
  const result = await page.evaluate(() => {
    const sidebar = document.querySelector(".sidebar");
    const dashboard = document.querySelector(".dashboard-view");
    const sidebarStyle = getComputedStyle(sidebar);
    const dashboardStyle = getComputedStyle(dashboard);
    const sidebarCanScroll = sidebar.scrollHeight <= sidebar.clientHeight || (() => {
      sidebar.style.scrollBehavior = "auto";
      sidebar.scrollTop = 40;
      return sidebar.scrollTop > 0;
    })();
    const dashboardCanScroll = dashboard.scrollHeight <= dashboard.clientHeight || (() => {
      dashboard.style.scrollBehavior = "auto";
      dashboard.scrollTop = 80;
      return dashboard.scrollTop > 0;
    })();
    return {
      statuses: [...document.querySelectorAll("[data-live-job] [data-job-status]")].map(node => node.textContent),
      messages: [...document.querySelectorAll("[data-live-job] [data-job-message]")].map(node => node.textContent),
      categoryRefreshButtons: document.querySelectorAll("[data-insider-refresh]").length,
      macroCard: Boolean(document.querySelector(".macro-card")),
      refreshSelectors: document.querySelectorAll("[data-refresh-source]").length,
      refreshOnlyButtons: document.querySelectorAll("[data-refresh-only]").length,
      autoRefreshToggle: Boolean(document.getElementById("autoRefreshToggle")),
      sectionGuides: document.querySelectorAll(".section-guide").length,
      guideSources: document.querySelectorAll(".guide-source").length,
      macroExplainers: document.querySelectorAll(".macro-explainer").length,
      macroSourceButtons: document.querySelectorAll(".macro-source-button").length,
      macroProviderLinks: document.querySelectorAll("a.macro-provider").length,
      macroCreditPanel: Boolean(document.querySelector(".macro-panel.credit")),
      transmissionMap: Boolean(document.querySelector(".transmission-card")),
      transmissionChains: document.querySelectorAll(".transmission-chain").length,
      sidebarOverflowY: sidebarStyle.overflowY,
      dashboardOverflowY: dashboardStyle.overflowY,
      sidebarCanScroll,
      dashboardCanScroll,
      sidebarHeight: `${sidebar.clientHeight}/${sidebar.scrollHeight}`,
      dashboardHeight: `${dashboard.clientHeight}/${dashboard.scrollHeight}`,
      bodyWidth: document.body.scrollWidth,
      viewportWidth: document.documentElement.clientWidth
    };
  });
  if (apiRequests.length) throw new Error(`Static startup unexpectedly contacted the local collector API: ${apiRequests.join(", ")}`);
  if (errors.length) throw new Error(`Browser page errors: ${errors.join(" | ")}`);
  if (result.categoryRefreshButtons !== 5) throw new Error(`Expected 5 per-category OpenInsider refresh buttons, found ${result.categoryRefreshButtons}.`);
  if (!result.macroCard) throw new Error("The rates and macro category did not render.");
  if (result.refreshSelectors !== 5 || result.refreshOnlyButtons !== 5 || !result.autoRefreshToggle) throw new Error(`Selective refresh controls are incomplete: ${JSON.stringify(result)}`);
  if (result.sectionGuides < 3 || result.guideSources < 3 || result.macroExplainers !== 8 || result.macroSourceButtons < 8 || result.macroProviderLinks < 2 || !result.macroCreditPanel || !result.transmissionMap || result.transmissionChains !== 4) throw new Error(`Interpretation and source UI is incomplete: ${JSON.stringify(result)}`);
  if (!result.sidebarCanScroll || !result.dashboardCanScroll) throw new Error(`A primary scroll region is blocked: ${JSON.stringify(result)}`);
  if (result.bodyWidth > result.viewportWidth) throw new Error(`The static page overflows horizontally: ${JSON.stringify(result)}`);

  const mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const mobileErrors = [];
  mobilePage.on("pageerror", error => mobileErrors.push(error.message));
  mobilePage.on("request", request => {
    const url = new URL(request.url());
    if (url.origin === baseOrigin && url.pathname.startsWith("/api/")) apiRequests.push(request.url());
  });
  await mobilePage.goto(baseURL, { waitUntil: "domcontentloaded" });
  await mobilePage.waitForSelector(".transmission-card", { timeout: 20000 });
  const mobileResult = await mobilePage.evaluate(() => {
    const dashboard = document.querySelector(".dashboard-view");
    const transmissionGrid = document.querySelector(".transmission-grid");
    const transmissionFlow = document.querySelector(".transmission-chain .correlation-flow");
    return {
      bodyWidth: document.body.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      transmissionColumns: getComputedStyle(transmissionGrid).gridTemplateColumns.split(" ").length,
      transmissionFlowDirection: getComputedStyle(transmissionFlow).flexDirection,
      guideSummaryWhiteSpace: getComputedStyle(document.querySelector(".section-guide .guide-summary")).whiteSpace,
      dashboardCanScroll: dashboard.scrollHeight > dashboard.clientHeight,
      transmissionChains: document.querySelectorAll(".transmission-chain").length
    };
  });
  await mobilePage.close();
  if (mobileErrors.length) throw new Error(`Mobile browser page errors: ${mobileErrors.join(" | ")}`);
  if (mobileResult.bodyWidth > mobileResult.viewportWidth || mobileResult.transmissionColumns !== 1 || mobileResult.transmissionFlowDirection !== "column" || mobileResult.guideSummaryWhiteSpace !== "normal" || !mobileResult.dashboardCanScroll || mobileResult.transmissionChains !== 4) throw new Error(`Mobile interpretation UI failed: ${JSON.stringify(mobileResult)}`);
  if (apiRequests.length) throw new Error(`Static startup unexpectedly contacted the local collector API: ${apiRequests.join(", ")}`);
  console.log(JSON.stringify({ ...result, mobile: mobileResult, apiRequests: apiRequests.length, pageErrors: errors.length + mobileErrors.length }));
} finally {
  await browser.close();
}

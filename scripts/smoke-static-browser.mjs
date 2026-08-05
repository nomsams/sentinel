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
  if (!result.sidebarCanScroll || !result.dashboardCanScroll) throw new Error(`A primary scroll region is blocked: ${JSON.stringify(result)}`);
  if (result.bodyWidth > result.viewportWidth) throw new Error(`The static page overflows horizontally: ${JSON.stringify(result)}`);
  console.log(JSON.stringify({ ...result, apiRequests: apiRequests.length, pageErrors: errors.length }));
} finally {
  await browser.close();
}

import { createRequire } from "node:module";
import { resolve } from "node:path";

const moduleRoot = process.env.SENTINEL_NODE_MODULES;
if (!moduleRoot) throw new Error("Set SENTINEL_NODE_MODULES to a node_modules directory containing Playwright.");
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(moduleRoot, "playwright"));
const baseURL = process.argv[2] || "http://127.0.0.1:8765/index.html";

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.SENTINEL_CHROMIUM_PATH,
  args: ["--no-sandbox"]
});
try {
  const page = await browser.newPage();
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("[data-live-job] [data-job-status]").length === 3
    && [...document.querySelectorAll("[data-live-job] [data-job-status]")].every(node => node.textContent === "SAVED"), null, { timeout: 20000 });
  const result = await page.evaluate(async () => {
    const insiderProgress = [];
    const congressProgress = [];
    const committeeProgress = [];
    const insider = await globalThis.SentinelBrowser.collectOpenInsider(null, null, (...args) => insiderProgress.push(args));
    const congress = await globalThis.SentinelBrowser.collectCongress((...args) => congressProgress.push(args));
    const committees = await globalThis.SentinelBrowser.collectCommittees((...args) => committeeProgress.push(args));
    sentinel.applyCollectedPayload("openinsider", insider, { render: false });
    sentinel.applyCollectedPayload("committees", committees, { render: false });
    sentinel.applyCollectedPayload("capitol", congress, { render: true });
    return {
      insiderProvider: insider.source.provider,
      insiderRows: insider.sections.reduce((total, section) => total + section.rows.length, 0),
      insiderSections: insider.sections.map(section => ({ id: section.id, rows: section.rows.length })),
      insiderProgressEvents: insiderProgress.length,
      congressProvider: congress.source.provider,
      congressRows: congress.trades.length,
      congressPages: congress.source.pagesFetched,
      congressProgressEvents: congressProgress.length,
      oldestCongressTrade: congress.trades.at(-1)?.tradedAt,
      newestCongressTrade: congress.trades[0]?.tradedAt,
      committeeProvider: committees.source.provider,
      committeeMembers: committees.source.memberCount,
      committeeAssignments: committees.source.assignmentCount,
      committeeProgressEvents: committeeProgress.length,
      renderedInsiderLists: document.querySelectorAll("[data-insider-job]").length,
      renderedCongressRows: document.querySelectorAll("[data-congress-rows] tr").length,
      renderedProvider: document.querySelector(".congressional-board .insider-source")?.textContent || ""
    };
  });
  if (result.insiderRows < 1 || result.congressRows < 1 || result.congressPages < 1 || result.committeeMembers < 50 || result.committeeAssignments < 100
    || result.renderedInsiderLists !== 5 || result.renderedCongressRows < 1 || !result.renderedProvider.includes("CapitolExposed")) {
    throw new Error(`Incomplete live browser result: ${JSON.stringify(result)}`);
  }
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}

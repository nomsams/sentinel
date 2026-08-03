import { access, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://www.capitoltrades.com/trades?txType=buy&txType=sell&pageSize=96&page=1&txDate=90d";
const PAGE_SIZE = 96;
const REQUEST_DELAY_MS = 750;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

function reportProgress(stage, current, total, message) {
  console.log(`SENTINEL_PROGRESS ${JSON.stringify({ stage, current, total, message })}`);
}

async function writeJSONAtomic(outputPath, payload) {
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

const COLUMN_DEFINITIONS = [
  { key: "politicianName", label: "Politician" },
  { key: "issuerName", label: "Traded Issuer" },
  { key: "publishedDisplay", label: "Published" },
  { key: "tradedDisplay", label: "Traded" },
  { key: "reportingGap", label: "Filed After" },
  { key: "ownerDisplay", label: "Owner" },
  { key: "typeDisplay", label: "Type" },
  { key: "sizeDisplay", label: "Size" },
  { key: "price", label: "Price" }
];

const delay = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));

async function isExecutable(path) {
  if (!path) return false;
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findBrowserExecutable() {
  const candidates = [
    process.env.CAPITOL_BROWSER_PATH,
    process.env.CHROME_BIN,
    process.platform === "win32" ? join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe") : null,
    process.platform === "win32" ? join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe") : null,
    process.platform === "win32" ? join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe") : null,
    process.platform === "win32" ? join(process.env.PROGRAMFILES || "", "Microsoft", "Edge", "Application", "msedge.exe") : null,
    process.platform === "win32" ? join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe") : null,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  ];

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  throw new Error("No Chrome or Edge executable found. Set CAPITOL_BROWSER_PATH to a Chromium-based browser.");
}

async function reservePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolvePromise(address.port));
    });
  });
}

class CdpSession {
  constructor(webSocketURL) {
    this.webSocketURL = webSocketURL;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    if (typeof WebSocket === "undefined") throw new Error("Node.js 22 or newer is required for the Capitol Trades updater.");
    this.socket = new WebSocket(this.webSocketURL);
    this.socket.addEventListener("message", event => {
      const message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve: resolveRequest, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolveRequest(message.result);
    });
    this.socket.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("Browser debugging session closed."));
      this.pending.clear();
    });
    await new Promise((resolvePromise, reject) => {
      this.socket.addEventListener("open", resolvePromise, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("Unable to connect to the browser debugging session.")), { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.close();
  }
}

async function waitForDevTools(port, browserProcess, stderrLines) {
  const endpoint = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (browserProcess.exitCode !== null) {
      throw new Error(`Browser exited before its debugger was ready. ${stderrLines.slice(-5).join(" ")}`);
    }
    try {
      const response = await fetch(`${endpoint}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
      if (response.ok) return response.json();
    } catch {
      // The browser is still starting.
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the browser debugger.");
}

async function evaluate(session, expression) {
  const result = await session.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Browser evaluation failed.");
  }
  return result.result.value;
}

async function waitForTradeTable(session, pageNumber) {
  const url = new URL(SOURCE_URL);
  url.searchParams.set("page", String(pageNumber));
  await session.send("Page.navigate", { url: url.href });

  for (let attempt = 0; attempt < 90; attempt += 1) {
    const state = await evaluate(session, `(() => ({
      title: document.title,
      currentPage: new URL(location.href).searchParams.get('page'),
      rowCount: document.querySelectorAll('table tbody tr').length,
      hasPayload: Array.from(document.querySelectorAll('script:not([src])')).some(script => script.textContent.includes('_txId'))
    }))()`);
    if (Number(state.currentPage) === pageNumber && state.rowCount > 0 && state.hasPayload) {
      await delay(500);
      return url.href;
    }
    await delay(1000);
  }

  const finalState = await evaluate(session, `(() => ({ title: document.title, text: document.body?.innerText?.slice(0, 300) || '' }))()`);
  throw new Error(`Page ${pageNumber} did not expose a trade table (${finalState.title}: ${finalState.text}).`);
}

async function extractTradePage(session, extractorExpression, pageNumber) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const page = await evaluate(session, extractorExpression);
      if (page?.trades?.length) return page;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(`Page ${pageNumber} never reached a stable trade-table state. ${lastError?.message || ""}`.trim());
}

function browserPageExtractor() {
  const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const script = Array.from(document.querySelectorAll("script:not([src])")).find(node => node.textContent.includes("_txId"));
  if (!script) throw new Error("Structured trade payload not found.");

  const prefix = "self.__next_f.push(";
  const invocation = script.textContent.trim().replace(/;$/, "");
  const args = JSON.parse(invocation.slice(prefix.length, -1));
  const flight = args[1];
  const marker = '"data":[';
  const markerIndex = flight.indexOf(marker);
  if (markerIndex < 0) throw new Error("Trade data marker not found.");

  const arrayStart = markerIndex + marker.length - 1;
  let depth = 0;
  let insideString = false;
  let escaped = false;
  let arrayEnd = -1;
  for (let index = arrayStart; index < flight.length; index += 1) {
    const character = flight[index];
    if (insideString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') insideString = false;
      continue;
    }
    if (character === '"') insideString = true;
    else if (character === "[") depth += 1;
    else if (character === "]" && --depth === 0) {
      arrayEnd = index;
      break;
    }
  }
  if (arrayEnd < 0) throw new Error("Trade data array was incomplete.");

  const records = JSON.parse(flight.slice(arrayStart, arrayEnd + 1));
  const tableRows = Array.from(document.querySelectorAll("table tbody tr"));
  if (records.length !== tableRows.length) throw new Error(`Structured records (${records.length}) did not match table rows (${tableRows.length}).`);

  const trades = records.map((record, index) => {
    const cells = Array.from(tableRows[index].querySelectorAll("td"));
    const politicianName = clean(cells[0]?.querySelector(".politician-name a")?.textContent) || `${record.politician.nickname || record.politician.firstName} ${record.politician.lastName}`;
    const issuerName = clean(cells[1]?.querySelector(".issuer-name a")?.textContent) || record.issuer.issuerName;
    const typeText = clean(cells[6]?.querySelector(".tx-type")?.textContent) || record.txType;
    const hasAsterisk = cells[6]?.querySelector(".tx-type")?.classList.contains("has-asterisk");
    return {
      id: String(record._txId),
      politicianId: record._politicianId,
      politicianName,
      firstName: record.politician.firstName,
      lastName: record.politician.lastName,
      nickname: record.politician.nickname,
      party: record.politician.party,
      chamber: record.politician.chamber || record.chamber,
      state: record.politician._stateId,
      dateOfBirth: record.politician.dob,
      gender: record.politician.gender,
      issuerId: record._issuerId,
      issuerName,
      issuerTicker: clean(cells[1]?.querySelector(".issuer-ticker")?.textContent) || record.issuer.issuerTicker,
      issuerState: record.issuer._stateId,
      issuerCountry: record.issuer.country,
      sector: record.issuer.sector,
      publishedAt: record.pubDate,
      publishedDisplay: clean(cells[2]?.innerText || cells[2]?.textContent),
      tradedAt: record.txDate,
      tradedDisplay: clean(cells[3]?.innerText || cells[3]?.textContent),
      reportingGap: record.reportingGap,
      filedAfterDisplay: `${record.reportingGap} days`,
      owner: record.owner,
      ownerDisplay: clean(cells[5]?.innerText || cells[5]?.textContent),
      type: record.txType,
      typeExtended: record.txTypeExtended,
      typeDisplay: `${typeText}${hasAsterisk ? "*" : ""}`,
      sizeDisplay: clean(cells[7]?.innerText || cells[7]?.textContent),
      estimatedValue: record.value,
      price: record.price,
      priceDisplay: clean(cells[8]?.innerText || cells[8]?.textContent) || "N/A",
      comment: record.comment,
      politicianUrl: `/politicians/${record._politicianId}`,
      issuerUrl: `/issuers/${record._issuerId}`,
      tradeUrl: `/trades/${record._txId}`
    };
  });

  const pages = Array.from(document.querySelectorAll('a[href*="page="]')).map(link => {
    try { return Number(new URL(link.href).searchParams.get("page")); }
    catch { return 0; }
  }).filter(Number.isFinite);
  const bodyText = document.body?.innerText || "";
  const reportedMatch = bodyText.match(/([\d,]+)\s+Trades/i);
  return {
    pageCount: Math.max(1, ...pages),
    reportedCount: reportedMatch ? Number(reportedMatch[1].replace(/,/g, "")) : null,
    trades
  };
}

async function main() {
  reportProgress("browser", 0, 1, "Starting the live Capitol Trades browser session…");
  const browserExecutable = await findBrowserExecutable();
  const port = await reservePort();
  const profileDirectory = await mkdtemp(join(tmpdir(), "sentinel-capitol-"));
  const stderrLines = [];
  const browserProcess = spawn(browserExecutable, [
    "--headless=new",
    "--disable-background-networking",
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    "--no-sandbox",
    "--remote-allow-origins=*",
    `--remote-debugging-port=${port}`,
    `--user-agent=${USER_AGENT}`,
    `--user-data-dir=${profileDirectory}`,
    "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  browserProcess.stderr.setEncoding("utf8");
  browserProcess.stderr.on("data", chunk => stderrLines.push(...chunk.split(/\r?\n/).filter(Boolean)));

  let session;
  try {
    const target = await waitForDevTools(port, browserProcess, stderrLines);
    session = new CdpSession(target.webSocketDebuggerUrl);
    await session.connect();
    await session.send("Page.enable");
    await session.send("Runtime.enable");

    await waitForTradeTable(session, 1);
    const extractorExpression = `(${browserPageExtractor.toString()})()`;
    const firstPage = await extractTradePage(session, extractorExpression, 1);
    const pageCount = firstPage.pageCount;
    const reportedCount = firstPage.reportedCount;
    const allTrades = [...firstPage.trades.map(trade => ({ ...trade, sourcePage: 1 }))];
    console.log(`Capitol Trades reports ${reportedCount ?? "an unknown number of"} trades across ${pageCount} pages.`);
    reportProgress("pages", 1, pageCount, `Fetched page 1/${pageCount} (${firstPage.trades.length} trades).`);

    for (let pageNumber = 2; pageNumber <= pageCount; pageNumber += 1) {
      await delay(REQUEST_DELAY_MS);
      await waitForTradeTable(session, pageNumber);
      const page = await extractTradePage(session, extractorExpression, pageNumber);
      allTrades.push(...page.trades.map(trade => ({ ...trade, sourcePage: pageNumber })));
      console.log(`Fetched page ${pageNumber}/${pageCount} (${page.trades.length} trades).`);
      reportProgress("pages", pageNumber, pageCount, `Fetched page ${pageNumber}/${pageCount} (${page.trades.length} trades).`);
    }

    const uniqueTrades = [...new Map(allTrades.map(trade => [trade.id, trade])).values()]
      .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt) || right.id.localeCompare(left.id));
    const minimumExpected = Math.max(1, (pageCount - 1) * PAGE_SIZE);
    if (uniqueTrades.length < minimumExpected) {
      throw new Error(`Only ${uniqueTrades.length} unique trades were captured; expected at least ${minimumExpected}.`);
    }
    if (Number.isFinite(reportedCount) && uniqueTrades.length !== reportedCount) {
      throw new Error(`Captured ${uniqueTrades.length} unique trades, but Capitol Trades reported ${reportedCount}; refusing to publish an incomplete result.`);
    }

    const fetchedAt = new Date().toISOString();
    const payload = {
      source: {
        provider: "Capitol Trades",
        url: SOURCE_URL,
        fetchedAt,
        window: "90 days",
        transactionTypes: ["buy", "sell"],
        pageSize: PAGE_SIZE,
        pagesFetched: pageCount,
        reportedCount,
        rowCount: uniqueTrades.length,
        updateIntervalHours: 6
      },
      columns: COLUMN_DEFINITIONS,
      trades: uniqueTrades
    };

    const scriptDirectory = dirname(fileURLToPath(import.meta.url));
    const outputPath = resolve(scriptDirectory, "..", "data", "capitol-trades.json");
    await mkdir(dirname(outputPath), { recursive: true });
    await writeJSONAtomic(outputPath, payload);
    reportProgress("saving", pageCount, pageCount, `Saved ${uniqueTrades.length} trades from all ${pageCount} pages.`);
    console.log(`Saved ${uniqueTrades.length} Capitol Trades records to ${outputPath}.`);
  } finally {
    session?.close();
    if (browserProcess.exitCode === null) {
      const browserExit = new Promise(resolveExit => browserProcess.once("exit", resolveExit));
      browserProcess.kill();
      await Promise.race([browserExit, delay(5000)]);
    }
    if (profileDirectory.startsWith(join(tmpdir(), "sentinel-capitol-"))) {
      try {
        await rm(profileDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      } catch (cleanupError) {
        console.warn(`Temporary browser profile cleanup was deferred: ${cleanupError.message}`);
      }
    }
  }
}

await main();

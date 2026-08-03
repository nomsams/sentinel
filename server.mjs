import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const PROGRESS_PREFIX = "SENTINEL_PROGRESS ";
const MAX_LOG_LINES = 80;

const COLLECTORS = {
  openinsider: {
    label: "OpenInsider",
    script: "scripts/fetch-openinsider.mjs",
    output: "data/openinsider.json"
  },
  capitol: {
    label: "Capitol Trades",
    script: "scripts/fetch-capitol-trades.mjs",
    output: "data/capitol-trades.json"
  },
  committees: {
    label: "Congressional committees",
    script: "scripts/fetch-committee-memberships.mjs",
    output: "data/committee-memberships.json"
  }
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

const jobs = new Map();
const activeBySource = new Map();
const latestBySource = new Map();
const childProcesses = new Map();

function publicJob(job) {
  return {
    id: job.id,
    source: job.source,
    label: job.label,
    status: job.status,
    stage: job.stage,
    current: job.current,
    total: job.total,
    percent: job.percent,
    message: job.message,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    output: job.output,
    logs: job.logs.slice(-25),
    error: job.error
  };
}

function sendJSON(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function addLog(job, line, level = "info") {
  const text = String(line || "").trim();
  if (!text) return;
  job.logs.push({ at: new Date().toISOString(), level, text });
  if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
  job.updatedAt = new Date().toISOString();
}

function updateProgress(job, progress) {
  const current = Number(progress.current);
  const total = Number(progress.total);
  job.stage = String(progress.stage || job.stage || "fetching");
  job.current = Number.isFinite(current) ? current : job.current;
  job.total = Number.isFinite(total) && total > 0 ? total : job.total;
  job.percent = Number.isFinite(Number(progress.percent))
    ? Math.max(0, Math.min(100, Math.round(Number(progress.percent))))
    : job.total > 0 ? Math.max(0, Math.min(99, Math.round(job.current / job.total * 100))) : job.percent;
  job.message = String(progress.message || job.message || "Collecting live data…");
  job.updatedAt = new Date().toISOString();
  addLog(job, job.message, "progress");
}

function consumeLine(job, line, level = "info") {
  if (line.startsWith(PROGRESS_PREFIX)) {
    try {
      updateProgress(job, JSON.parse(line.slice(PROGRESS_PREFIX.length)));
      return;
    } catch {
      addLog(job, line, "warning");
      return;
    }
  }
  addLog(job, line, level);
  if (level !== "error" && line.trim()) job.message = line.trim();
}

function launchCollector(source) {
  const definition = COLLECTORS[source];
  const runningId = activeBySource.get(source);
  const runningJob = runningId ? jobs.get(runningId) : null;
  if (runningJob?.status === "running") return runningJob;

  const now = new Date().toISOString();
  const job = {
    id: randomUUID(),
    source,
    label: definition.label,
    status: "running",
    stage: "starting",
    current: 0,
    total: 0,
    percent: 0,
    message: `Starting live ${definition.label} collector…`,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    output: definition.output,
    logs: [],
    error: null
  };
  jobs.set(job.id, job);
  activeBySource.set(source, job.id);
  latestBySource.set(source, job.id);
  addLog(job, job.message, "progress");

  const child = spawn(process.execPath, [resolve(ROOT, definition.script)], {
    cwd: ROOT,
    env: { ...process.env, SENTINEL_JOB_ID: job.id },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  job.pid = child.pid;
  childProcesses.set(job.id, child);

  createInterface({ input: child.stdout }).on("line", line => consumeLine(job, line));
  createInterface({ input: child.stderr }).on("line", line => consumeLine(job, line, "error"));

  child.once("error", error => {
    childProcesses.delete(job.id);
    job.status = "failed";
    job.error = error.message;
    job.message = `Collector failed to start: ${error.message}`;
    job.finishedAt = job.updatedAt = new Date().toISOString();
    activeBySource.delete(source);
    addLog(job, job.message, "error");
  });

  child.once("exit", async code => {
    childProcesses.delete(job.id);
    activeBySource.delete(source);
    if (job.status === "failed") return;
    job.finishedAt = job.updatedAt = new Date().toISOString();
    let outputIsFresh = false;
    try {
      const outputStat = await stat(resolve(ROOT, definition.output));
      outputIsFresh = outputStat.mtimeMs >= Date.parse(job.startedAt) - 1000;
    } catch {}
    if (code === 0 && outputIsFresh) {
      job.status = "completed";
      job.stage = "complete";
      job.current = job.total || job.current || 1;
      job.total = job.total || job.current || 1;
      job.percent = 100;
      job.message = `${definition.label} live collection completed.`;
      addLog(job, job.message, "success");
    } else {
      job.status = "failed";
      job.stage = "failed";
      job.error = job.error || (code === 0 ? "Collector exited without writing a fresh output file." : `Collector exited with code ${code}.`);
      job.message = job.error;
      addLog(job, job.message, "error");
    }
  });

  return job;
}

function safeStaticPath(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { return null; }
  const relative = normalize(decoded === "/" ? "index.html" : decoded.replace(/^[/\\]+/, ""));
  const publicPath = relative.split(sep).join("/");
  if (publicPath !== "index.html" && !publicPath.startsWith("data/")) return null;
  const absolute = resolve(ROOT, relative);
  return absolute === ROOT || absolute.startsWith(`${ROOT.endsWith(sep) ? ROOT.slice(0, -1) : ROOT}${sep}`) ? absolute : null;
}

async function serveStatic(request, response, pathname) {
  const filePath = safeStaticPath(pathname);
  if (!filePath || !existsSync(filePath)) return sendJSON(response, 404, { error: "Not found" });
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) return sendJSON(response, 404, { error: "Not found" });
  const dataFile = filePath.includes(`${sep}data${sep}`);
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream",
    "Content-Length": fileStat.size,
    "Cache-Control": dataFile || filePath.endsWith("index.html") ? "no-store" : "public, max-age=300"
  });
  if (request.method === "HEAD") return response.end();
  createReadStream(filePath).pipe(response);
}

function requestIsSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === request.headers.host; }
  catch { return false; }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const parts = url.pathname.split("/").filter(Boolean);

    if (request.method === "OPTIONS") return sendJSON(response, 405, { error: "Cross-origin requests are not allowed" });

    if (request.method === "GET" && url.pathname === "/api/health") {
      return sendJSON(response, 200, {
        ok: true,
        collectors: Object.keys(COLLECTORS),
        active: [...activeBySource.keys()]
      });
    }

    if (request.method === "GET" && url.pathname === "/api/jobs") {
      const latest = Object.fromEntries(Object.keys(COLLECTORS).map(source => {
        const job = jobs.get(latestBySource.get(source));
        return [source, job ? publicJob(job) : null];
      }));
      return sendJSON(response, 200, { latest });
    }

    if (parts[0] === "api" && parts[1] === "jobs" && parts.length === 3) {
      const target = parts[2];
      if (request.method === "POST" && COLLECTORS[target]) {
        if (!requestIsSameOrigin(request)) return sendJSON(response, 403, { error: "Cross-origin collector requests are not allowed" });
        const job = launchCollector(target);
        return sendJSON(response, 202, publicJob(job));
      }
      if (request.method === "GET") {
        const job = jobs.get(target);
        return job ? sendJSON(response, 200, publicJob(job)) : sendJSON(response, 404, { error: "Unknown job" });
      }
    }

    if (request.method !== "GET" && request.method !== "HEAD") return sendJSON(response, 405, { error: "Method not allowed" });
    return await serveStatic(request, response, url.pathname);
  } catch (error) {
    return sendJSON(response, 500, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Market Sentinel live collector listening on http://${HOST}:${PORT}`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of childProcesses.values()) {
    if (child.exitCode === null) child.kill();
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

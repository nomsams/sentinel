import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function reservePort() {
  return new Promise((resolvePort, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const { port } = socket.address();
      socket.close(error => error ? reject(error) : resolvePort(port));
    });
  });
}

const port = await reservePort();
const child = spawn(process.execPath, [resolve(root, "server.mjs")], {
  cwd: root,
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

const output = [];
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", chunk => output.push(chunk));
child.stderr.on("data", chunk => output.push(chunk));

try {
  const base = `http://127.0.0.1:${port}`;
  let health;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      health = await fetch(`${base}/api/health`);
      if (health.ok) break;
    } catch {}
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  assert(health?.ok, `Server did not become healthy: ${output.join("")}`);
  assert.equal((await health.json()).ok, true);

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Market Sentinel/);

  const head = await fetch(`${base}/data/openinsider.json`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  assert.equal((await fetch(`${base}/server.mjs`)).status, 404, "Private server source must not be publicly served");
  assert.equal((await fetch(`${base}/api/jobs/openinsider`, {
    method: "POST",
    headers: { Origin: "https://attacker.example" }
  })).status, 403, "Cross-origin collector starts must be rejected");

  console.log(`Server smoke test passed on port ${port}.`);
} finally {
  if (child.exitCode === null) child.kill();
  await new Promise(resolveExit => child.once("exit", resolveExit));
}

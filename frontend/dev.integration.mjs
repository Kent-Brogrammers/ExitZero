import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("./", import.meta.url));
const example = JSON.parse(
  await readFile(new URL("../shared/examples/building.json", import.meta.url)),
);

async function occupy(port, t) {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
  } catch (error) {
    // A pre-existing server already proves that the historical port is busy.
    if (error.code !== "EADDRINUSE") throw error;
  }
}

function launch(t, { preview = false, env = {}, shell = false } = {}) {
  const childEnv = { ...process.env, PORT: "0" };
  delete childEnv.FRONTEND_PORT;
  delete childEnv.EXITZERO_BACKEND_URL;
  delete childEnv.EXITZERO_FRONTEND_DIR;
  delete childEnv.VITE_API_BASE_URL;
  Object.assign(childEnv, env);
  const child = shell
    ? spawn("bash", [fileURLToPath(new URL("../dev.sh", import.meta.url))], {
        cwd: "/tmp",
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      })
    : spawn(process.execPath, ["dev.mjs", ...(preview ? ["--preview"] : [])], {
        cwd: root,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
  const exited = once(child, "exit");
  let output = "";
  let app;
  let api;
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`Launcher exited ${code}: ${output}`)),
    );
    lines.on("line", (line) => {
      output += `${line}\n`;
      if (line.startsWith("  App:")) app = line.slice(6).trim();
      if (line.startsWith("  API:")) api = line.slice(6).trim();
      if (line.startsWith("  Proxy:")) resolve({ app, api });
    });
  });
  // Early-exit cases inspect the process status rather than awaiting readiness.
  ready.catch(() => {});
  async function stop() {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
    try {
      return await exited;
    } finally {
      clearTimeout(timeout);
      lines.close();
    }
  }
  t.after(stop);
  return { ready, stop, exited, output: () => output };
}

test(
  "dev.sh and a second launcher choose distinct ports despite occupied historical ports",
  { timeout: 180_000 },
  async (t) => {
    await occupy(3001, t);
    await occupy(5173, t);
    const first = launch(t, { shell: true });
    const a = await first.ready;
    const second = launch(t);
    const b = await second.ready;
    const ports = [a.app, a.api, b.app, b.api].map((url) => new URL(url).port);
    assert.equal(new Set(ports).size, 4);
    assert(!ports.includes("3001"));
    assert(!ports.includes("5173"));
    for (const { app, api } of [a, b]) {
      const page = await fetch(app);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<html/);
      for (const url of [api, new URL("api/health", app)]) {
        const response = await fetch(url, {
          headers: { origin: new URL(app).origin },
        });
        assert.deepEqual(await response.json(), {
          status: "ok",
          service: "exitzero",
        });
        assert.equal(
          response.headers.get("access-control-allow-origin"),
          new URL(app).origin,
        );
      }
    }
    const building = { ...example, max_steps: 2, time_step_seconds: 0.01 };
    const simulation = await fetch(new URL("api/simulate", a.app), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(building),
    });
    assert.equal(simulation.status, 200);
    const recording = await simulation.json();
    assert(recording.frames.length > 0);
    assert(
      recording.frames[0].agents.every(
        (agent) =>
          agent.planned_path &&
          agent.planned_path.waypoints.length > 0 &&
          agent.planned_path.waypoints.length <= 16,
      ),
    );
    const stream = await fetch(new URL("api/simulate/live", a.app), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(building),
    });
    assert.equal(stream.status, 200);
    const events = (await stream.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events[0].type, "frame");
    assert(
      events[0].frame.agents.every((agent) =>
        Array.isArray(agent.planned_path?.waypoints),
      ),
    );
    assert.equal(events.at(-1).type, "complete");
    await first.stop();
    await second.stop();
    for (const url of [a.app, a.api, b.app, b.api])
      await assert.rejects(fetch(url));
  },
);

test(
  "production preview also discovers its backend and proxies /api",
  { timeout: 180_000 },
  async (t) => {
    const run = launch(t, { preview: true });
    const { app, api } = await run.ready;
    assert.notEqual(new URL(app).port, new URL(api).port);
    assert.match(await (await fetch(app)).text(), /<html/);
    assert.deepEqual(await (await fetch(new URL("api/health", app))).json(), {
      status: "ok",
      service: "exitzero",
    });
    await run.stop();
    await assert.rejects(fetch(api));
  },
);

test(
  "explicit frontend preferences fall back, and reusing a backend does not take ownership of it",
  { timeout: 180_000 },
  async (t) => {
    const blocker = createServer();
    await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => blocker.close(resolve)));
    const owner = launch(t, { env: { FRONTEND_PORT: "0" } });
    const original = await owner.ready;
    const reused = launch(t, {
      env: {
        FRONTEND_PORT: String(blocker.address().port),
        EXITZERO_BACKEND_URL: new URL(original.api).origin,
      },
    });
    const shared = await reused.ready;
    assert.notEqual(new URL(shared.app).port, String(blocker.address().port));
    assert.equal(shared.api, original.api);
    assert(!reused.output().includes("Starting Rust backend"));
    assert.deepEqual(
      await (await fetch(new URL("api/health", shared.app))).json(),
      { status: "ok", service: "exitzero" },
    );
    await reused.stop();
    assert.equal((await fetch(original.api)).status, 200);
    await owner.stop();
  },
);

test(
  "invalid frontend ports and backend startup failures exit promptly",
  { timeout: 30_000 },
  async (t) => {
    const invalid = launch(t, { env: { FRONTEND_PORT: "invalid" } });
    assert.equal((await invalid.exited)[0], 1);
    assert.match(invalid.output(), /FRONTEND_PORT must be/);
    const failed = launch(t, { env: { PORT: "invalid" } });
    assert.notEqual((await failed.exited)[0], 0);
    assert.match(failed.output(), /PORT must be a valid port/);
  },
);

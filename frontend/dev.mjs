import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createServer, preview } from "vite";

const project = fileURLToPath(new URL("../", import.meta.url));
const root = fileURLToPath(new URL("./", import.meta.url));
const previewMode = process.argv.includes("--preview");
let backend;
let backendExited;
let frontend;
let stopping = false;

function signalBackend(signal) {
  if (!backend?.pid || backend.exitCode !== null || backend.signalCode !== null)
    return;
  try {
    if (process.platform === "win32") backend.kill(signal);
    else process.kill(-backend.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") console.error(error.message);
  }
}

async function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  signalBackend("SIGTERM");
  const force = setTimeout(() => signalBackend("SIGKILL"), 3000);
  force.unref();
  try {
    await Promise.all([frontend?.close(), backendExited]);
  } finally {
    clearTimeout(force);
  }
}

process.once("SIGINT", () => void stop(130));
process.once("SIGTERM", () => void stop(143));

function startBackend() {
  console.log("Starting Rust backend on an available port…");
  backend = spawn(
    "cargo",
    ["run", "--locked", "-p", "exitzero", "--bin", "exitzero"],
    {
      cwd: project,
      env: { ...process.env, PORT: process.env.PORT || "0" },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const output = createInterface({ input: backend.stdout });
  backendExited = new Promise((resolve) => {
    backend.once("exit", resolve);
    backend.once("error", resolve);
  });
  return new Promise((resolve, reject) => {
    backend.once("error", reject);
    backend.once("exit", (code, signal) => {
      output.close();
      reject(
        new Error(
          `Backend stopped (${signal ?? code}) before startup completed.`,
        ),
      );
      if (!stopping) {
        console.error(
          `Backend stopped (${signal ?? code}); stopping frontend.`,
        );
        void stop(code || 1);
      }
    });
    output.on("line", (line) => {
      console.log(line);
      const match = /^ExitZero listening on http:\/\/[^/]+:(\d+)$/.exec(line);
      if (match) resolve(`http://127.0.0.1:${match[1]}`);
    });
  });
}

try {
  const requestedPort = process.env.FRONTEND_PORT || "0";
  if (!/^\d+$/.test(requestedPort) || Number(requestedPort) > 65535)
    throw new Error(
      "FRONTEND_PORT must be between 0 and 65535 (0 chooses an available port).",
    );
  const backendUrl = process.env.EXITZERO_BACKEND_URL || (await startBackend());
  if (stopping) throw new Error("Startup cancelled.");
  const target = new URL(backendUrl);
  if (!["http:", "https:"].includes(target.protocol))
    throw new Error("EXITZERO_BACKEND_URL must be an HTTP(S) server URL.");
  // Vite's config uses this for both dev and preview; no port reservation race.
  process.env.EXITZERO_BACKEND_URL = target.origin;
  const config = {
    root,
    configFile: fileURLToPath(new URL("vite.config.ts", import.meta.url)),
    clearScreen: false,
  };
  frontend = previewMode ? await preview(config) : await createServer(config);
  if (stopping) {
    await frontend.close();
  } else {
    if (!previewMode) await frontend.listen();
    if (stopping) await frontend.close();
    else {
      frontend.httpServer.once("close", () => {
        if (!stopping) void stop(0);
      });
      const appUrl = frontend.resolvedUrls?.local[0];
      console.log(
        `\nExitZero ready${previewMode ? " (production preview)" : ""}`,
      );
      console.log(`  App:     ${appUrl}`);
      console.log(`  API:     ${target.origin}/api/health`);
      console.log(`  Proxy:   ${appUrl}api/health`);
      console.log("\nPress Ctrl+C to stop both servers.\n");
    }
  }
} catch (error) {
  if (!stopping) console.error(error.message);
  await stop(1);
}

#!/usr/bin/env bun
/**
 * Unified dev server — runs both the Hono backend and Vite frontend
 * in a single terminal. Ctrl+C kills both.
 */
import { spawn, type Subprocess } from "bun";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(__dirname);
const requestedApiPort = Number(process.env.COMPANION_DEV_API_PORT || process.env.PORT || "3458");
const requestedVitePort = Number(process.env.COMPANION_DEV_VITE_PORT || "5175");
const devSessionDir = process.env.COMPANION_DEV_SESSION_DIR;
const devRecordingsDir = process.env.COMPANION_DEV_RECORDINGS_DIR;

const procs: Subprocess[] = [];
let shuttingDown = false;

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function ensurePortAvailable(port: number, label: string): Promise<void> {
  const available = await isPortAvailable(port);
  if (!available) {
    console.error(
      `\x1b[31m[dev] ${label} port ${port} is already in use. Stop the stale process and rerun make dev.\x1b[0m`,
    );
    process.exit(1);
  }
}

function prefix(
  name: string,
  color: string,
  stream: ReadableStream<Uint8Array>,
  onLine?: (line: string) => void,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const reset = "\x1b[0m";
  (async () => {
    let remainder = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        const last = remainder.trim();
        if (last) {
          process.stdout.write(`${color}[${name}]${reset} ${last}\n`);
          onLine?.(last);
        }
        break;
      }
      const text = remainder + decoder.decode(value);
      const lines = text.split("\n");
      remainder = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          process.stdout.write(`${color}[${name}]${reset} ${line}\n`);
          onLine?.(line);
        }
      }
    }
  })();
}

// ── Cleanup on exit ───────────────────────────────────────────────
function cleanup(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) p.kill();
  process.exit(exitCode);
}

process.on("SIGINT", () => cleanup(0));
process.on("SIGTERM", () => cleanup(0));

async function start() {
  const devApiPort = requestedApiPort;
  const devVitePort = requestedVitePort;
  await ensurePortAvailable(devApiPort, "Backend");
  await ensurePortAvailable(devVitePort, "Vite");
  console.log(
    `\x1b[36m[dev] API: http://localhost:${devApiPort} | UI: http://localhost:${devVitePort}\x1b[0m`,
  );

  const backendEnv: Record<string, string> = {
    ...process.env,
    NODE_ENV: "development",
    PORT: String(devApiPort),
    COMPANION_DEV_VITE_PORT: String(devVitePort),
  };
  if (devSessionDir) backendEnv.COMPANION_SESSION_DIR = devSessionDir;
  if (devRecordingsDir) backendEnv.COMPANION_RECORDINGS_DIR = devRecordingsDir;

  // ── Backend (Hono on Bun) ────────────────────────────────────────
  const backend = spawn(["bun", "--watch", "server/index.ts"], {
    cwd: webDir,
    stdout: "pipe",
    stderr: "pipe",
    env: backendEnv,
  });
  procs.push(backend);

  let markReady: ((line: string) => void) | null = null;
  const backendReady = new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok);
    };

    markReady = (line: string) => {
      if (line.includes("Server running on http://")) {
        finish(true);
      }
    };

    backend.exited.then(() => finish(false));
  });

  prefix("api", "\x1b[36m", backend.stdout, (line) => markReady?.(line));
  prefix("api", "\x1b[31m", backend.stderr, (line) => markReady?.(line));

  const ready = await backendReady;
  if (!ready) {
    console.error("\x1b[31mAPI server exited before becoming ready.\x1b[0m");
    cleanup(1);
    return;
  }

  // ── Vite (frontend HMR) ─────────────────────────────────────────
  const vite = spawn(["bun", "run", "dev:vite"], {
    cwd: webDir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NODE_ENV: "development",
      VITE_PORT: String(devVitePort),
      VITE_API_PORT: String(devApiPort),
    },
  });
  procs.push(vite);
  prefix("vite", "\x1b[35m", vite.stdout);
  prefix("vite", "\x1b[31m", vite.stderr);

  // If either process exits unexpectedly, kill the other and exit.
  const loser = await Promise.race([
    backend.exited.then((code) => ({ name: "api", code })),
    vite.exited.then((code) => ({ name: "vite", code })),
  ]);
  console.error(
    `\x1b[31m[${loser.name}] exited with code ${loser.code}, shutting down...\x1b[0m`,
  );
  cleanup(typeof loser.code === "number" ? loser.code : 1);
}

void start();

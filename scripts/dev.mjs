/**
 * Full local stack: Cursor companion (8787) + Vite/CRXJS.
 * Reuses healthy processes. Never kills an existing Vite.
 *
 * Usage: npm run dev
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION_HOST = "127.0.0.1";
const COMPANION_PORT = Number(process.env.MONACLE_PORT || 8787);
const VITE_PORTS = [5173, 5174, 5175, 5176];

const children = [];
let shuttingDown = false;

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[dev ${ts}] ${msg}`);
}

function probeHttp(url, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode != null && res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function portOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port }, () => {
      socket.end();
      resolve(true);
    });
    socket.setTimeout(500);
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function companionUp() {
  return probeHttp(`http://${COMPANION_HOST}:${COMPANION_PORT}/health`);
}

async function viteUp() {
  for (const port of VITE_PORTS) {
    // Vite on macOS often binds [::1], not 127.0.0.1
    if (await probeHttp(`http://localhost:${port}/`)) return port;
    if (await portOpen("127.0.0.1", port)) return port;
  }
  return null;
}

function resolveAgent() {
  const candidates = [
    process.env.CURSOR_AGENT,
    "agent",
    path.join(os.homedir(), ".local/bin/agent"),
    path.join(os.homedir(), ".cursor/bin/agent"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === "agent") return c;
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function spawnChild(label, command, args, opts = {}) {
  log(`starting ${label}: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, PATH: `${os.homedir()}/.local/bin:${process.env.PATH || ""}` },
    stdio: "inherit",
    shell: false,
    ...opts,
  });
  children.push({ label, child });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    log(`${label} exited code=${code} signal=${signal || ""}`);
    // If Vite dies, tear everything down so the agent notices.
    if (label === "vite") shutdown(code ?? 1);
  });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down children started by this script…");
  for (const { label, child } of children) {
    if (child.exitCode != null || child.killed) continue;
    log(`stopping ${label} (pid ${child.pid})`);
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  // Force after a beat if needed
  setTimeout(() => {
    for (const { child } of children) {
      if (child.exitCode == null && !child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    process.exit(code);
  }, 1500).unref();
}

async function checkAgentLogin() {
  const agent = resolveAgent();
  if (!agent) {
    console.log(`
┌────────────────────────────────────────────────────────────┐
│  Cursor CLI (agent) not found on PATH.                     │
│  Install: curl https://cursor.com/install -fsS | bash      │
│  Then:    agent login                                      │
│  Companion is up; /restyle will fail until CLI is ready.   │
└────────────────────────────────────────────────────────────┘
`);
    return;
  }

  // Best-effort: `agent status` / whoami varies by CLI version — probe with --help.
  await new Promise((resolve) => {
    const probe = spawn(agent, ["--help"], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    probe.on("error", () => {
      console.log(`
┌────────────────────────────────────────────────────────────┐
│  Could not run Cursor CLI (${agent}).                      │
│  Run: agent login                                          │
└────────────────────────────────────────────────────────────┘
`);
      done();
    });
    probe.on("close", () => done());
    setTimeout(() => {
      try {
        probe.kill("SIGTERM");
      } catch {
        // ignore
      }
      done();
    }, 3000);
  });

  console.log(`
┌────────────────────────────────────────────────────────────┐
│  Dev stack ready                                           │
│  • Companion: http://${COMPANION_HOST}:${COMPANION_PORT}  (multi-session)     │
│  • Vite/CRX:  http://localhost:5173 (or next free port)    │
│  If restyles fail with auth: run \`agent login\` here.        │
│  Sidepanel + npm run loop can share this companion.        │
└────────────────────────────────────────────────────────────┘
`);
}

async function ensurePageStage() {
  const stageJs = path.join(root, "src/page/threeStage.js");
  const stageTs = path.join(root, "src/page/threeStage.ts");
  if (!fs.existsSync(stageTs)) return;
  const needsBuild =
    !fs.existsSync(stageJs) ||
    fs.statSync(stageTs).mtimeMs > fs.statSync(stageJs).mtimeMs;
  if (!needsBuild) return;
  log("building page threeStage.js for CRXJS WAR…");
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "scripts/build-page-stage.mjs")], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`build-page-stage exited ${code}`)),
    );
    child.on("error", reject);
  });
}

async function main() {
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  await ensurePageStage();

  if (await companionUp()) {
    log(`companion already healthy on ${COMPANION_HOST}:${COMPANION_PORT} — leaving it`);
  } else {
    spawnChild("companion", process.execPath, [
      path.join(root, "scripts/cursor-companion.mjs"),
    ]);
    // Wait briefly for health
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (await companionUp()) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!(await companionUp())) {
      log("warning: companion did not become healthy yet — check logs/companion.log");
    } else {
      log(`companion listening on http://${COMPANION_HOST}:${COMPANION_PORT}`);
    }
  }

  const existingVite = await viteUp();
  if (existingVite != null) {
    log(`Vite already healthy on port ${existingVite} — leaving it alone`);
  } else {
    // Prefer local vite binary
    const viteBin = path.join(root, "node_modules/vite/bin/vite.js");
    if (fs.existsSync(viteBin)) {
      spawnChild("vite", process.execPath, [viteBin]);
    } else {
      spawnChild("vite", "npx", ["vite"]);
    }
  }

  await checkAgentLogin();

  // Keep process alive while children run
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  shutdown(1);
});

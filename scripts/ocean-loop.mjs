/**
 * Headed Chrome debug loop for Monacle restyles.
 *
 * Prerequisites: npm run dev (Vite + companion), agent login when prompted.
 *
 *   npm run loop
 *   npm run loop -- --fixture
 *   npm run loop -- --url https://www.bicrick.com/about
 *   npm run loop -- --replay logs/loop/last-patch.json
 *   npm run loop -- --hold 30000
 *
 * Live mode POSTs /restyle to the companion, saves the patch, applies it,
 * holds, probes extension health, writes logs/loop/<timestamp>/.
 * Replay mode skips the CLI and re-applies last-patch.json (fast crash iteration).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const fixture = path.join(__dirname, "fixtures/blog.html");
const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const companionBase = (
  process.env.MONACLE_COMPANION || "http://127.0.0.1:8787"
).replace(/\/$/, "");

/** Minimal patch extract (mirrors src/patches/schema extractPatchFromText). */
function extractPatchFromText(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // keep trying
    }
  }
  return null;
}

function loadSystemPrompt() {
  const src = fs.readFileSync(
    path.join(root, "src/agent/systemPrompt.ts"),
    "utf8",
  );
  const match = src.match(/export const SYSTEM_PROMPT = `([\s\S]*)`;\s*$/);
  if (!match) {
    return "You are Monacle. Reply with one JSON patch (css, ops, overlayHtml, runtime).";
  }
  return match[1].replace(/\\`/g, "`").replace(/\\\$/g, "$");
}

const SYSTEM_PROMPT = loadSystemPrompt();

function parseArgs(argv) {
  const out = {
    url: process.env.MONACLE_LOOP_URL || "https://www.bicrick.com/about",
    prompt:
      process.env.MONACLE_LOOP_PROMPT ||
      "Make it look like I am wathcing from under the ocean. Waves, coral, fish",
    hold: Number(process.env.MONACLE_HOLD_MS || 30_000),
    replay: null,
    fixture: false,
    build: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.url = argv[++i];
    else if (a === "--prompt") out.prompt = argv[++i];
    else if (a === "--hold") out.hold = Number(argv[++i]);
    else if (a === "--replay") out.replay = argv[++i];
    else if (a === "--fixture") out.fixture = true;
    else if (a === "--no-build") out.build = false;
  }
  return out;
}

function log(msg) {
  console.log(`[loop] ${msg}`);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

async function companionHealth() {
  try {
    const res = await fetch(`${companionBase}/health`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function companionLogs(limit = 120) {
  try {
    const res = await fetch(`${companionBase}/logs`);
    if (!res.ok) return "";
    const data = await res.json();
    return data.text || (data.lines || []).slice(-limit).join("\n");
  } catch {
    return "";
  }
}

function serveFixture() {
  const html = fs.readFileSync(fixture);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve({ server, url: `http://127.0.0.1:${addr.port}/` });
    });
  });
}

async function getWorker(browser, extId) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const t of browser.targets()) {
      if (
        t.type() === "service_worker" &&
        t.url().includes(`chrome-extension://${extId}/`)
      ) {
        const w = await t.worker();
        if (w) return w;
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("service worker not found — extension likely crashed");
}

function runBuild() {
  return new Promise((resolve, reject) => {
    log("building dist/ …");
    const child = spawn("npm", ["run", "build"], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm run build exited ${code}`));
    });
  });
}

async function fetchSnapshot(worker, pageUrl) {
  return worker.evaluate(async (targetUrl) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url && t.url.startsWith(targetUrl));
    if (!tab?.id) return { ok: false, error: "tab not found" };
    try {
      const snap = await chrome.tabs.sendMessage(tab.id, {
        type: "GET_SNAPSHOT",
      });
      if (snap?.type !== "SNAPSHOT") {
        return { ok: false, error: "bad snapshot response" };
      }
      return { ok: true, tabId: tab.id, context: snap.context };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }, pageUrl);
}

async function applyPatch(worker, pageUrl, patch) {
  return worker.evaluate(
    async (targetUrl, p) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url && t.url.startsWith(targetUrl));
      if (!tab?.id) return { ok: false, error: "tab not found" };
      try {
        const applied = await chrome.tabs.sendMessage(tab.id, {
          type: "APPLY_PATCH",
          patch: p,
        });
        return {
          ok: applied?.type === "PATCH_APPLIED" ? !!applied.ok : true,
          applied,
        };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
    pageUrl,
    patch,
  );
}

async function probe(worker, pageUrl) {
  return worker.evaluate(async (targetUrl) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url && t.url.startsWith(targetUrl));
    if (!tab?.id) return { ok: false, error: "tab missing after hold" };
    try {
      const snap = await chrome.tabs.sendMessage(tab.id, {
        type: "GET_SNAPSHOT",
      });
      const state = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
          monacleOn: document.documentElement.getAttribute("data-monacle"),
          overlay: !!document.getElementById("monacle-overlay"),
          frame: !!document.getElementById("monacle-runtime-frame"),
          inserts: document.querySelectorAll("[data-monacle-insert]").length,
          video: !!document.querySelector("video"),
          title: document.title,
        }),
      });
      return {
        ok: true,
        snap: snap?.type === "SNAPSHOT",
        state: state?.[0]?.result,
      };
    } catch (e) {
      return { ok: false, error: String(e), crashed: true };
    }
  }, pageUrl);
}

async function liveRestyle(prompt, context) {
  const res = await fetch(`${companionBase}/restyle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemPrompt: SYSTEM_PROMPT,
      prompt,
      history: [],
      context,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(
      body.error || `companion /restyle ${res.status}`,
    );
    err.code =
      /login|auth|ENOENT|not found/i.test(String(body.error || ""))
        ? "AUTH_REQUIRED"
        : "RESTYLE_FAILED";
    err.logs = body.logs;
    throw err;
  }
  const text = body.text || "";
  const patch = extractPatchFromText(text);
  if (!patch) {
    const err = new Error("Companion returned no valid JSON patch");
    err.code = "NO_PATCH";
    err.text = text.slice(0, 2000);
    throw err;
  }
  return { text, patch };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(root, "logs/loop", stamp);
  ensureDir(outDir);
  ensureDir(path.join(root, "logs/loop"));

  const health = await companionHealth();
  if (!health?.ok) {
    console.error(`
Companion not reachable at ${companionBase}
Start the stack first:

  npm run dev

Then re-run: npm run loop
`);
    process.exit(2);
  }
  log(`companion ok (${health.agent || "agent"})`);

  if (args.build || !fs.existsSync(path.join(dist, "manifest.json"))) {
    await runBuild();
  }
  assert.ok(
    fs.existsSync(path.join(dist, "src/sandbox/sandbox.html")),
    "dist sandbox.html missing",
  );

  let fixtureServer = null;
  let pageUrl = args.url;
  if (args.fixture) {
    fixtureServer = await serveFixture();
    pageUrl = fixtureServer.url;
    log(`fixture at ${pageUrl}`);
  } else {
    log(`target ${pageUrl}`);
  }

  const userDataDir = fs.mkdtempSync(path.join(root, ".chrome-loop-"));
  let browser;
  const pageErrors = [];
  let passed = false;
  let failReason = "";

  try {
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: false,
      userDataDir,
      enableExtensions: true,
      args: ["--enable-unsafe-extension-debugging", "--no-first-run"],
      defaultViewport: { width: 1280, height: 800 },
    });

    const extId = await browser.installExtension(dist);
    log(`extension ${extId}`);
    fs.writeFileSync(
      path.join(outDir, "meta.json"),
      JSON.stringify({ extId, pageUrl, prompt: args.prompt, hold: args.hold }, null, 2),
    );

    const page = await browser.newPage();
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    page.on("error", (err) => pageErrors.push(`page crash: ${err}`));
    await page.goto(pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await new Promise((r) => setTimeout(r, 1200));

    let worker = await getWorker(browser, extId);
    const snap = await fetchSnapshot(worker, pageUrl);
    if (!snap.ok) {
      throw new Error(`snapshot failed: ${snap.error}`);
    }
    fs.writeFileSync(
      path.join(outDir, "snapshot.json"),
      JSON.stringify(snap.context, null, 2),
    );

    let patch;
    let rawText = "";
    if (args.replay) {
      const replayPath = path.isAbsolute(args.replay)
        ? args.replay
        : path.join(root, args.replay);
      log(`replay ${replayPath}`);
      patch = JSON.parse(fs.readFileSync(replayPath, "utf8"));
    } else {
      log(`live /restyle: ${JSON.stringify(args.prompt.slice(0, 80))}`);
      try {
        const live = await liveRestyle(args.prompt, snap.context);
        patch = live.patch;
        rawText = live.text;
      } catch (err) {
        if (err.code === "AUTH_REQUIRED") {
          console.error(`
AUTH_REQUIRED — Cursor CLI needs login.

  agent login

Then: npm run loop
`);
          process.exit(3);
        }
        throw err;
      }
      fs.writeFileSync(path.join(outDir, "restyle-raw.txt"), rawText);
      fs.writeFileSync(
        path.join(outDir, "patch.json"),
        JSON.stringify(patch, null, 2),
      );
      fs.writeFileSync(
        path.join(root, "logs/loop/last-patch.json"),
        JSON.stringify(patch, null, 2),
      );
      log("saved logs/loop/last-patch.json");
    }

    const applied = await applyPatch(worker, pageUrl, patch);
    fs.writeFileSync(
      path.join(outDir, "apply.json"),
      JSON.stringify(applied, null, 2),
    );
    if (!applied.ok) {
      failReason = `apply failed: ${applied.error || JSON.stringify(applied)}`;
      throw new Error(failReason);
    }
    log(`applied; holding ${args.hold}ms — watch the Chrome window`);

    await page.screenshot({
      path: path.join(outDir, "after-apply.png"),
      fullPage: false,
    });

    await new Promise((r) => setTimeout(r, args.hold));

    // Re-resolve worker — crash invalidates the old one.
    try {
      worker = await getWorker(browser, extId);
    } catch (err) {
      failReason = `extension crashed during hold: ${err.message}`;
      throw new Error(failReason);
    }

    const result = await probe(worker, pageUrl);
    fs.writeFileSync(
      path.join(outDir, "probe.json"),
      JSON.stringify(result, null, 2),
    );
    await page.screenshot({
      path: path.join(outDir, "after-hold.png"),
      fullPage: false,
    });

    if (!result.ok || result.crashed) {
      failReason = `probe failed: ${result.error || "unknown"}`;
      throw new Error(failReason);
    }
    if (result.state?.monacleOn !== "on" || !result.state?.overlay) {
      failReason = `scene gone after hold: ${JSON.stringify(result.state)}`;
      throw new Error(failReason);
    }

    passed = true;
    log("PASS — scene survived hold, service worker alive");
    console.log(JSON.stringify(result.state, null, 2));
  } catch (err) {
    failReason = failReason || (err instanceof Error ? err.message : String(err));
    log(`FAIL — ${failReason}`);
    passed = false;
  } finally {
    const logs = await companionLogs();
    fs.writeFileSync(path.join(outDir, "companion-tail.log"), logs);
    fs.writeFileSync(
      path.join(outDir, "page-errors.json"),
      JSON.stringify(pageErrors, null, 2),
    );
    fs.writeFileSync(
      path.join(outDir, "result.json"),
      JSON.stringify({ passed, failReason, outDir }, null, 2),
    );
    await browser?.close().catch(() => {});
    fixtureServer?.server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  log(`artifacts: ${outDir}`);
  if (!passed) {
    log("iterate: fix code, then npm run loop -- --replay logs/loop/last-patch.json");
    process.exit(1);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

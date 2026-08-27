/**
 * Shared helpers for headed Chrome restyle loops (ocean-loop, style-sequence).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(__dirname, "..");
export const dist = path.join(root, "dist");
export const fixturePath = path.join(__dirname, "fixtures/blog.html");
export const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const companionBase = (
  process.env.MONACLE_COMPANION || "http://127.0.0.1:8787"
).replace(/\/$/, "");

/** Minimal patch extract (mirrors src/patches/schema extractPatchFromText). */
export function extractPatchFromText(text) {
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

export function loadSystemPrompt() {
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

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

export function slugify(label) {
  return String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

export async function companionHealth() {
  try {
    const res = await fetch(`${companionBase}/health`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function companionLogs(limit = 120) {
  try {
    const res = await fetch(`${companionBase}/logs`);
    if (!res.ok) return "";
    const data = await res.json();
    return data.text || (data.lines || []).slice(-limit).join("\n");
  } catch {
    return "";
  }
}

export function serveFixture(htmlPath = fixturePath) {
  const html = fs.readFileSync(htmlPath);
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

export async function getWorker(browser, extId) {
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

export function runBuild(log = console.log) {
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

export async function fetchSnapshot(worker, pageUrl) {
  return worker.evaluate(async (targetUrl) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url && t.url.startsWith(targetUrl));
    if (!tab?.id) {
      return {
        ok: false,
        error: "tab not found",
        urls: tabs.map((t) => t.url).filter(Boolean).slice(0, 8),
      };
    }
    try {
      const snap = await chrome.tabs.sendMessage(tab.id, {
        type: "GET_SNAPSHOT",
      });
      if (snap?.type !== "SNAPSHOT") {
        return { ok: false, error: "bad snapshot response", tabId: tab.id };
      }
      return { ok: true, tabId: tab.id, context: snap.context };
    } catch (e) {
      return { ok: false, error: String(e), tabId: tab.id, tabUrl: tab.url };
    }
  }, pageUrl);
}

/** Poll until the content script answers GET_SNAPSHOT (YouTube / SPA cold start). */
export async function awaitContentScript(
  getWorkerFn,
  browser,
  extId,
  pageUrl,
  {
    timeoutMs = 30000,
    intervalMs = 500,
    log = () => {},
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const worker = await getWorkerFn(browser, extId);
    last = await fetchSnapshot(worker, pageUrl);
    if (last.ok) return last;
    log(`content script not ready: ${last.error}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last || { ok: false, error: "content script timeout" };
}

export async function applyPatch(worker, pageUrl, patch) {
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

export async function probe(worker, pageUrl) {
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
          threeRoot: !!document.getElementById("monacle-three-root"),
          video: !!document.querySelector("video"),
          moviePlayer: !!document.querySelector("#movie_player"),
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

/** DOM probe via the Puppeteer page (avoids SW↔tab round-trip on heavy sites). */
export async function probePage(page) {
  try {
    const state = await page.evaluate(() => ({
      monacleOn: document.documentElement.getAttribute("data-monacle"),
      overlay: !!document.getElementById("monacle-overlay"),
      frame: !!document.getElementById("monacle-runtime-frame"),
      inserts: document.querySelectorAll("[data-monacle-insert]").length,
      threeRoot: !!document.getElementById("monacle-three-root"),
      video: !!document.querySelector("video"),
      moviePlayer: !!document.querySelector("#movie_player"),
      title: document.title,
      paused: document.querySelector("video")?.paused ?? null,
      currentTime: document.querySelector("video")?.currentTime ?? null,
    }));
    return { ok: true, snap: true, state, via: "page" };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      crashed: true,
      via: "page",
    };
  }
}

export async function liveRestyle(prompt, context, systemPrompt, opts = {}) {
  const sessionId =
    opts.sessionId ||
    `loop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const source = opts.source || "loop";
  const res = await fetch(`${companionBase}/restyle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId,
      source,
      systemPrompt,
      prompt,
      history: [],
      context,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const busy = res.status === 429 || res.status === 409;
    const err = new Error(body.error || `companion /restyle ${res.status}`);
    err.code = /login|auth|ENOENT|not found/i.test(String(body.error || ""))
      ? "AUTH_REQUIRED"
      : busy
        ? "BUSY"
        : "RESTYLE_FAILED";
    err.logs = body.logs;
    err.sessionId = body.sessionId || sessionId;
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
  return { text, patch, sessionId: body.sessionId || sessionId };
}

export function requireCompanionOrExit(health, logLabel = "loop") {
  if (health?.ok) return;
  console.error(`
Companion not reachable at ${companionBase}
Start the stack first:

  npm run dev

Then re-run: npm run ${logLabel}
`);
  process.exit(2);
}

export function authRequiredExit(retryCmd) {
  console.error(`
AUTH_REQUIRED — Cursor CLI needs login.

  agent login

Then: ${retryCmd}
`);
  process.exit(3);
}

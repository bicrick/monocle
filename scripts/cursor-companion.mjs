/**
 * Local bridge: Chrome talks to 127.0.0.1, this process runs your Cursor CLI.
 * Concurrent /restyle sessions so the sidepanel and autonomous loops can
 * share one companion. Persistent remote machines later use the same contract.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ingestRaw,
  logPath,
  recentText,
  writeLog,
} from "./companion-log.mjs";
import {
  SessionError,
  activeCount,
  beginRun,
  endRun,
  ingestChunk,
  ingestPayload,
  ingestStep,
  ingestThinking,
  listSnapshots,
  maxConcurrent,
  snapshot,
  setSessionOrigin,
  requestTool,
  resolveTool,
  cancelPendingTool,
} from "./companion-status.mjs";
import { createStreamParser } from "./cli-stream.mjs";
import { fallbackCatalog, parseListModels } from "./cli-models.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.MONACLE_PORT || 8787);
const AGENT_TIMEOUT_MS = Number(process.env.MONACLE_AGENT_TIMEOUT_MS || 240_000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TAB_MCP_SCRIPT = path.join(__dirname, "monacle-tab-mcp.mjs");
const AGENT_CANDIDATES = [
  process.env.CURSOR_AGENT,
  "agent",
  path.join(os.homedir(), ".local/bin/agent"),
  path.join(os.homedir(), ".cursor/bin/agent"),
].filter(Boolean);

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

function json(res, status, body) {
  cors(res);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function resolveAgent() {
  for (const candidate of AGENT_CANDIDATES) {
    if (candidate === "agent") return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }
  return "agent";
}

function extForMime(mime) {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  return "jpg";
}

/** Write pasted images to disk so Cursor CLI can read them via file tools. */
function writeImages(images) {
  if (!Array.isArray(images) || !images.length) {
    return { dir: null, paths: [] };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monacle-img-"));
  const paths = [];
  images.slice(0, 5).forEach((img, i) => {
    const safe =
      typeof img.name === "string" && img.name.trim()
        ? img.name.replace(/[^\w.\-]+/g, "_")
        : `paste-${i + 1}.${extForMime(img.mimeType || "image/png")}`;
    const filePath = path.join(dir, safe);
    fs.writeFileSync(filePath, Buffer.from(img.dataBase64 || "", "base64"));
    paths.push(filePath);
  });
  return { dir, paths };
}

function chatWorkspace(sessionId) {
  const safe = String(sessionId || "anon").replace(/[^a-zA-Z0-9._-]+/g, "_");
  const dir = path.join(os.homedir(), ".monacle", "agent-chats", safe);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Point Cursor CLI (cwd = chat workspace) at Monacle tab tools. */
function ensureTabMcp(sessionId) {
  const cwd = chatWorkspace(sessionId);
  const cursorDir = path.join(cwd, ".cursor");
  fs.mkdirSync(cursorDir, { recursive: true });
  const mcpPath = path.join(cursorDir, "mcp.json");
  const config = {
    mcpServers: {
      "monacle-tab": {
        command: process.execPath,
        args: [TAB_MCP_SCRIPT],
        env: {
          MONACLE_SESSION_ID: String(sessionId || ""),
          MONACLE_COMPANION: `http://${HOST}:${PORT}`,
        },
      },
    },
  };
  fs.writeFileSync(mcpPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  // Best-effort: put monacle-tab on the local approved list before -p spawn.
  try {
    const agent = resolveAgent();
    const child = spawn(agent, ["mcp", "enable", "monacle-tab"], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("close", (code) => {
      if (code !== 0) {
        writeLog(
          `mcp enable monacle-tab exit=${code} ${stderr.trim().slice(0, 120)}`,
          { echo: false, session: sessionId },
        );
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeLog(`mcp enable failed: ${message}`, {
      echo: false,
      session: sessionId,
    });
  }
}

/** @type {Map<string, import("node:child_process").ChildProcess>} */
const liveChildren = new Map();

function registerChild(sessionId, child) {
  liveChildren.set(sessionId, child);
  const clear = () => {
    if (liveChildren.get(sessionId) === child) liveChildren.delete(sessionId);
  };
  child.on("close", clear);
  child.on("error", clear);
}

function stopAgent(sessionId) {
  cancelPendingTool(sessionId, "Agent stopped");
  const child = liveChildren.get(sessionId);
  if (!child) return false;
  writeLog("cli stop requested — SIGTERM", { session: sessionId });
  try {
    child.kill("SIGTERM");
  } catch {
    return false;
  }
  setTimeout(() => {
    if (liveChildren.get(sessionId) === child && child.exitCode == null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }, 1500);
  return true;
}

const MODELS_TTL_MS = 10 * 60 * 1000;
/** @type {{ at: number, catalog: ReturnType<typeof parseListModels> } | null} */
let modelsCache = null;
/** @type {Promise<ReturnType<typeof parseListModels>> | null} */
let modelsInflight = null;

function listModelsRaw() {
  return new Promise((resolve, reject) => {
    const agent = resolveAgent();
    const child = spawn(agent, ["--list-models"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      reject(new Error("Cursor CLI --list-models timed out"));
    }, 20_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(
          new Error(
            "Cursor CLI not found. Install with: curl https://cursor.com/install -fsS | bash — then run: agent login",
          ),
        );
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() || stdout.trim() || `agent --list-models exited ${code}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

async function loadModelCatalog() {
  if (modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) {
    return modelsCache.catalog;
  }
  if (modelsInflight) return modelsInflight;
  modelsInflight = (async () => {
    try {
      const text = await listModelsRaw();
      const catalog = parseListModels(text);
      modelsCache = { at: Date.now(), catalog };
      writeLog(
        `models listed n=${catalog.models.length} source=${catalog.source}`,
        { echo: false },
      );
      return catalog;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeLog(`GET /models fallback: ${message}`, { echo: false });
      const catalog = { ...fallbackCatalog(), error: message };
      return catalog;
    } finally {
      modelsInflight = null;
    }
  })();
  return modelsInflight;
}

function runAgent(prompt, model, sessionId, opts = {}) {
  const agent = resolveAgent();
  const resumeId =
    typeof opts.resumeId === "string" && opts.resumeId.trim()
      ? opts.resumeId.trim()
      : null;
  // Stable cwd per Monacle chat so --resume can find prior CLI state.
  const cwd = chatWorkspace(sessionId);
  // Default mode (omit --mode) = full agent with tools. CLI only allows
  // --mode plan|ask (read-only). Cwd is ~/.monacle/agent-chats/<id>/ — not the repo.
  ensureTabMcp(sessionId);
  const args = [
    "-p",
    "--trust",
    "--force",
    "--approve-mcps",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
  ];
  if (resumeId) args.push("--resume", resumeId);
  if (model) args.push("--model", model);
  args.push(prompt);

  return new Promise((resolve, reject) => {
    const child = spawn(agent, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    registerChild(sessionId, child);

    writeLog(
      `cli spawn ${agent}${resumeId ? ` --resume ${resumeId}` : ""} timeout=${AGENT_TIMEOUT_MS}ms`,
      {
        echo: false,
        session: sessionId,
      },
    );
    writeLog(
      resumeId
        ? "Cursor agent resumed — streaming thinking & tools…"
        : "Cursor agent started — streaming thinking & tools…",
      {
        session: sessionId,
      },
    );

    const parser = createStreamParser({
      onStep: (line) => {
        writeLog(line, { session: sessionId });
        ingestStep(sessionId, line);
      },
      onThinking: (full) => {
        ingestThinking(sessionId, full);
      },
      onPayload: (text) => {
        ingestPayload(sessionId, text);
      },
    });

    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };

    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      ingestRaw(text, "out");
      parser.push(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (t) {
          writeLog(`[err] ${t}`, {
            echo: false,
            ring: false,
            session: sessionId,
          });
        }
      }
      ingestChunk(sessionId, text);
    });

    const timer = setTimeout(() => {
      writeLog(`cli timeout after ${AGENT_TIMEOUT_MS}ms — sending SIGTERM`, {
        session: sessionId,
      });
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode == null) child.kill("SIGKILL");
      }, 2000);
      finish(() =>
        reject(
          new Error(
            `Cursor CLI timed out after ${Math.round(AGENT_TIMEOUT_MS / 1000)}s`,
          ),
        ),
      );
    }, AGENT_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        finish(() =>
          reject(
            new Error(
              "Cursor CLI not found. Install with: curl https://cursor.com/install -fsS | bash — then run: agent login",
            ),
          ),
        );
        return;
      }
      finish(() => reject(err));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      parser.flush();
      const text = parser.finalText();
      const cursorSessionId = parser.cursorSessionId() || resumeId || null;
      writeLog(
        `cli exit ${code} result=${text.length}b cursorSession=${cursorSessionId || "-"}`,
        {
          echo: false,
          session: sessionId,
        },
      );
      // Keep ~/.monacle/agent-chats/<id> so follow-ups can --resume.
      if (code !== 0) {
        finish(() =>
          reject(
            new Error(
              stderr.trim() ||
                text.trim() ||
                `Cursor CLI exited ${code}. Try: agent login`,
            ),
          ),
        );
        return;
      }
      finish(() =>
        resolve({
          text: text.trim(),
          cursorSessionId,
        }),
      );
    });
  });
}

function buildPrompt(body, imagePaths) {
  const resumeId =
    typeof body.resumeId === "string" && body.resumeId.trim()
      ? body.resumeId.trim()
      : typeof body.cursorSessionId === "string" && body.cursorSessionId.trim()
        ? body.cursorSessionId.trim()
        : null;
  // When resuming a Cursor chat, CLI already has prior turns — avoid dumping
  // a full PRIOR TURNS transcript on top of that.
  const history =
    !resumeId && Array.isArray(body.history)
      ? body.history
          .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
          .join("\n\n")
      : "";

  const imageBlock =
    imagePaths.length > 0
      ? [
          "USER IMAGES (read these files with your tools — they are screenshots/pastes from the user):",
          ...imagePaths.map((p) => `- ${p}`),
          "",
        ].join("\n")
      : "";

  return [
    body.systemPrompt || "",
    "",
    "Do not edit any files in this workspace. Your cwd is an isolated Monacle chat folder.",
    "Tab tools (MCP monacle-tab): read_page, list_links, navigate — call them only when you need live page content or other same-origin pages. Conversational turns do not require tools.",
    "Do not narrate intent as your final answer. After any tools, the JSON \"message\" must be the actual answer to the user (summary, reply, etc.) — never only \"I'll look…\" / \"I'll read…\".",
    "Reply with one final JSON object that always includes a conversational \"message\".",
    "The sidepanel already greeted the user — do not greet again.",
    "If the user is asking, clarifying, or chatting (and you already have enough context from history/tools): message-only JSON {\"message\":\"...\"}.",
    "If they want the page restyled, include css + ops + overlayHtml + runtime as needed along with message.",
    "A CSS-only patch is a failure when the user asked for a dynamic or environmental change — include runtime JS using monacle.*.",
    "For 3D / 3js / moon: use monacle.three.* (bundled page-world Three.js). Do not use CDN Three, new THREE.WebGLRenderer, getContext('webgl'), or monacle.canvas(). DOM motion may use monacle.create().",
    "If this is a follow-up in the same chat, modify the existing scene (incremental) unless the user asks for a full reset.",
    "If you emit a javascript fence instead of JSON, it is applied as live runtime on the page (not a sandbox).",
    "",
    history ? `PRIOR TURNS:\n${history}\n` : "",
    resumeId ? "FOLLOW-UP TURN (same chat — continue the conversation and existing scene).\n" : "",
    "TAB (light — use read_page for full text when needed):",
    JSON.stringify(
      {
        url: body.context?.url,
        title: body.context?.title,
        viewport: body.context?.viewport,
        media: body.context?.media,
        landmarks: body.context?.landmarks,
        lastRuntimeError: body.context?.lastRuntimeError,
      },
      null,
      2,
    ),
    "",
    imageBlock,
    "USER:",
    body.prompt || "(see attached images)",
  ]
    .filter((x) => x != null)
    .join("\n");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

  if (req.method === "GET" && url.pathname === "/status") {
    const sessionId = url.searchParams.get("session");
    json(res, 200, {
      ...snapshot(sessionId),
      logPath: logPath(),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/sessions") {
    json(res, 200, {
      active: activeCount(),
      maxConcurrent: maxConcurrent(),
      sessions: listSnapshots(),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/logs") {
    const status = snapshot();
    json(res, 200, {
      logPath: logPath(),
      running: status.running,
      active: activeCount(),
      sessions: status.sessions || [],
      lines: recentText(250).split("\n").filter(Boolean),
      text: recentText(250),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/models") {
    const catalog = await loadModelCatalog();
    json(res, 200, catalog);
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, {
      ok: true,
      agent: resolveAgent(),
      host: HOST,
      port: PORT,
      logPath: logPath(),
      activeSessions: activeCount(),
      maxConcurrent: maxConcurrent(),
      sessions: listSnapshots().filter((s) => s.running),
    });
    return;
  }

  if (
    (req.method === "POST" || req.method === "GET") &&
    url.pathname === "/stop"
  ) {
    let body = {};
    if (req.method === "POST") {
      try {
        body = await readBody(req);
      } catch {
        body = {};
      }
    }
    const sessionId =
      body.sessionId || body.session || url.searchParams.get("session");
    if (!sessionId) {
      json(res, 400, { error: "Missing sessionId" });
      return;
    }
    const killed = stopAgent(String(sessionId));
    writeLog(`stop ${sessionId} killed=${killed}`, { session: sessionId });
    json(res, 200, { ok: true, stopped: killed, sessionId });
    return;
  }

  if (req.method === "POST" && url.pathname === "/tool-call") {
    try {
      const body = await readBody(req);
      const sessionId = body.sessionId || body.session;
      const name = body.name || body.tool;
      if (!sessionId || !name) {
        json(res, 400, { error: "Missing sessionId or name" });
        return;
      }
      writeLog(`tool-call ${name}`, { session: sessionId });
      const result = await requestTool(
        String(sessionId),
        String(name),
        body.args || body.arguments || {},
      );
      json(res, 200, { ok: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status =
        err instanceof SessionError && err.status ? err.status : 500;
      json(res, status, {
        error: message,
        code: err instanceof SessionError ? err.code : undefined,
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/tool-result") {
    try {
      const body = await readBody(req);
      const sessionId = body.sessionId || body.session;
      const toolId = body.toolId || body.id;
      if (!sessionId) {
        json(res, 400, { error: "Missing sessionId" });
        return;
      }
      if (body.error) {
        cancelPendingTool(String(sessionId), String(body.error));
        json(res, 200, { ok: true, cancelled: true });
        return;
      }
      resolveTool(String(sessionId), toolId, body.result ?? body);
      writeLog(`tool-result ${toolId || ""}`, { session: sessionId });
      json(res, 200, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status =
        err instanceof SessionError && err.status ? err.status : 500;
      json(res, status, {
        error: message,
        code: err instanceof SessionError ? err.code : undefined,
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/restyle") {
    let imageDir = null;
    let session = null;
    let completed = false;
    try {
      const body = await readBody(req);
      if (!body.prompt && !(body.images && body.images.length)) {
        json(res, 400, { error: "Missing prompt" });
        return;
      }
      const written = writeImages(body.images);
      imageDir = written.dir;
      session = beginRun({
        sessionId: body.sessionId || body.session,
        model: body.model,
        source: body.source,
        prompt: body.prompt,
      });
      if (body.context?.url) {
        setSessionOrigin(session.id, body.context.url);
      }
      req.on("close", () => {
        if (!completed && session) stopAgent(session.id);
      });
      writeLog(
        `Restyle: ${JSON.stringify(String(body.prompt || "").slice(0, 80))}`,
        { session: session.id },
      );
      const resumeId =
        typeof body.resumeId === "string" && body.resumeId.trim()
          ? body.resumeId.trim()
          : typeof body.cursorSessionId === "string" &&
              body.cursorSessionId.trim()
            ? body.cursorSessionId.trim()
            : null;
      const result = await runAgent(
        buildPrompt(body, written.paths),
        body.model,
        session.id,
        { resumeId },
      );
      const text = typeof result === "string" ? result : result.text || "";
      const cursorSessionId =
        (typeof result === "object" && result.cursorSessionId) ||
        resumeId ||
        null;
      writeLog(
        `Restyle ready (${text.length} chars)${cursorSessionId ? ` resume=${cursorSessionId}` : ""}`,
        { session: session.id },
      );
      json(res, 200, {
        text,
        imagePaths: written.paths,
        sessionId: session.id,
        cursorSessionId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status =
        err instanceof SessionError && err.status ? err.status : 500;
      writeLog(`POST /restyle fail ${message}`, {
        session: session?.id,
      });
      json(res, status, {
        error: message,
        code: err instanceof SessionError ? err.code : undefined,
        sessionId: session?.id,
        activeSessions: activeCount(),
        sessions: listSnapshots(),
        logs: recentText(80),
        logPath: logPath(),
      });
    } finally {
      completed = true;
      if (session) endRun(session.id);
      if (imageDir) {
        try {
          fs.rmSync(imageDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
    return;
  }

  json(res, 404, { error: "Not found" });
});

// Long enough for concurrent agents (each can run up to AGENT_TIMEOUT_MS).
server.requestTimeout = AGENT_TIMEOUT_MS + 30_000;
server.headersTimeout = AGENT_TIMEOUT_MS + 60_000;
server.timeout = AGENT_TIMEOUT_MS + 30_000;

server.listen(PORT, HOST, () => {
  writeLog(`Companion ready on http://${HOST}:${PORT}`);
  writeLog(
    `Concurrent sessions enabled (max ${maxConcurrent()}). Sidepanel + loop can run together.`,
  );
  writeLog(`Log file: ${logPath()}`, { echo: false });
  writeLog("Streaming Cursor agent thinking & tools into this terminal.");
});

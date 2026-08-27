/**
 * Local bridge: Chrome talks to 127.0.0.1, this process runs your Cursor CLI.
 * Persistent remote machines later use the same /restyle contract.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  ingestRaw,
  logPath,
  recentText,
  writeLog,
} from "./companion-log.mjs";
import {
  beginRun,
  endRun,
  ingestChunk,
  ingestStep,
  ingestThinking,
  snapshot,
} from "./companion-status.mjs";
import { createStreamParser } from "./cli-stream.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.MONACLE_PORT || 8787);
const AGENT_TIMEOUT_MS = Number(process.env.MONACLE_AGENT_TIMEOUT_MS || 240_000);
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

function runAgent(prompt, model) {
  const agent = resolveAgent();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "monacle-cli-"));
  // stream-json exposes thinking + tool steps (Cursor-agent UI shape).
  const args = [
    "-p",
    "--trust",
    "--mode=ask",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
  ];
  if (model) args.push("--model", model);
  args.push(prompt);

  return new Promise((resolve, reject) => {
    const child = spawn(agent, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Plumbing stays in the log file; terminal shows agent steps.
    writeLog(`cli spawn ${agent} timeout=${AGENT_TIMEOUT_MS}ms`, {
      echo: false,
    });
    writeLog("Cursor agent started — streaming thinking & tools…");

    const parser = createStreamParser({
      onStep: (line) => {
        writeLog(line);
        ingestStep(line);
      },
      onThinking: (full) => {
        ingestThinking(full);
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
      // Keep raw NDJSON in the file only (not the terminal).
      ingestRaw(text, "out");
      // Re-read: ingestRaw echoes via writeLog. Need to fix that.
      parser.push(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      // stderr rarely has useful agent UI; file it, surface short noise.
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (t) writeLog(`[err] ${t}`, { echo: false, ring: false });
      }
      ingestChunk(text);
    });

    const timer = setTimeout(() => {
      writeLog(`cli timeout after ${AGENT_TIMEOUT_MS}ms — sending SIGTERM`);
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
      writeLog(`cli exit ${code} result=${text.length}b`, { echo: false });
      fs.rmSync(cwd, { recursive: true, force: true });
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
      finish(() => resolve(text.trim()));
    });
  });
}

function buildPrompt(body, imagePaths) {
  const history = Array.isArray(body.history)
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
    "Do not edit any files. Reply only with the JSON patch (css + ops + overlayHtml + runtime as needed).",
    "A CSS-only patch is a failure when the user asked for a dynamic or environmental change — include runtime JS using monacle.*.",
    "If you emit a javascript fence instead of JSON, it is applied as live runtime on the page (not a sandbox).",
    "",
    history ? `PRIOR TURNS:\n${history}\n` : "",
    "PAGE CONTEXT (sanitized):",
    JSON.stringify(
      {
        url: body.context?.url,
        title: body.context?.title,
        viewport: body.context?.viewport,
        media: body.context?.media,
        landmarks: body.context?.landmarks,
      },
      null,
      2,
    ),
    "",
    imageBlock,
    "USER REQUEST:",
    body.prompt || "",
  ]
    .filter((line) => line !== undefined)
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
    json(res, 200, { ...snapshot(), logPath: logPath() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/logs") {
    json(res, 200, {
      logPath: logPath(),
      running: snapshot().running,
      lines: recentText(250).split("\n").filter(Boolean),
      text: recentText(250),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, {
      ok: true,
      agent: resolveAgent(),
      host: HOST,
      port: PORT,
      logPath: logPath(),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/restyle") {
    let imageDir = null;
    try {
      const body = await readBody(req);
      if (!body.prompt && !(body.images && body.images.length)) {
        json(res, 400, { error: "Missing prompt" });
        return;
      }
      const written = writeImages(body.images);
      imageDir = written.dir;
      writeLog(
        `Restyle: ${JSON.stringify(String(body.prompt || "").slice(0, 80))}`,
      );
      beginRun(body.model);
      const text = await runAgent(
        buildPrompt(body, written.paths),
        body.model,
      );
      writeLog(`Restyle ready (${text.length} chars)`);      json(res, 200, { text, imagePaths: written.paths });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeLog(`POST /restyle fail ${message}`);
      json(res, 500, {
        error: message,
        logs: recentText(80),
        logPath: logPath(),
      });
    } finally {
      endRun();
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

server.listen(PORT, HOST, () => {
  writeLog(`Companion ready on http://${HOST}:${PORT}`);
  writeLog(`Log file: ${logPath()}`, { echo: false });
  writeLog("Streaming Cursor agent thinking & tools into this terminal.");
});

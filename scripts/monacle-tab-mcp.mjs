#!/usr/bin/env node
/**
 * Stdio MCP server: Cursor CLI tab tools → companion HTTP → Chrome extension.
 * Env: MONACLE_SESSION_ID, MONACLE_COMPANION (default http://127.0.0.1:8787)
 */
import http from "node:http";

const SESSION_ID = process.env.MONACLE_SESSION_ID || "";
const COMPANION = (process.env.MONACLE_COMPANION || "http://127.0.0.1:8787").replace(
  /\/$/,
  "",
);

const TOOLS = [
  {
    name: "read_page",
    description:
      "Read the live Chrome tab: full readable text and same-origin links (not a truncated viewport snapshot).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_links",
    description:
      "List same-origin links on the current tab (href + link text).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "navigate",
    description:
      "Navigate the bound Chrome tab to a same-origin URL, wait for load, then return a fresh read_page result.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Absolute or path URL on the same origin as the chat tab",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
];

function postJson(pathname, body, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const url = new URL(pathname, COMPANION);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(raw),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data = {};
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            data = { error: text.slice(0, 400) };
          }
          if (res.statusCode && res.statusCode >= 400) {
            reject(
              new Error(data.error || `HTTP ${res.statusCode}: ${text.slice(0, 200)}`),
            );
            return;
          }
          resolve(data);
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Companion tool call timed out"));
    });
    req.write(raw);
    req.end();
  });
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function okResult(id, result) {
  send({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function errResult(id, code, message) {
  send({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

async function callTool(name, args) {
  if (!SESSION_ID) {
    throw new Error("MONACLE_SESSION_ID is not set");
  }
  const data = await postJson("/tool-call", {
    sessionId: SESSION_ID,
    name,
    args: args || {},
  });
  if (data.error) throw new Error(String(data.error));
  return data.result ?? data;
}

async function handle(msg) {
  if (!msg || typeof msg !== "object") return;
  const { id, method, params } = msg;

  if (method === "initialize") {
    okResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "monacle-tab", version: "0.1.0" },
    });
    return;
  }

  if (method === "notifications/initialized" || method === "initialized") {
    return;
  }

  if (method === "tools/list") {
    okResult(id, { tools: TOOLS });
    return;
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      const result = await callTool(name, args);
      const text =
        typeof result === "string" ? result : JSON.stringify(result, null, 2);
      okResult(id, {
        content: [{ type: "text", text }],
        isError: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      okResult(id, {
        content: [{ type: "text", text: message }],
        isError: true,
      });
    }
    return;
  }

  if (method === "ping") {
    okResult(id, {});
    return;
  }

  if (id != null) {
    errResult(id, -32601, `Method not found: ${method}`);
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    void handle(msg).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (msg?.id != null) errResult(msg.id, -32000, message);
    });
  }
});

process.stdin.on("end", () => process.exit(0));

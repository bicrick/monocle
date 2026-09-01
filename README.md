<p align="center">
  <img src="src/icons/monocle.svg" alt="Monocle" width="96" height="96" />
</p>

<h1 align="center">Monocle</h1>

<p align="center">
  Restyle the <strong>live tab</strong>. Site JS and media keep running.<br />
  The brain is <strong>your local Cursor CLI</strong>.
</p>

<p align="center">
  <a href="https://bicrick.com">bicrick.com</a>
  ·
  <a href="https://github.com/bicrick/monocle">github.com/bicrick/monocle</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-2ea44f?style=flat-square" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/Chrome%20Extension-MV3-4285F4?style=flat-square&logo=googlechrome&logoColor=white" alt="Chrome Extension MV3" />
  <img src="https://img.shields.io/badge/Cursor%20CLI-111111?style=flat-square" alt="Cursor CLI" />
</p>

## How it works

Monocle is a Chrome extension that snapshots the open tab, talks to a local companion, and applies sandboxed scene patches — CSS, overlay HTML, DOM ops, and optional Three.js — without killing the page’s own scripts or media.

Default provider: **Cursor CLI on this machine**. No cloud API key required. Anthropic / OpenAI / xAI remain optional fallbacks. Persistent remote machines later use the same `/restyle` contract.

## Features

- **Live-tab restyle** — change the page you are looking at; keep site JS and media running
- **Cursor CLI first** — companion runs `agent -p` with tools, stream-json, and Monacle tab MCP
- **Isolated agent cwd** — each restyle chat is sandboxed so the agent does not edit your repo
- **Concurrent sessions** — sidepanel + `npm run loop` share one companion (`MONACLE_MAX_CONCURRENT`, default 8)
- **Three.js stage** — real 3D scenery via the host `monacle.three.*` API when the scene needs it
- **Optional cloud LLMs** — Anthropic, OpenAI, and xAI if you prefer not to use Cursor CLI

## Set up (Cursor CLI on this machine)

### 1. Install and log in to Cursor CLI

Ultra covers this. Install, then confirm you are authenticated:

```bash
curl https://cursor.com/install -fsS | bash
agent login
agent status
```

### 2. Build and load the extension

```bash
cd /path/to/monocle
npm install
npm run build
```

Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select `dist/`.

### 3. Start the local companion

Leave this terminal open:

```bash
npm run companion
```

It listens only on `http://127.0.0.1:8787`. The extension POSTs the page snapshot there; the companion runs `agent -p` (default agent mode with tools; `--mode` only allows ask/plan) in an isolated chat cwd with Monacle tab MCP.

Useful companion endpoints:

| Endpoint | Purpose |
| --- | --- |
| `POST /restyle` | Start or continue a restyle session |
| `GET /status?session=<id>` | Poll one run |
| `GET /sessions` | List active sessions |
| `GET /models` | Cursor CLI catalog (Fast / Effort / Model) |

Cap concurrency with `MONACLE_MAX_CONCURRENT` (default 8).

### 4. Point the extension at Cursor CLI

Extension options → provider **Cursor CLI (this machine)** → Save. Status should say the companion is running.

### 5. Restyle a tab

Open a YouTube watch page → Monocle icon → try:

```text
make this look like a cinema
```

## Develop

Day-to-day iteration uses Vite + CRXJS HMR (prefer this over repeated production builds):

```bash
npm run dev
npm test
npm run verify
```

`npm run companion` alone if the companion is not already up. Manual Vite-only: `npm run dev:vite`.

## Later: persistent machines

[`src/agent/persistentStub.ts`](src/agent/persistentStub.ts) is the slot. Same `AgentProvider` / `/restyle` shape; point the companion (or a hosted worker) at a remote Cursor Cloud Agent instead of local `agent`.

## License

MIT — see [LICENSE](LICENSE).

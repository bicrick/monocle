# Monacle

Chrome extension that restyles the **currently open tab**. Site JS and media keep running. The default brain is **your local Cursor CLI** via a companion on this machine. Persistent remote machines later use the same `/restyle` contract.

## Set up (Cursor CLI on this machine)

1. Install and log in to Cursor CLI (Ultra covers this):

```bash
curl https://cursor.com/install -fsS | bash
agent login
agent status
```

2. Build and load the extension:

```bash
cd /Users/pbrown/Desktop/Monacle
npm install
npm run build
```

Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select `dist/`.

3. Start the local companion (leave this terminal open):

```bash
npm run companion
```

It listens only on `http://127.0.0.1:8787`. The extension POSTs the page snapshot there; the companion runs `agent -p --mode=ask` so it does not edit your repo. Multiple `/restyle` sessions run at once (sidepanel + `npm run loop`), each with its own id. `GET /status?session=<id>` polls one run; `GET /sessions` lists them. Cap with `MONACLE_MAX_CONCURRENT` (default 8).

4. Extension options → provider **Cursor CLI (this machine)** → Save. Status should say the companion is running.

5. Open a YouTube watch page → Monacle icon → `make this look like a cinema`.

No cloud API key is required for Cursor CLI. Anthropic / OpenAI / xAI remain optional fallbacks.

## Later: persistent machines

`src/agent/persistentStub.ts` is the slot. Same `AgentProvider` / `/restyle` shape; point the companion (or a hosted worker) at a remote Cursor Cloud Agent instead of local `agent`.

## Develop

```bash
npm run dev
npm test
npm run verify
```

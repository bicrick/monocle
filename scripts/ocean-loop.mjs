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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import {
  applyPatch,
  authRequiredExit,
  chromePath,
  companionHealth,
  companionLogs,
  dist,
  ensureDir,
  fetchSnapshot,
  getWorker,
  liveRestyle,
  loadSystemPrompt,
  probe,
  requireCompanionOrExit,
  root,
  runBuild,
  serveFixture,
} from "./loop-lib.mjs";

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(root, "logs/loop", stamp);
  ensureDir(outDir);
  ensureDir(path.join(root, "logs/loop"));

  const health = await companionHealth();
  requireCompanionOrExit(health, "loop");
  log(
    `companion ok (${health.agent || "agent"}) sessions=${health.activeSessions ?? 0}/${health.maxConcurrent ?? "?"}`,
  );

  if (args.build || !fs.existsSync(path.join(dist, "manifest.json"))) {
    await runBuild(log);
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
      JSON.stringify(
        { extId, pageUrl, prompt: args.prompt, hold: args.hold },
        null,
        2,
      ),
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
        const live = await liveRestyle(args.prompt, snap.context, SYSTEM_PROMPT, {
          source: "loop",
        });
        patch = live.patch;
        rawText = live.text;
      } catch (err) {
        if (err.code === "AUTH_REQUIRED") {
          authRequiredExit("npm run loop");
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
    failReason =
      failReason || (err instanceof Error ? err.message : String(err));
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
    log(
      "iterate: fix code, then npm run loop -- --replay logs/loop/last-patch.json",
    );
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

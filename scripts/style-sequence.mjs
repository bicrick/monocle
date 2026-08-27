/**
 * Multi-style headed Chrome sequence: apply restyles A → B → C → … on one tab.
 *
 * Prerequisites: npm run dev (Vite + companion), agent login when prompted.
 *
 *   npm run loop:sequence
 *   npm run loop:sequence -- --hold 12000
 *   npm run loop:sequence -- --url https://www.bicrick.com/about
 *   npm run loop:sequence -- --replay-dir logs/loop/sequence-<stamp>
 *   npm run loop:youtube
 *   npm run loop:sequence -- --styles scripts/sequence-styles-youtube.mjs --wait-video --require-video
 *
 * Live mode POSTs /restyle per style, holds, probes, screenshots.
 * Replay mode re-applies saved NN-<slug>-patch.json files in order.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer";
import {
  applyPatch,
  authRequiredExit,
  awaitContentScript,
  chromePath,
  companionBase,
  companionHealth,
  companionLogs,
  dist,
  ensureDir,
  fetchSnapshot,
  getWorker,
  liveRestyle,
  loadSystemPrompt,
  probe,
  probePage,
  requireCompanionOrExit,
  root,
  runBuild,
  slugify,
} from "./loop-lib.mjs";
import { SEQUENCE_STYLES as DEFAULT_STYLES } from "./sequence-styles.mjs";

const SYSTEM_PROMPT = loadSystemPrompt();

const PRESETS = {
  default: {
    stylesPath: null,
    url: "https://www.bicrick.com/about",
    waitVideo: false,
    requireVideo: false,
    outPrefix: "sequence",
  },
  "youtube-golf": {
    stylesPath: path.join(root, "scripts/sequence-styles-youtube.mjs"),
    url: "https://www.youtube.com/watch?v=s-i3YpnRJpk",
    waitVideo: true,
    requireVideo: true,
    outPrefix: "sequence-youtube",
    hold: 14_000,
  },
};

function parseArgs(argv) {
  const out = {
    url: process.env.MONACLE_LOOP_URL || null,
    hold: Number(process.env.MONACLE_HOLD_MS || 14_000),
    replayDir: null,
    build: true,
    stylesPath: null,
    preset: null,
    waitVideo: false,
    requireVideo: false,
    outPrefix: "sequence",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.url = argv[++i];
    else if (a === "--hold") out.hold = Number(argv[++i]);
    else if (a === "--replay-dir") out.replayDir = argv[++i];
    else if (a === "--no-build") out.build = false;
    else if (a === "--styles") out.stylesPath = argv[++i];
    else if (a === "--preset") out.preset = argv[++i];
    else if (a === "--wait-video") out.waitVideo = true;
    else if (a === "--require-video") out.requireVideo = true;
    else if (a === "--out-prefix") out.outPrefix = argv[++i];
  }

  if (out.preset) {
    const preset = PRESETS[out.preset];
    if (!preset) {
      throw new Error(
        `unknown preset "${out.preset}" (known: ${Object.keys(PRESETS).join(", ")})`,
      );
    }
    if (!out.stylesPath && preset.stylesPath) out.stylesPath = preset.stylesPath;
    if (!out.url && preset.url) out.url = preset.url;
    if (preset.waitVideo) out.waitVideo = true;
    if (preset.requireVideo) out.requireVideo = true;
    if (out.outPrefix === "sequence" && preset.outPrefix) {
      out.outPrefix = preset.outPrefix;
    }
    if (
      preset.hold != null &&
      !process.env.MONACLE_HOLD_MS &&
      !argv.includes("--hold")
    ) {
      out.hold = preset.hold;
    }
  }

  if (!out.url) {
    out.url = PRESETS.default.url;
  }
  return out;
}

async function loadStyles(stylesPath) {
  if (!stylesPath) return DEFAULT_STYLES;
  const abs = path.isAbsolute(stylesPath)
    ? stylesPath
    : path.join(root, stylesPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`styles module missing: ${abs}`);
  }
  const mod = await import(pathToFileURL(abs).href);
  const styles = mod.SEQUENCE_STYLES || mod.default;
  if (!Array.isArray(styles) || styles.length === 0) {
    throw new Error(`styles module has no SEQUENCE_STYLES: ${abs}`);
  }
  return styles;
}

function log(msg) {
  console.log(`[sequence] ${msg}`);
}

function checklistLine(index, total, label, status) {
  const n = String(index).padStart(2, "0");
  const mark =
    status === "start"
      ? "…"
      : status === "pass"
        ? "OK"
        : status === "fail"
          ? "FAIL"
          : status;
  return `[${n}/${String(total).padStart(2, "0")}] ${mark}  ${label}`;
}

function resolveReplayPatches(replayDir, styles) {
  const abs = path.isAbsolute(replayDir)
    ? replayDir
    : path.join(root, replayDir);
  if (!fs.existsSync(abs)) {
    throw new Error(`replay dir missing: ${abs}`);
  }
  const files = fs
    .readdirSync(abs)
    .filter((f) => /^\d{2}-.+-patch\.json$/.test(f))
    .sort();
  if (files.length === 0) {
    throw new Error(`no NN-*-patch.json files in ${abs}`);
  }
  return files.map((file, i) => {
    const base = file.replace(/-patch\.json$/, "");
    const match = base.match(/^(\d{2})-(.+)$/);
    const slug = match?.[2] || slugify(styles[i]?.id || `step-${i + 1}`);
    const style = styles.find((s) => s.id === slug) || {
      id: slug,
      label: slug,
      prompt: `(replay ${file})`,
    };
    return {
      style,
      patchPath: path.join(abs, file),
      patch: JSON.parse(fs.readFileSync(path.join(abs, file), "utf8")),
    };
  });
}

async function tryDismissYouTubeGates(page) {
  const clicked = await page.evaluate(() => {
    const texts = [
      /accept all/i,
      /i agree/i,
      /accept the use of cookies/i,
      /^accept$/i,
      /reject all/i,
      /got it/i,
    ];
    const buttons = [
      ...document.querySelectorAll("button, tp-yt-paper-button, .yt-spec-button-shape-next"),
    ];
    for (const el of buttons) {
      const t = (el.textContent || "").trim();
      if (!t || t.length > 48) continue;
      if (texts.some((re) => re.test(t))) {
        el.click();
        return t;
      }
    }
    // Consent iframe (EU) — best-effort within page only.
    return null;
  });
  if (clicked) {
    log(`dismissed gate button: ${JSON.stringify(clicked)}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  return clicked;
}

async function pageDebug(page) {
  return page.evaluate(() => ({
    href: location.href,
    title: document.title,
    hasVideo: !!document.querySelector("video"),
    hasMoviePlayer: !!document.querySelector("#movie_player"),
    hasYtdPlayer: !!document.querySelector("ytd-player"),
    hasHtml5Player: !!document.querySelector(".html5-video-player"),
    consent:
      !!document.querySelector('form[action*="consent"]') ||
      /consent|before you continue|cookies/i.test(document.body?.innerText || ""),
    videoCount: document.querySelectorAll("video").length,
  }));
}

async function waitForPlayer(page, timeoutMs = 90000) {
  log("waiting for video / #movie_player …");
  const deadline = Date.now() + timeoutMs;
  let last = await pageDebug(page);
  while (Date.now() < deadline) {
    last = await pageDebug(page);
    // Require a real <video> node — #movie_player alone can appear before media.
    if (last.hasVideo) break;
    if (last.consent) {
      log(`possible consent wall @ ${last.href}`);
      await tryDismissYouTubeGates(page);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!last.hasVideo) {
    throw new Error(
      `YouTube <video> not found within ${timeoutMs}ms: ${JSON.stringify(last)}`,
    );
  }
  await new Promise((r) => setTimeout(r, 1200));
  const info = await page.evaluate(() => {
    const video = document.querySelector("video");
    return {
      href: location.href,
      title: document.title,
      hasVideo: !!video,
      hasMoviePlayer: !!document.querySelector("#movie_player"),
      paused: video ? video.paused : null,
      readyState: video ? video.readyState : null,
      currentTime: video ? video.currentTime : null,
      errorText: document.body?.innerText?.includes("Something went wrong")
        ? "youtube-error-banner"
        : null,
    };
  });
  // Try to kick playback if autoplay blocked in fresh profile.
  if (info.hasVideo && info.paused) {
    await page
      .evaluate(() => {
        const video = document.querySelector("video");
        if (video) {
          video.muted = true;
          void video.play().catch(() => {});
        }
        const btn = document.querySelector(
          ".ytp-large-play-button, .ytp-play-button",
        );
        if (btn instanceof HTMLElement) btn.click();
      })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
  }
  log(
    `player ready (video=${info.hasVideo} movie_player=${info.hasMoviePlayer} paused=${info.paused}${info.errorText ? ` ${info.errorText}` : ""}) @ ${info.href}`,
  );
  return info;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const styles = await loadStyles(args.stylesPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(root, "logs/loop", `${args.outPrefix}-${stamp}`);
  ensureDir(outDir);
  ensureDir(path.join(root, "logs/loop"));

  const health = await companionHealth();
  requireCompanionOrExit(health, args.preset === "youtube-golf" ? "loop:youtube" : "loop:sequence");
  log(
    `companion ok (${health.agent || "agent"}) @ ${companionBase} sessions=${health.activeSessions ?? 0}/${health.maxConcurrent ?? "?"}`,
  );

  if (args.build || !fs.existsSync(path.join(dist, "manifest.json"))) {
    await runBuild(log);
  }
  assert.ok(
    fs.existsSync(path.join(dist, "src/sandbox/sandbox.html")),
    "dist sandbox.html missing",
  );

  const pageUrl = args.url;
  const steps = args.replayDir
    ? resolveReplayPatches(args.replayDir, styles)
    : styles.map((style) => ({ style, patch: null, patchPath: null }));

  log(`target ${pageUrl}`);
  log(`styles (${steps.length}): ${steps.map((s) => s.style.id).join(" → ")}`);
  log(`hold ${args.hold}ms per style`);
  if (args.stylesPath) log(`styles module ${args.stylesPath}`);
  if (args.preset) log(`preset ${args.preset}`);
  if (args.waitVideo) log("wait-video on");
  if (args.requireVideo) log("require-video on");
  if (args.replayDir) log(`replay-dir ${args.replayDir}`);

  console.log("\n=== SEQUENCE CHECKLIST ===");
  for (let i = 0; i < steps.length; i++) {
    console.log(checklistLine(i + 1, steps.length, steps[i].style.label, "····"));
  }
  console.log("==========================\n");

  const userDataDir = fs.mkdtempSync(path.join(root, ".chrome-sequence-"));
  let browser;
  const pageErrors = [];
  const results = [];
  let passed = false;
  let failReason = "";
  let failedAt = null;
  let playerInfo = null;

  try {
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: false,
      userDataDir,
      enableExtensions: true,
      protocolTimeout: 300_000,
      args: [
        "--enable-unsafe-extension-debugging",
        "--no-first-run",
        "--autoplay-policy=no-user-gesture-required",
      ],
      defaultViewport: { width: 1280, height: 800 },
    });

    const extId = await browser.installExtension(dist);
    log(`extension ${extId}`);
    fs.writeFileSync(
      path.join(outDir, "meta.json"),
      JSON.stringify(
        {
          extId,
          pageUrl,
          hold: args.hold,
          preset: args.preset,
          stylesPath: args.stylesPath,
          waitVideo: args.waitVideo,
          requireVideo: args.requireVideo,
          replayDir: args.replayDir,
          styles: steps.map((s) => ({
            id: s.style.id,
            label: s.style.label,
            prompt: s.style.prompt,
          })),
        },
        null,
        2,
      ),
    );

    const page = await browser.newPage();
    page.setDefaultTimeout(120_000);
    page.setDefaultNavigationTimeout(90_000);
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    page.on("error", (err) => pageErrors.push(`page crash: ${err}`));
    await page.goto(pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await new Promise((r) => setTimeout(r, 1500));
    await tryDismissYouTubeGates(page);
    if (args.waitVideo) {
      try {
        playerInfo = await waitForPlayer(page);
      } catch (err) {
        const dbg = await pageDebug(page).catch(() => ({}));
        await page
          .screenshot({
            path: path.join(outDir, "00-player-wait-fail.png"),
            fullPage: false,
          })
          .catch(() => {});
        fs.writeFileSync(
          path.join(outDir, "00-page-debug.json"),
          JSON.stringify(dbg, null, 2),
        );
        throw err;
      }
    } else {
      await new Promise((r) => setTimeout(r, 1200));
    }

    log("waiting for content script …");
    const snap = await awaitContentScript(
      getWorker,
      browser,
      extId,
      pageUrl,
      {
        timeoutMs: args.waitVideo ? 45000 : 20000,
        log: (m) => log(m),
      },
    );
    if (!snap.ok) {
      const dbg = await pageDebug(page).catch(() => ({}));
      await page
        .screenshot({
          path: path.join(outDir, "00-content-script-fail.png"),
          fullPage: false,
        })
        .catch(() => {});
      fs.writeFileSync(
        path.join(outDir, "00-page-debug.json"),
        JSON.stringify({ dbg, snap }, null, 2),
      );
      throw new Error(
        `snapshot failed: ${snap.error}${snap.tabUrl ? ` (tab ${snap.tabUrl})` : ""}`,
      );
    }
    let worker = await getWorker(browser, extId);
    fs.writeFileSync(
      path.join(outDir, "snapshot.json"),
      JSON.stringify(snap.context, null, 2),
    );

    for (let i = 0; i < steps.length; i++) {
      const { style } = steps[i];
      const n = i + 1;
      const prefix = `${String(n).padStart(2, "0")}-${slugify(style.id)}`;
      console.log(checklistLine(n, steps.length, style.label, "start"));
      log(`style ${style.id}: ${JSON.stringify(style.prompt.slice(0, 90))}`);

      let patch = steps[i].patch;
      let rawText = "";

      if (!patch) {
        // Fresh snapshot each step so the agent sees current page + prior scene.
        worker = await getWorker(browser, extId);
        const stepSnap = await fetchSnapshot(worker, pageUrl);
        if (!stepSnap.ok) {
          throw new Error(`snapshot failed at ${style.id}: ${stepSnap.error}`);
        }
        fs.writeFileSync(
          path.join(outDir, `${prefix}-snapshot.json`),
          JSON.stringify(stepSnap.context, null, 2),
        );
        try {
          const live = await liveRestyle(
            style.prompt,
            stepSnap.context,
            SYSTEM_PROMPT,
            {
              source: "sequence",
              sessionId: `seq_${prefix}`,
            },
          );
          patch = live.patch;
          rawText = live.text;
        } catch (err) {
          if (err.code === "AUTH_REQUIRED") {
            authRequiredExit(
              args.preset === "youtube-golf"
                ? "npm run loop:youtube"
                : "npm run loop:sequence",
            );
          }
          throw err;
        }
        fs.writeFileSync(path.join(outDir, `${prefix}-restyle-raw.txt`), rawText);
      }

      const patchPath = path.join(outDir, `${prefix}-patch.json`);
      fs.writeFileSync(patchPath, JSON.stringify(patch, null, 2));
      fs.writeFileSync(
        path.join(root, "logs/loop/last-patch.json"),
        JSON.stringify(patch, null, 2),
      );

      worker = await getWorker(browser, extId);
      let applied;
      try {
        applied = await applyPatch(worker, pageUrl, patch);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/timed out|Timeout/i.test(msg)) throw err;
        log(`apply CDP timeout (${style.id}) — probing whether scene landed`);
        await new Promise((r) => setTimeout(r, 2500));
        const soft = await probe(await getWorker(browser, extId), pageUrl);
        if (soft.ok && soft.state?.monacleOn === "on" && soft.state?.overlay) {
          applied = {
            ok: true,
            applied: { softRecovered: true, probe: soft.state },
          };
        } else {
          throw err;
        }
      }
      fs.writeFileSync(
        path.join(outDir, `${prefix}-apply.json`),
        JSON.stringify(applied, null, 2),
      );
      if (!applied.ok) {
        failReason = `apply failed (${style.id}): ${applied.error || JSON.stringify(applied)}`;
        failedAt = style.id;
        console.log(checklistLine(n, steps.length, style.label, "fail"));
        throw new Error(failReason);
      }

      log(`applied ${style.id}; holding ${args.hold}ms`);
      await new Promise((r) => setTimeout(r, args.hold));

      let swAlive = null;
      try {
        const swTimeoutMs = args.waitVideo || args.requireVideo ? 6_000 : 15_000;
        worker = await Promise.race([
          getWorker(browser, extId),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`getWorker timeout ${swTimeoutMs}ms`)),
              swTimeoutMs,
            ),
          ),
        ]);
        swAlive = true;
      } catch (err) {
        swAlive = false;
        log(`SW check after hold (${style.id}): ${err.message}`);
        // YouTube runs can stall the SW connection; fall through to page probe.
        if (!args.waitVideo && !args.requireVideo) {
          failReason = `extension crashed during hold (${style.id}): ${err.message}`;
          failedAt = style.id;
          console.log(checklistLine(n, steps.length, style.label, "fail"));
          throw new Error(failReason);
        }
      }

      let result;
      if (args.waitVideo || args.requireVideo) {
        // Prefer direct page DOM probe — SW→tab messaging often times out on YouTube.
        result = await probePage(page);
        if ((!result.ok || result.state?.monacleOn !== "on") && swAlive) {
          try {
            result = await probe(worker, pageUrl);
          } catch {
            /* keep page probe */
          }
        }
        result = { ...result, swAlive };
      } else {
        try {
          result = await probe(worker, pageUrl);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`probe CDP issue (${style.id}): ${msg} — retrying via page`);
          await new Promise((r) => setTimeout(r, 2000));
          result = await probePage(page);
        }
      }
      fs.writeFileSync(
        path.join(outDir, `${prefix}-probe.json`),
        JSON.stringify(result, null, 2),
      );
      const shotPath = path.join(outDir, `${prefix}.png`);
      try {
        await page.screenshot({ path: shotPath, fullPage: false, timeout: 60_000 });
      } catch (err) {
        log(`screenshot failed (${style.id}): ${err instanceof Error ? err.message : err}`);
      }

      if (!result.ok || result.crashed) {
        failReason = `probe failed (${style.id}): ${result.error || "unknown"}`;
        failedAt = style.id;
        console.log(checklistLine(n, steps.length, style.label, "fail"));
        throw new Error(failReason);
      }
      if (result.state?.monacleOn !== "on" || !result.state?.overlay) {
        failReason = `scene gone after hold (${style.id}): ${JSON.stringify(result.state)}`;
        failedAt = style.id;
        console.log(checklistLine(n, steps.length, style.label, "fail"));
        throw new Error(failReason);
      }
      if (args.requireVideo && !result.state?.video) {
        failReason = `video missing after hold (${style.id}): ${JSON.stringify(result.state)}`;
        failedAt = style.id;
        console.log(checklistLine(n, steps.length, style.label, "fail"));
        throw new Error(failReason);
      }
      // YouTube preset: prefer page DOM health; SW timeout alone is a caveat, not hard fail
      // when overlay + video remain. Still fail if we never saw SW after apply.
      if (
        (args.waitVideo || args.requireVideo) &&
        swAlive === false &&
        !result.state?.overlay
      ) {
        failReason = `service worker dead and scene missing after hold (${style.id})`;
        failedAt = style.id;
        console.log(checklistLine(n, steps.length, style.label, "fail"));
        throw new Error(failReason);
      }

      const playerAfter =
        args.requireVideo || args.waitVideo
          ? {
              hasVideo: !!result.state?.video,
              hasMoviePlayer: !!result.state?.moviePlayer,
              paused: result.state?.paused ?? null,
              currentTime: result.state?.currentTime ?? null,
            }
          : null;

      results.push({
        id: style.id,
        label: style.label,
        ok: true,
        screenshot: shotPath,
        probe: result.state,
        player: playerAfter,
      });
      console.log(checklistLine(n, steps.length, style.label, "pass"));
      log(`PASS step ${n}: ${style.label}`);
    }

    passed = true;
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
      JSON.stringify(
        {
          passed,
          failReason,
          failedAt,
          outDir,
          playerInfo,
          order: results.map((r) => r.id),
          results,
        },
        null,
        2,
      ),
    );
    await browser?.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  console.log("");
  if (passed) {
    log("PASS — sequence complete");
    console.log("Styles in order:");
    for (const r of results) {
      const playerNote = r.player
        ? ` [video=${r.player.hasVideo} movie_player=${r.player.hasMoviePlayer} paused=${r.player.paused}]`
        : "";
      console.log(`  ✓ ${r.id} — ${r.label}${playerNote}`);
    }
  } else {
    log(`FAIL at ${failedAt || "setup"} — ${failReason}`);
    if (results.length) {
      console.log("Passed before failure:");
      for (const r of results) {
        console.log(`  ✓ ${r.id} — ${r.label}`);
      }
    }
  }
  log(`artifacts: ${outDir}`);
  if (!passed) process.exit(1);
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

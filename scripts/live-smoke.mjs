/**
 * Live smoke: options/sidepanel UI + autoGrow + CLI pill + history + content script.
 */
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const fixture = path.join(__dirname, "fixtures/blog.html");
const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

assert.ok(
  fs.existsSync(path.join(dist, "manifest.json")),
  "dist/ missing — run npm run build",
);

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
  throw new Error("service worker not found");
}

const cinemaCss = `
html[data-monacle="on"] #masthead,
html[data-monacle="on"] #secondary,
html[data-monacle="on"] #comments {
  display: none !important;
}
html[data-monacle="on"] body { background: #050505 !important; }
`;

async function main() {
  const results = {};
  const { server, url } = await serveFixture();
  const userDataDir = fs.mkdtempSync(path.join(root, ".chrome-verify-"));
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: false,
      userDataDir,
      enableExtensions: true,
      args: ["--enable-unsafe-extension-debugging", "--no-first-run"],
      defaultViewport: { width: 1100, height: 800 },
    });

    const extId = await browser.installExtension(dist);
    results.extId = extId;
    console.log("extension id", extId);

    const options = await browser.newPage();
    await options.goto(`chrome-extension://${extId}/src/options/index.html`, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    results.optionsTitle = await options.title();
    assert.match(results.optionsTitle, /Monacle/i);
    results.optionsOk = true;
    await options.close();

    const panel = await browser.newPage();
    await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html`, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await panel.waitForSelector("#prompt");
    assert.ok(await panel.$("#sandbox-frame"));
    assert.ok(await panel.$("#history"));
    assert.ok(await panel.$("#history-list"));
    assert.ok(await panel.$("#history-count"));
    assert.ok(await panel.$("#conn-host"));

    await panel.waitForSelector(".conn-chip", { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 1500));
    const chip = await panel.evaluate(() => {
      const el = document.querySelector(".conn-chip");
      return {
        present: !!el,
        online: el?.classList.contains("is-online") ?? false,
        offline: el?.classList.contains("is-offline") ?? false,
        title: el?.getAttribute("title") || "",
        label: el?.textContent?.trim() || "",
      };
    });
    results.cliChip = chip;
    assert.equal(chip.present, true);
    assert.match(chip.label, /CLI/i);

    const history = await panel.evaluate(() => {
      const details = document.getElementById("history");
      const count = document.getElementById("history-count");
      const list = document.getElementById("history-list");
      const newBtn = document.getElementById("new-btn");
      return {
        details: !!details,
        countText: count?.textContent ?? null,
        listPresent: !!list,
        newBtn: !!newBtn,
      };
    });
    results.history = history;
    assert.equal(history.details, true);
    assert.equal(history.listPresent, true);
    assert.equal(history.newBtn, true);

    const grow = await panel.evaluate(() => {
      const ta = document.getElementById("prompt");
      const before = {
        height: ta.style.height,
        clientHeight: ta.clientHeight,
        scrollHeight: ta.scrollHeight,
      };
      ta.value = Array.from(
        { length: 12 },
        (_, i) => `Line ${i + 1} of restyle request`,
      ).join("\n");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      void ta.offsetHeight;
      const after = {
        height: ta.style.height,
        clientHeight: ta.clientHeight,
        scrollHeight: ta.scrollHeight,
        heightPx: parseFloat(ta.style.height) || ta.clientHeight,
      };
      return { before, after };
    });
    results.autoGrow = grow;
    assert.ok(
      grow.after.heightPx > 40,
      `expected grown height > 40, got ${grow.after.heightPx}`,
    );
    assert.ok(
      grow.after.clientHeight >= 80 || grow.after.heightPx >= 80,
      `expected auto-grow significantly, client=${grow.after.clientHeight} style=${grow.after.heightPx}`,
    );
    // Must not stay stuck near a fixed ~160px box while content is taller.
    assert.ok(
      grow.after.clientHeight >= Math.min(grow.after.scrollHeight, 200) - 24,
      `composer did not grow with content: ${JSON.stringify(grow.after)}`,
    );
    results.autoGrowOk = true;
    results.sidepanelOk = true;
    await panel.close();

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle0", timeout: 20000 });
    await page.waitForSelector("video");
    await new Promise((r) => setTimeout(r, 800));

    const worker = await getWorker(browser, extId);
    const applyResult = await worker.evaluate(
      async (fixtureUrl, css) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => t.url && t.url.startsWith(fixtureUrl));
        if (!tab?.id) {
          return {
            ok: false,
            error: "tab not found",
            urls: tabs.map((t) => t.url),
          };
        }

        let snap;
        try {
          snap = await chrome.tabs.sendMessage(tab.id, {
            type: "GET_SNAPSHOT",
          });
        } catch (e) {
          return { ok: false, error: String(e), stage: "snapshot" };
        }

        const applied = await chrome.tabs.sendMessage(tab.id, {
          type: "APPLY_PATCH",
          patch: {
            message: "cinema demo",
            css,
            overlayHtml:
              '<div style="position:fixed;inset:0;background:radial-gradient(ellipse at center,transparent 40%,#000 80%);pointer-events:none"></div>',
            ops: [
              { type: "hide", selector: "#secondary" },
              { type: "hide", selector: "#masthead" },
              { type: "hide", selector: "#comments" },
            ],
          },
        });

        const videoStillThere = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const v = document.querySelector("video");
            const masthead = document.getElementById("masthead");
            const secondary = document.getElementById("secondary");
            return {
              hasVideo: !!v,
              mastheadDisplay: masthead
                ? getComputedStyle(masthead).display
                : null,
              secondaryDisplay: secondary
                ? getComputedStyle(secondary).display
                : null,
              monacleOn: document.documentElement.getAttribute("data-monacle"),
              overlay: !!document.getElementById("monacle-overlay"),
            };
          },
        });

        await chrome.tabs.sendMessage(tab.id, { type: "RESET" });

        const afterReset = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const masthead = document.getElementById("masthead");
            return {
              monacleOn: document.documentElement.getAttribute("data-monacle"),
              mastheadDisplay: masthead
                ? getComputedStyle(masthead).display
                : null,
              overlay: !!document.getElementById("monacle-overlay"),
              hasVideo: !!document.querySelector("video"),
            };
          },
        });

        return {
          ok: true,
          snapType: snap?.type,
          media: snap?.context?.media?.length,
          applied,
          videoStillThere: videoStillThere?.[0]?.result,
          afterReset: afterReset?.[0]?.result,
        };
      },
      url,
      cinemaCss,
    );

    results.content = applyResult;
    assert.equal(applyResult.ok, true, applyResult.error || "apply failed");
    assert.equal(applyResult.snapType, "SNAPSHOT");
    assert.ok((applyResult.media ?? 0) >= 1);
    assert.ok(
      applyResult.applied?.ok === true ||
        applyResult.applied?.type === "PATCH_APPLIED",
    );
    assert.equal(applyResult.videoStillThere?.hasVideo, true);
    assert.equal(applyResult.videoStillThere?.monacleOn, "on");
    assert.equal(applyResult.videoStillThere?.mastheadDisplay, "none");
    assert.equal(applyResult.videoStillThere?.secondaryDisplay, "none");
    assert.equal(applyResult.videoStillThere?.overlay, true);
    assert.equal(applyResult.afterReset?.monacleOn, null);
    assert.notEqual(applyResult.afterReset?.mastheadDisplay, "none");
    assert.equal(applyResult.afterReset?.overlay, false);
    assert.equal(applyResult.afterReset?.hasVideo, true);
    results.contentOk = true;

    console.log("SMOKE_RESULTS", JSON.stringify(results, null, 2));
    console.log("live smoke passed");
  } finally {
    await browser?.close().catch(() => {});
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("SMOKE_FAILED", err);
  process.exit(1);
});

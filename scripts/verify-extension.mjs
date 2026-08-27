/**
 * Smoke-test: load unpacked dist via Puppeteer installExtension, apply cinema
 * patch through the service worker, verify media survives + reset + sandbox.
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

assert.ok(
  fs.existsSync(path.join(dist, "manifest.json")),
  "dist/ missing — run npm run build",
);

const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

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

const cinemaCss = `
html[data-monacle="on"] #masthead,
html[data-monacle="on"] #secondary,
html[data-monacle="on"] #comments {
  display: none !important;
}
html[data-monacle="on"] body { background: #050505 !important; }
html[data-monacle="on"] #movie_player {
  box-shadow: 0 0 60px #000;
  margin-top: 8vh;
}
`;

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

async function main() {
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
    console.log("extension id", extId);

    const options = await browser.newPage();
    await options.goto(`chrome-extension://${extId}/src/options/index.html`, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    assert.match(await options.title(), /Monacle/i);
    await options.close();

    const panel = await browser.newPage();
    await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html`, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    assert.ok(await panel.$("#prompt"));
    assert.ok(await panel.$("#sandbox-frame"));
    await panel.close();

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle0", timeout: 20000 });
    await page.waitForSelector("video");
    // Allow content script inject
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
              videoParent: v?.parentElement?.id ?? null,
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

    console.log(JSON.stringify(applyResult, null, 2));
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

    const sandboxPage = await browser.newPage();
    await sandboxPage.goto(
      `chrome-extension://${extId}/src/sandbox/sandbox.html`,
      { waitUntil: "domcontentloaded" },
    );
    const sandboxPatch = await sandboxPage.evaluate(() => {
      return new Promise((resolve) => {
        window.addEventListener("message", (event) => {
          if (event.data?.type === "monacle-patch-result") {
            resolve(event.data);
          }
        });
        window.postMessage(
          {
            source: "monacle-host",
            type: "monacle-run",
            id: 1,
            code: `postMessage({ type: "monacle-patch", patch: { message: "from sandbox", css: "body{}" } });`,
            context: { url: "https://example.com" },
          },
          "*",
        );
      });
    });
    assert.equal(sandboxPatch.patch.message, "from sandbox");
    await sandboxPage.close();

    console.log("browser verify passed");
  } finally {
    await browser?.close().catch(() => {});
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Hold-test: apply an ocean-like runtime (canvas raf + kelp style writes)
 * and verify the extension service worker survives ~15s.
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
const HOLD_MS = Number(process.env.MONACLE_HOLD_MS || 15_000);

assert.ok(
  fs.existsSync(path.join(dist, "manifest.json")),
  "dist/ missing — run npm run build",
);
assert.ok(
  fs.existsSync(path.join(dist, "src/sandbox/sandbox.html")),
  "dist sandbox.html missing — run npm run build",
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

const oceanRuntime = `
const c = monacle.canvas();
const ctx = c.getContext('2d');
let t = 0;
let rafId;
const fish = Array.from({ length: 14 }, (_, i) => ({
  x: Math.random() * (innerWidth || 800),
  y: 80 + Math.random() * ((innerHeight || 600) * 0.65),
  s: 0.55 + Math.random() * 0.9,
  sp: 0.6 + Math.random() * 1.4,
  dir: Math.random() > 0.5 ? 1 : -1,
  hue: 18 + (i % 5) * 12,
  phase: Math.random() * Math.PI * 2,
  bob: 8 + Math.random() * 14
}));
const bubbles = Array.from({ length: 28 }, () => ({
  x: Math.random() * (innerWidth || 800),
  y: Math.random() * (innerHeight || 600),
  r: 1.5 + Math.random() * 3.5,
  sp: 0.3 + Math.random() * 0.8,
  drift: (Math.random() - 0.5) * 0.4
}));
function sizeCanvas() {
  const w = innerWidth | 0;
  const h = innerHeight | 0;
  if (w > 0 && c.width !== w) c.width = w;
  if (h > 0 && c.height !== h) c.height = h;
}
function frame() {
  t += 0.022;
  sizeCanvas();
  const w = c.width;
  const h = c.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(180,230,255,0.08)';
  ctx.fillRect(0, 0, w, 40);
  for (const b of bubbles) {
    b.y -= b.sp;
    b.x += b.drift;
    if (b.y < -10) { b.y = h + 10; b.x = Math.random() * w; }
    ctx.strokeStyle = 'rgba(190,230,255,0.35)';
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (const f of fish) {
    f.x += f.sp * f.dir;
    if (f.dir > 0 && f.x > w + 60) f.x = -60;
    if (f.dir < 0 && f.x < -60) f.x = w + 60;
    ctx.fillStyle = 'hsla(' + f.hue + ',55%,58%,0.88)';
    ctx.beginPath();
    ctx.ellipse(f.x, f.y + Math.sin(t + f.phase) * f.bob, 22 * f.s, 10 * f.s, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  const kelp = monacle.query('[data-monacle-insert="kelp"]');
  kelp.forEach((el, i) => {
    el.style.transform = 'rotate(' + (Math.sin(t * 0.9 + i) * 6) + 'deg)';
  });
  rafId = monacle.raf(frame);
}
rafId = monacle.raf(frame);
monacle.onCleanup(() => { if (rafId) cancelAnimationFrame(rafId); });
`;

async function main() {
  const { server, url } = await serveFixture();
  const userDataDir = fs.mkdtempSync(path.join(root, ".chrome-ocean-"));
  let browser;
  const pageErrors = [];
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

    const page = await browser.newPage();
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    page.on("error", (err) => pageErrors.push(String(err)));
    await page.goto(url, { waitUntil: "networkidle0", timeout: 20000 });
    await page.waitForSelector("video");
    await new Promise((r) => setTimeout(r, 800));

    const worker = await getWorker(browser, extId);
    const applyResult = await worker.evaluate(
      async (fixtureUrl, runtime) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => t.url && t.url.startsWith(fixtureUrl));
        if (!tab?.id) return { ok: false, error: "tab not found" };

        const applied = await chrome.tabs.sendMessage(tab.id, {
          type: "APPLY_PATCH",
          patch: {
            message: "ocean hold test",
            css: "html[data-monacle=on] body { background:#001a33 !important; } html[data-monacle=on] #movie_player { position:relative; z-index:2; }",
            overlayHtml:
              '<div style="position:fixed;inset:0;pointer-events:none;background:linear-gradient(#003366,#001122);"></div>',
            ops: [
              { type: "hide", selector: "#masthead" },
              { type: "hide", selector: "#secondary" },
              {
                type: "insert",
                selector: "body",
                position: "append",
                html: '<div data-monacle-insert="kelp" style="position:fixed;left:8%;bottom:0;width:18px;height:28vh;background:#0a3d28;transform-origin:bottom center;"></div><div data-monacle-insert="kelp" style="position:fixed;right:12%;bottom:0;width:16px;height:34vh;background:#0a3d28;transform-origin:bottom center;"></div>',
              },
            ],
            runtime,
          },
        });
        return { ok: applied?.ok !== false, applied };
      },
      url,
      oceanRuntime,
    );

    assert.equal(applyResult.ok, true, JSON.stringify(applyResult));
    console.log("applied ocean patch; holding", HOLD_MS, "ms");

    await new Promise((r) => setTimeout(r, HOLD_MS));

    // Service worker must still be alive (crash balloon = extension dead).
    const worker2 = await getWorker(browser, extId);
    const probe = await worker2.evaluate(async (fixtureUrl) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url && t.url.startsWith(fixtureUrl));
      if (!tab?.id) return { ok: false, error: "tab missing" };
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
            kelp: document.querySelectorAll('[data-monacle-insert="kelp"]').length,
            video: !!document.querySelector("video"),
          }),
        });
        return {
          ok: true,
          snap: snap?.type === "SNAPSHOT",
          state: state?.[0]?.result,
        };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }, url);

    console.log("probe", JSON.stringify(probe, null, 2));
    assert.equal(probe.ok, true, JSON.stringify(probe));
    assert.equal(probe.state?.monacleOn, "on");
    assert.equal(probe.state?.overlay, true);
    assert.equal(probe.state?.frame, true);
    assert.equal(probe.state?.video, true);
    assert.ok((probe.state?.kelp ?? 0) >= 1);

    await worker2.evaluate(async (fixtureUrl) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url && t.url.startsWith(fixtureUrl));
      if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: "RESET" });
    }, url);

    console.log("ocean hold passed");
  } finally {
    await browser?.close().catch(() => {});
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  if (pageErrors.length) {
    console.warn("page errors (non-fatal):", pageErrors.slice(0, 5));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

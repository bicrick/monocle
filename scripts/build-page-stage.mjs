/**
 * Bundle page-world Three.js stage as a single IIFE.
 * Writes to src/page/threeStage.js (CRXJS WAR input) and, when present, dist/.
 * WebGL runs in the tab process, not the extension sandbox.
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "src/page/threeStage.ts");
const outSrc = path.join(root, "src/page/threeStage.js");
const outDist = path.join(root, "dist/src/page/threeStage.js");

fs.mkdirSync(path.dirname(outSrc), { recursive: true });

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome110"],
  outfile: outSrc,
  minify: true,
  logLevel: "info",
  mainFields: ["module", "browser", "main"],
});

console.log("bundled page threeStage → src/page/threeStage.js");

if (fs.existsSync(path.join(root, "dist"))) {
  fs.mkdirSync(path.dirname(outDist), { recursive: true });
  fs.copyFileSync(outSrc, outDist);
  console.log("copied page threeStage → dist/src/page/threeStage.js");
}

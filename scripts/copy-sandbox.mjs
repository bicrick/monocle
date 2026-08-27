/** Copy sandbox.html into dist unchanged so Vite cannot extract its eval script. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src/sandbox/sandbox.html");
const dest = path.join(root, "dist/src/sandbox/sandbox.html");

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
console.log("copied raw sandbox.html → dist/src/sandbox/sandbox.html");

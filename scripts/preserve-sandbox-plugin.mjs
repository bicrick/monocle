/**
 * CRXJS HMR replaces sandbox.html with a DEV MODE stub that never posts
 * monacle-ready. Keep the raw eval sandbox in dist during vite watch/build.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandboxSrc = path.join(root, "src/sandbox/sandbox.html");
const sandboxDest = path.join(root, "dist/src/sandbox/sandbox.html");

export function preserveSandboxHtml() {
  let timer = null;

  const copy = () => {
    if (!fs.existsSync(sandboxSrc)) return;
    fs.mkdirSync(path.dirname(sandboxDest), { recursive: true });
    fs.copyFileSync(sandboxSrc, sandboxDest);
  };

  const needsRestore = () => {
    if (!fs.existsSync(sandboxDest)) return true;
    const html = fs.readFileSync(sandboxDest, "utf8");
    return (
      html.includes("CRXJS DEV MODE") ||
      !html.includes("monacle-runtime-start")
    );
  };

  const restoreIfNeeded = () => {
    if (needsRestore()) copy();
  };

  return {
    name: "monacle-preserve-sandbox-html",
    apply: () => true,
    buildStart() {
      restoreIfNeeded();
    },
    writeBundle() {
      copy();
    },
    closeBundle() {
      copy();
    },
    configureServer(server) {
      restoreIfNeeded();
      timer = setInterval(restoreIfNeeded, 750);
      const stop = () => {
        if (timer) clearInterval(timer);
        timer = null;
      };
      server.httpServer?.once("close", stop);
    },
  };
}

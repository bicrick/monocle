import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";
import { preserveSandboxHtml } from "./scripts/preserve-sandbox-plugin.mjs";

export default defineConfig({
  base: "./",
  plugins: [crx({ manifest }), preserveSandboxHtml()],
});

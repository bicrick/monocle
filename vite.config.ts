import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

export default defineConfig({
  base: "./",
  plugins: [crx({ manifest })],
  build: {
    rollupOptions: {
      input: {
        sandbox: "src/sandbox/sandbox.html",
      },
    },
  },
});

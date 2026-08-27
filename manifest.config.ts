import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "Monacle",
  version: "0.1.0",
  description: "Restyle any live page with a sandboxed cloud agent.",
  permissions: ["sidePanel", "storage", "activeTab", "scripting", "tabs"],
  host_permissions: [
    "http://127.0.0.1/*",
    "http://localhost/*",
    "https://api.anthropic.com/*",
    "https://api.openai.com/*",
    "https://api.x.ai/*",
    "<all_urls>",
  ],
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  action: {
    default_title: "Monacle",
  },
  side_panel: {
    default_path: "src/sidepanel/index.html",
  },
  options_ui: {
    page: "src/options/index.html",
    open_in_tab: true,
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
    },
  ],
  sandbox: {
    pages: ["src/sandbox/sandbox.html"],
  },
  content_security_policy: {
    sandbox:
      "sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self' 'unsafe-inline' 'unsafe-eval'; child-src 'self';",
  },
  web_accessible_resources: [
    {
      resources: ["src/sandbox/sandbox.html", "src/page/threeStage.js"],
      matches: ["<all_urls>"],
    },
  ],
});

import type { Patch } from "../shared/types";

/** Reference cinema patch for YouTube watch — used in tests / prompt tuning. */
export const CINEMA_DEMO_PATCH: Patch = {
  message: "Cinema mode — chrome hidden, player centered in a dark room.",
  css: `
html[data-monacle="on"] ytd-masthead,
html[data-monacle="on"] #secondary,
html[data-monacle="on"] #below,
html[data-monacle="on"] #comments,
html[data-monacle="on"] #related,
html[data-monacle="on"] #chat,
html[data-monacle="on"] #chat-container,
html[data-monacle="on"] ytd-mini-guide-renderer,
html[data-monacle="on"] #guide-button,
html[data-monacle="on"] #guide,
html[data-monacle="on"] tp-yt-app-drawer {
  display: none !important;
}
html[data-monacle="on"] ytd-watch-flexy {
  background: #0a0a0a !important;
}
html[data-monacle="on"] #player-container,
html[data-monacle="on"] #player {
  max-width: 92vw !important;
  margin: 4vh auto 0 !important;
}
html[data-monacle="on"] #movie_player,
html[data-monacle="on"] .html5-video-player {
  box-shadow: 0 0 80px rgba(0,0,0,0.9), 0 0 0 2px #2a2a2a !important;
  border-radius: 2px !important;
}
html[data-monacle="on"] body {
  background: #050505 !important;
  overflow: hidden !important;
}
`,
  overlayHtml: `
<div style="position:fixed;inset:0;background:radial-gradient(ellipse at center, transparent 35%, #000 78%);pointer-events:none;"></div>
<div style="position:fixed;left:0;right:0;bottom:0;height:18vh;background:linear-gradient(to top,#1a0a0a,#0a0505 40%,transparent);pointer-events:none;"></div>
<div style="position:fixed;left:0;top:0;bottom:0;width:7vw;background:linear-gradient(to right,#000,transparent);opacity:0.85;pointer-events:none;"></div>
<div style="position:fixed;right:0;top:0;bottom:0;width:7vw;background:linear-gradient(to left,#000,transparent);opacity:0.85;pointer-events:none;"></div>
`,
  ops: [
    { type: "hide", selector: "#secondary" },
    { type: "hide", selector: "ytd-masthead" },
    { type: "hide", selector: "#comments" },
  ],
};

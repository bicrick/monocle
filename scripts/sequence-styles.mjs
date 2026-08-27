/**
 * Ordered multi-style prompts for the headed sequence loop.
 * Marketing/about-page friendly; environmental (overlayHtml + runtime canvas).
 * Avoid purple hues.
 */
export const SEQUENCE_STYLES = [
  {
    id: "ocean",
    label: "Ocean / underwater",
    prompt:
      "Make it look like I am wathcing from under the ocean. Waves, coral, fish. Use overlayHtml atmosphere plus a runtime canvas with swimming fish, bubbles, and caustic light — not CSS alone.",
  },
  {
    id: "desert",
    label: "Desert canyon / heat haze",
    prompt:
      "Transform this about page into a sun-blasted desert canyon at midday. Red sandstone cliffs, dust, shimmering heat haze over the content. Use overlayHtml for canyon silhouettes and a runtime canvas for heat-ripple distortion, drifting dust motes, and sun glare. Warm amber and terracotta — no purple.",
  },
  {
    id: "cabin-night",
    label: "Snowy mountain cabin night",
    prompt:
      "Restyle this page as a snowy mountain cabin at night. Dark pine forest, falling snow, warm cabin-window glow on the main content. overlayHtml for mountain silhouettes and frosted edges; runtime canvas for drifting snowflakes and soft firelight flicker. Deep navy, pine green, warm amber — no purple.",
  },
  {
    id: "film-noir",
    label: "Film noir / smoky cinema",
    prompt:
      "Make this marketing page feel like a 1940s film-noir cinema lobby. High-contrast black and white with cigarette-smoke haze, venetian-blind light shafts, and a subtle film-grain flicker. overlayHtml for smoky atmosphere and blind shadows; runtime canvas for rising smoke wisps and grain. Charcoal, silver, cream — no purple.",
  },
  {
    id: "crt-arcade",
    label: "Retro CRT arcade",
    prompt:
      "Turn this about page into a retro CRT arcade cabinet screen. Thick scanlines, slight barrel curvature feel, phosphor green and amber HUD chrome around the content, occasional CRT flicker and rolling interference. overlayHtml for bezel/scanline stage; runtime canvas for scanline sweep, phosphor bloom, and soft flicker. Teal, amber, mint green — no purple.",
  },
];

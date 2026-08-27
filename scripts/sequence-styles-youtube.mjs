/**
 * YouTube watch-page golf-course sequence styles.
 * Environmental (overlayHtml + runtime); preserve #movie_player / video.
 * Avoid purple hues. Keep runtime canvas modest so YouTube stays responsive.
 */
export const SEQUENCE_STYLES = [
  {
    id: "golf-day",
    label: "Golf course day / fairway",
    prompt:
      "Make watching this YouTube video feel like sitting on a sunny golf course fairway. Rolling green fairway, manicured greens, sand bunkers, distant trees, and a bright blue sky around the player — not covering it. Use overlayHtml for fairway/bunker/sky atmosphere and a lightweight runtime canvas for drifting clouds and soft grass sway (keep particle counts modest). Preserve #movie_player and the video element completely — never destroy or replace media. Stack the player above the scene (z-index). Hide chrome (masthead, secondary, comments, related) so the course frames the video. Fresh greens, sand beige, sky blue — no purple.",
  },
  {
    id: "golf-golden",
    label: "Golden hour tee box",
    prompt:
      "Transition this YouTube watch page into a golden-hour tee box on a golf course. Warm low sun, long fairway shadows, amber sky glow, tee markers and distant green — atmosphere around the still-visible video player. Prefer dynamic overlayHtml plus a lightweight runtime canvas (sun flare drift, soft light shafts) over CSS alone. Never remove or rewrite #movie_player / video. Keep the player clearly readable and on top. Warm gold, moss green, soft orange sky — no purple.",
  },
  {
    id: "golf-night",
    label: "Night range with range lights",
    prompt:
      "Restyle this YouTube page as a night driving range with tall range lights. Deep navy-green turf, illuminated range nets in the distance, glowing floodlights — all around the video, never opaque over the player. Use overlayHtml for night course + light poles and a lightweight runtime canvas for flickering range lights and a few soft airborne particles (keep it simple; YouTube must stay responsive). Preserve #movie_player and video at all costs. Dark turf, warm range-light amber, cool night sky — no purple.",
  },
];

/**
 * Decide whether a model `canvas.width` / `canvas.height` write should apply.
 * Generated restyles assign innerWidth/innerHeight every frame; doing that on a
 * transferred OffscreenCanvas reallocates the GPU backing store and can crash
 * the tab. Ignore invalid / unchanged sizes.
 */

/** Full-viewport OffscreenCanvas at native res can kill the extension renderer. */
export const CANVAS_LONG_SIDE_CAP = 1280;

export function capCanvasSize(
  width: number,
  height: number,
  cap = CANVAS_LONG_SIDE_CAP,
): { width: number; height: number } {
  const w = Math.max(1, Math.round(Number(width) || 0));
  const h = Math.max(1, Math.round(Number(height) || 0));
  const long = Math.max(w, h);
  if (!Number.isFinite(long) || long <= cap) {
    return { width: w, height: h };
  }
  const scale = cap / long;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

export function nextCanvasDim(
  current: number,
  requested: unknown,
): number | null {
  const n = typeof requested === "number" ? requested : Number(requested);
  if (!Number.isFinite(n) || n < 1) return null;
  const rounded = Math.round(n);
  if (rounded === current) return null;
  return rounded;
}

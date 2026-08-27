/**
 * Paint a sandbox ImageBitmap onto the host overlay canvas.
 * The sandbox never owns the page canvas (no transferControlToOffscreen).
 */

export function paintBitmap(
  canvas: HTMLCanvasElement,
  bitmap: ImageBitmap,
): void {
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
    if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
    ctx.drawImage(bitmap, 0, 0);
  } finally {
    try {
      bitmap.close();
    } catch {
      // already closed
    }
  }
}

export function isImageBitmap(value: unknown): value is ImageBitmap {
  return (
    typeof ImageBitmap !== "undefined" &&
    value instanceof ImageBitmap
  );
}

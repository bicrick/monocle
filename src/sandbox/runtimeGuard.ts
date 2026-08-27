/** Limits for generated restyle loops. Shared with tests; mirrored in sandbox.html. */

export const RAF_ERROR_LIMIT = 3;
export const FRAME_BUDGET_MS = 16;

export function nextErrorStreak(prev: number, failed: boolean): number {
  return failed ? prev + 1 : 0;
}

export function shouldTripBreaker(
  streak: number,
  limit = RAF_ERROR_LIMIT,
): boolean {
  return streak >= limit;
}

export function shouldSkipFrame(
  elapsedMs: number,
  budgetMs = FRAME_BUDGET_MS,
): boolean {
  return elapsedMs > budgetMs;
}

/** Catch any agent-influenced call so a throw cannot take down the host. */

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || "Error";
  return String(err);
}

export function isolate<T>(fn: () => T, fallback: T): { value: T; error?: string } {
  try {
    return { value: fn() };
  } catch (err) {
    return { value: fallback, error: errorMessage(err) };
  }
}

export function isolateVoid(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return errorMessage(err);
  }
}

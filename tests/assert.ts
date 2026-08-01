export function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}
export function equals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`not equal: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}
export async function rejects(
  fn: () => unknown | Promise<unknown>,
  includes?: string,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (includes && (!(error instanceof Error) || !error.message.includes(includes))) throw error;
    return;
  }
  throw new Error("expected rejection");
}

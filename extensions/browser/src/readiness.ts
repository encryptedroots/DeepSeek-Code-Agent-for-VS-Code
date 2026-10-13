export async function waitForReadiness<T>(
  probe: () => Promise<T | undefined>,
  isReady: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 500,
  shouldContinue: () => boolean = () => true,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!shouldContinue()) throw new Error("Readiness check was cancelled.");
    const value = await probe();
    if (value !== undefined && isReady(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for the requested page to become ready.");
}

export async function waitForReadinessWithReload<T>(
  probe: () => Promise<T | undefined>,
  isReady: (value: T) => boolean,
  reload: () => Promise<void>,
  initialTimeoutMs: number,
  retryTimeoutMs: number,
  intervalMs = 500,
  shouldContinue: () => boolean = () => true,
): Promise<T> {
  try {
    return await waitForReadiness(probe, isReady, initialTimeoutMs, intervalMs, shouldContinue);
  } catch (error) {
    if (error instanceof Error && error.message === "Readiness check was cancelled.") throw error;
    if (!shouldContinue()) throw new Error("Readiness check was cancelled.");
    await reload();
    return waitForReadiness(probe, isReady, retryTimeoutMs, intervalMs, shouldContinue);
  }
}

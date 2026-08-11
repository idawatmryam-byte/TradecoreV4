export type EngineResumeOutcome = {
  key: string;
  success: boolean;
  timedOut: boolean;
  detail: string;
};

export type EngineResumeTarget = {
  /** Stable, non-secret diagnostic identity such as userId:section. */
  key: string;
  resume(): Promise<{ healthy: boolean; detail: string }>;
  /** Immediately closes new-entry authority when the deadline is exceeded. */
  failClosedOnTimeout(): void;
};

export type EngineResumeCoordinatorOptions = {
  concurrency: number;
  timeoutMs: number;
  onOutcome(outcome: EngineResumeOutcome): void;
};

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed)
    ? Math.min(max, Math.max(min, parsed))
    : fallback;
}

export function engineResumeConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): {
  concurrency: number;
  timeoutMs: number;
} {
  return {
    concurrency: boundedInteger(env.ENGINE_RESUME_CONCURRENCY, 2, 1, 4),
    timeoutMs:
      boundedInteger(env.ENGINE_RESUME_TIMEOUT_SECONDS, 90, 10, 170) * 1_000,
  };
}

/**
 * Resume independently-owned engines through a conservative worker pool.
 *
 * A timed-out operation is counted exactly once and fail-closed immediately,
 * but its worker does not pick up another target until the underlying provider
 * operation settles. This keeps actual provider concurrency bounded even when
 * timeout reporting fires before a non-cancellable network call returns.
 */
export async function coordinateEngineResume(
  targets: readonly EngineResumeTarget[],
  options: EngineResumeCoordinatorOptions,
): Promise<void> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("Engine resume concurrency must be a positive integer");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("Engine resume timeout must be positive");
  }

  const ordered = [...targets].sort((a, b) => a.key.localeCompare(b.key));
  let nextIndex = 0;

  async function runTarget(target: EngineResumeTarget): Promise<void> {
    let outcomeRecorded = false;
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    const operation = Promise.resolve().then(() => target.resume());
    const timeout = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        outcomeRecorded = true;
        target.failClosedOnTimeout();
        options.onOutcome({
          key: target.key,
          success: false,
          timedOut: true,
          detail: `Engine resume exceeded ${options.timeoutMs}ms`,
        });
        resolve();
      }, options.timeoutMs);
    });

    const settled = operation.then(
      (result) => {
        if (!outcomeRecorded) {
          outcomeRecorded = true;
          options.onOutcome({
            key: target.key,
            success: result.healthy,
            timedOut: false,
            detail: result.detail,
          });
        }
      },
      (error: unknown) => {
        if (!outcomeRecorded) {
          outcomeRecorded = true;
          options.onOutcome({
            key: target.key,
            success: false,
            timedOut: false,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );

    await Promise.race([settled, timeout]);
    if (timeoutHandle) clearTimeout(timeoutHandle);

    // Do not release this worker on timeout until the provider operation is no
    // longer in flight. The result was already recorded and cannot disappear.
    if (timedOut) await settled;
  }

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      const target = ordered[index];
      if (!target) return;
      await runTarget(target);
    }
  }

  const workerCount = Math.min(options.concurrency, ordered.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

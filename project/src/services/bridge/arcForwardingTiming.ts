export interface ArcForwardingTiming {
  startedAt: number;
  emittedMilestones: Set<string>;
  traceId: string;
  attempts: Map<string, number>;
  failures: Map<string, number>;
  now: () => number;
}

let nextTraceId = 1;
const quoteTimings = new WeakMap<object, ArcForwardingTiming>();

export function beginArcForwardingTiming(startStage = 'Confirm bridge clicked', now = () => performance.now()): ArcForwardingTiming {
  const timing = {
    startedAt: now(),
    emittedMilestones: new Set<string>(),
    traceId: `bridge-${Date.now().toString(36)}-${nextTraceId++}`,
    attempts: new Map<string, number>(),
    failures: new Map<string, number>(),
    now,
  };
  markArcForwardingTiming(timing, startStage);
  return timing;
}

export function associateBridgeQuoteTiming<T extends object>(quote: T, timing: ArcForwardingTiming) {
  quoteTimings.set(quote, timing);
  markArcForwardingTiming(timing, 'Bridge quote ready');
  return quote;
}

export function getBridgeQuoteTiming(quote: object | undefined) {
  return quote ? quoteTimings.get(quote) : undefined;
}

export function getBridgeErrorCategory(error: unknown) {
  const detail = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? '');
  const normalized = detail.toLowerCase();
  if (/user.?rejected|rejected the request|request rejected|code 4001/.test(normalized)) return 'wallet_rejected';
  if (/timeout|timed out|aborted/.test(normalized)) return 'timeout';
  if (/429|rate.?limit/.test(normalized)) return 'rate_limited';
  if (/rpc|eth_call|receipt|block not found|network error|fetch failed/.test(normalized)) return 'rpc_or_network';
  if (/attestation|iris|circle|relayer|forward/.test(normalized)) return 'circle_service';
  if (/insufficient|revert|execution reverted/.test(normalized)) return 'onchain_execution';
  if (/wallet|provider|connector/.test(normalized)) return 'wallet_provider';
  return 'unknown';
}

export function markArcForwardingTiming(timing: ArcForwardingTiming | undefined, step: string) {
  if (!timing || timing.emittedMilestones.has(step)) return;
  timing.emittedMilestones.add(step);
  console.info('[ORBIT TIMING]', {
    traceId: timing.traceId,
    event: 'transition',
    stage: step,
    elapsedMs: Number((timing.now() - timing.startedAt).toFixed(1)),
  });
}

export function recordArcForwardingFailure(timing: ArcForwardingTiming | undefined, stage: string, error: unknown) {
  if (!timing) return;
  const attempt = (timing.attempts.get(stage) ?? 0) + 1;
  timing.attempts.set(stage, attempt);
  const retryCount = timing.failures.get(stage) ?? 0;
  timing.failures.set(stage, retryCount + 1);
  console.info('[ORBIT TIMING]', {
    traceId: timing.traceId,
    event: 'stage_failed',
    stage,
    attempt,
    retryCount,
    elapsedMs: Number((timing.now() - timing.startedAt).toFixed(1)),
    errorCategory: getBridgeErrorCategory(error),
  });
}

export async function timeArcForwardingAwait<T>(timing: ArcForwardingTiming | undefined, step: string, operation: () => Promise<T>): Promise<T> {
  if (!timing) return operation();
  const attempt = (timing.attempts.get(step) ?? 0) + 1;
  timing.attempts.set(step, attempt);
  const retryCount = timing.failures.get(step) ?? 0;
  const startedAt = timing.now();
  console.info('[ORBIT TIMING]', {
    traceId: timing.traceId,
    event: 'stage_started',
    stage: step,
    attempt,
    retryCount,
    elapsedMs: Number((startedAt - timing.startedAt).toFixed(1)),
  });
  try {
    const result = await operation();
    const completedAt = timing.now();
    console.info('[ORBIT TIMING]', {
      traceId: timing.traceId,
      event: 'stage_completed',
      stage: step,
      attempt,
      retryCount,
      durationMs: Number((completedAt - startedAt).toFixed(1)),
      elapsedMs: Number((completedAt - timing.startedAt).toFixed(1)),
    });
    return result;
  } catch (error) {
    const failedAt = timing.now();
    timing.failures.set(step, retryCount + 1);
    console.info('[ORBIT TIMING]', {
      traceId: timing.traceId,
      event: 'stage_failed',
      stage: step,
      attempt,
      retryCount,
      durationMs: Number((failedAt - startedAt).toFixed(1)),
      elapsedMs: Number((failedAt - timing.startedAt).toFixed(1)),
      errorCategory: getBridgeErrorCategory(error),
    });
    throw error;
  }
}

export function timeArcForwardingSync<T>(timing: ArcForwardingTiming | undefined, step: string, operation: () => T): T {
  if (!timing) return operation();
  const attempt = (timing.attempts.get(step) ?? 0) + 1;
  timing.attempts.set(step, attempt);
  const retryCount = timing.failures.get(step) ?? 0;
  const startedAt = timing.now();
  console.info('[ORBIT TIMING]', {
    traceId: timing.traceId,
    event: 'stage_started',
    stage: step,
    attempt,
    retryCount,
    elapsedMs: Number((startedAt - timing.startedAt).toFixed(1)),
  });
  try {
    const result = operation();
    const completedAt = timing.now();
    console.info('[ORBIT TIMING]', {
      traceId: timing.traceId,
      event: 'stage_completed',
      stage: step,
      attempt,
      retryCount,
      durationMs: Number((completedAt - startedAt).toFixed(1)),
      elapsedMs: Number((completedAt - timing.startedAt).toFixed(1)),
    });
    return result;
  } catch (error) {
    const failedAt = timing.now();
    timing.failures.set(step, retryCount + 1);
    console.info('[ORBIT TIMING]', {
      traceId: timing.traceId,
      event: 'stage_failed',
      stage: step,
      attempt,
      retryCount,
      durationMs: Number((failedAt - startedAt).toFixed(1)),
      elapsedMs: Number((failedAt - timing.startedAt).toFixed(1)),
      errorCategory: getBridgeErrorCategory(error),
    });
    throw error;
  }
}

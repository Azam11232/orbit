export interface ArcForwardingTiming {
  startedAt: number;
  emittedMilestones: Set<string>;
}

export function beginArcForwardingTiming(): ArcForwardingTiming {
  const timing = { startedAt: performance.now(), emittedMilestones: new Set<string>() };
  markArcForwardingTiming(timing, 'Confirm bridge clicked');
  return timing;
}

export function markArcForwardingTiming(timing: ArcForwardingTiming | undefined, step: string) {
  if (!timing || timing.emittedMilestones.has(step)) return;
  timing.emittedMilestones.add(step);
  console.info(`[ORBIT TIMING] ${step}: ${(performance.now() - timing.startedAt).toFixed(1)}ms`);
}

export async function timeArcForwardingAwait<T>(timing: ArcForwardingTiming | undefined, step: string, operation: () => Promise<T>): Promise<T> {
  if (!timing) return operation();
  markArcForwardingTiming(timing, `${step} started`);
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    console.info(`[ORBIT TIMING] ${step}: ${(performance.now() - startedAt).toFixed(1)}ms`);
    markArcForwardingTiming(timing, `${step} completed`);
  }
}

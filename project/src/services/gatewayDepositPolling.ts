export type GatewayDepositPollResult = 'available' | 'timeout' | 'aborted';

export const GATEWAY_DEPOSIT_POLL_OPTIONS = {
  timeoutMs: 30 * 60_000,
  initialIntervalMs: 5_000,
  maxIntervalMs: 60_000,
} as const;

export function waitForGatewayPollInterval(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function pollForGatewayDepositAvailability(input: {
  readAvailableBalance: () => Promise<bigint>;
  baselineBalance: bigint;
  depositAmount: bigint;
  signal: AbortSignal;
  timeoutMs?: number;
  initialIntervalMs?: number;
  maxIntervalMs?: number;
  now?: () => number;
  wait?: (delayMs: number, signal: AbortSignal) => Promise<boolean>;
  onReadError?: (error: unknown) => void;
}): Promise<GatewayDepositPollResult> {
  const now = input.now ?? Date.now;
  const wait = input.wait ?? waitForGatewayPollInterval;
  const startedAt = now();
  const timeoutMs = input.timeoutMs ?? GATEWAY_DEPOSIT_POLL_OPTIONS.timeoutMs;
  const maxIntervalMs = input.maxIntervalMs ?? GATEWAY_DEPOSIT_POLL_OPTIONS.maxIntervalMs;
  let intervalMs = input.initialIntervalMs ?? GATEWAY_DEPOSIT_POLL_OPTIONS.initialIntervalMs;
  const requiredBalance = input.baselineBalance + input.depositAmount;

  while (!input.signal.aborted) {
    try {
      if (await input.readAvailableBalance() >= requiredBalance) return 'available';
    } catch (error) {
      input.onReadError?.(error);
    }

    if (input.signal.aborted) return 'aborted';
    const remainingMs = timeoutMs - (now() - startedAt);
    if (remainingMs <= 0) return 'timeout';
    if (!await wait(Math.min(intervalMs, remainingMs), input.signal)) return 'aborted';
    intervalMs = Math.min(intervalMs * 2, maxIntervalMs);
  }

  return 'aborted';
}

export async function watchConfirmedGatewayDeposit(input: {
  onConfirmed: () => void;
  readAvailableBalance: () => Promise<bigint>;
  baselineBalance: bigint;
  depositAmount: bigint;
  signal: AbortSignal;
  timeoutMs?: number;
  initialIntervalMs?: number;
  maxIntervalMs?: number;
  now?: () => number;
  wait?: (delayMs: number, signal: AbortSignal) => Promise<boolean>;
  onReadError?: (error: unknown) => void;
}): Promise<GatewayDepositPollResult> {
  input.onConfirmed();
  return pollForGatewayDepositAvailability(input);
}

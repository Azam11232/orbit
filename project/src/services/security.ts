import {
  erc20Abi,
  decodeEventLog,
  formatUnits,
  maxUint256,
  parseAbiItem,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { ARC_TESTNET } from '../data/networks';
import { ARC_EURC, ARC_USDC } from '../data/tokens';
import type { ChainTransaction } from './transactions';

export type ApprovalRisk = 'High' | 'Medium' | 'Low' | 'Unknown';

export interface ApprovalTokenConfig {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
  color: string;
}

interface CachedApprovalLogRange {
  coveredToBlock: bigint;
  logs: ApprovalLog[];
  expiresAt: number;
}

interface CachedApprovalScanState {
  version: 1;
  fromBlock: string;
  coveredRanges: Array<{ fromBlock: string; toBlock: string }>;
  spenderBlocks: Record<string, string>;
  nextScanBlock?: string;
  failedRanges?: Array<{ fromBlock: string; toBlock: string }>;
  maxBlockRange?: string;
  lastSuccessfulAt?: number;
  lastSuccessfulRange?: { fromBlock: string; toBlock: string };
  retryAfterAt?: number;
}

export interface TokenApproval {
  id: string;
  token: ApprovalTokenConfig;
  spenderAddress: Address;
  allowance: bigint;
  allowanceFormatted: string;
  isUnlimited: boolean;
  risk: ApprovalRisk;
  status: string;
  lastSeenBlock: bigint;
  allowanceCheckedBlock: bigint;
  allowanceCheckedAt: number;
  tokenVerified: boolean | null;
  spenderVerified: boolean | null;
}

export interface ApprovalScanResult {
  approvals: TokenApproval[];
  walletAddress: Address;
  chainId: number;
  scannedFromBlock: bigint;
  scannedToBlock: bigint;
  historyWindowBlocks: bigint;
  scope: string;
  errors: string[];
  isComplete: boolean;
  coveredBlocks: bigint;
  totalBlocks: bigint;
  tokenCoverage: Array<{
    symbol: string;
    coveredRanges: Array<{ fromBlock: bigint; toBlock: bigint }>;
    failedRanges: Array<{ fromBlock: bigint; toBlock: bigint }>;
    remainingRanges: Array<{ fromBlock: bigint; toBlock: bigint }>;
    remainingRangeCount: number;
    lastSuccessfulAt: number | null;
    lastSuccessfulRange: { fromBlock: bigint; toBlock: bigint } | null;
  }>;
  lastSuccessfulAt: number | null;
  lastScanAttemptAt: number;
  retryAfterAt: number | null;
}

export function summarizeApprovalScanErrors(errors: string[]): string[] {
  const grouped = new Map<string, { count: number; example: string }>();
  const otherErrors = [...new Set(errors)];
  const logFailureCategory = (detail: string) => {
    if (/rate.?limit|too many requests|\b429\b/i.test(detail)) return 'rate-limited';
    if (/request exceeds defined limit|response (?:size|too large)|result(?:s)? (?:set )?too large|requested range too large|range.{0,40}(?:too large|exceed|maximum|limit)/i.test(detail)) return 'range-limit rejected';
    if (/requested data not available|historical data unavailable|pruned history unavailable|unknown block/i.test(detail)) return 'block data unavailable';
    if (/timeout|timed out|deadline exceeded/i.test(detail)) return 'timed out';
    if (/fetch failed|network error|connection refused|connection reset/i.test(detail)) return 'network unavailable';
    return 'failed';
  };
  const groupedPatterns = [
    {
      pattern: /^(.+?) Approval events blocks [\d-]+: (.*)$/i,
      label: (token: string, detail: string) =>
        `${token} approval log ranges ${logFailureCategory(detail)}`,
    },
    {
      pattern: /^(.+?) spender verification for 0x[a-f\d]+: (.*)$/i,
      label: (token: string) => `${token} spender verification`,
    },
    {
      pattern: /^(.+?) allowance for 0x[a-f\d]+: (.*)$/i,
      label: (token: string) => `${token} allowance checks`,
    },
  ];

  for (const error of errors) {
    const match = groupedPatterns
      .map(({ pattern, label }) => {
        const captures = error.match(pattern);
        return captures ? { key: label(captures[1], captures[2]), detail: captures[2] } : undefined;
      })
      .find((item) => item !== undefined);
    if (!match) continue;
    const otherErrorIndex = otherErrors.indexOf(error);
    if (otherErrorIndex >= 0) otherErrors.splice(otherErrorIndex, 1);
    const current = grouped.get(match.key);
    grouped.set(match.key, current
      ? { ...current, count: current.count + 1 }
      : { count: 1, example: match.detail });
  }

  const summaries = [...grouped.entries()].map(([label, value]) =>
    `${label}: ${value.count} failed${value.count > 1 ? ` (example: ${value.example})` : `: ${value.example}`}`,
  );
  if (otherErrors.length <= 4) summaries.push(...otherErrors);
  else summaries.push(`${otherErrors.length} other scan checks failed; see technical details.`);
  return summaries;
}

export const APPROVAL_TOKENS: ApprovalTokenConfig[] = [ARC_USDC, ARC_EURC].map((asset) => ({
  symbol: asset.symbol,
  name: asset.name,
  address: asset.address,
  decimals: asset.decimals,
  color: asset.color,
}));

export function canRevokeApproval(approval: TokenApproval): boolean {
  return approval.allowance > 0n &&
    approval.tokenVerified === true &&
    approval.spenderVerified === true &&
    APPROVAL_TOKENS.some(
      (token) => token.address.toLowerCase() === approval.token.address.toLowerCase(),
    );
}

export type RevokeConfirmationStatus = 'success' | 'confirmation-pending' | 'verification-pending' | 'error';

export function getRevokeConfirmationStatus({
  receiptStatus,
  expectedWallet,
  receiptWallet,
  allowanceAtReceipt,
  refreshedAllowance,
}: {
  receiptStatus: 'success' | 'reverted' | null;
  expectedWallet: Address;
  receiptWallet: Address;
  allowanceAtReceipt?: bigint;
  refreshedAllowance?: bigint;
}): RevokeConfirmationStatus {
  if (receiptStatus === null) return 'confirmation-pending';
  if (receiptStatus !== 'success' || receiptWallet.toLowerCase() !== expectedWallet.toLowerCase()) return 'error';
  if (allowanceAtReceipt === undefined || refreshedAllowance === undefined) return 'verification-pending';
  return allowanceAtReceipt === 0n && refreshedAllowance === 0n ? 'success' : 'error';
}

const approvalEvent = parseAbiItem(
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
);
export const APPROVAL_SCAN_HISTORY_WINDOWS = [50_000, 100_000, 250_000] as const;
export type ApprovalScanHistoryWindow = (typeof APPROVAL_SCAN_HISTORY_WINDOWS)[number];
export const DEFAULT_APPROVAL_SCAN_HISTORY_WINDOW: ApprovalScanHistoryWindow = 50_000;
export const APPROVAL_SCAN_HISTORY_WINDOW_STORAGE_KEY = 'orbit:approval-scan-history-window';

export function getPreferredApprovalScanHistoryWindow(): ApprovalScanHistoryWindow {
  try {
    const savedWindow = Number(localStorage.getItem(APPROVAL_SCAN_HISTORY_WINDOW_STORAGE_KEY));
    const isSupportedWindow = (window: number): window is ApprovalScanHistoryWindow =>
      APPROVAL_SCAN_HISTORY_WINDOWS.some((candidate) => candidate === window);
    return isSupportedWindow(savedWindow) ? savedWindow : DEFAULT_APPROVAL_SCAN_HISTORY_WINDOW;
  } catch {
    return DEFAULT_APPROVAL_SCAN_HISTORY_WINDOW;
  }
}
const APPROVAL_LOG_BLOCK_CHUNK = 10_000n;
const MAX_APPROVAL_LOG_CHUNKS_PER_TOKEN_PER_SCAN = 50;
const MAX_APPROVAL_LOG_RANGES_IN_MEMORY_PER_TOKEN = 2_000;
const APPROVAL_LOG_REQUEST_GAP_MS = 500;
const MAX_CONCURRENT_APPROVAL_LOG_REQUESTS = 1;
const MAX_APPROVAL_LOG_RETRIES = 2;
const APPROVAL_LOG_RETRY_BASE_MS = 500;
const MAX_APPROVAL_LOG_RETRY_DELAY_MS = 30_000;
const APPROVAL_LOG_RATE_LIMIT_COOLDOWN_MS = 5_000;
const MAX_APPROVAL_LOG_SPLIT_DEPTH = 14;
const MAX_APPROVAL_LOG_REQUESTS_PER_TOKEN_PER_SCAN = 200;
const APPROVAL_LOG_CACHE_TTL_MS = 30 * 60_000;
const APPROVAL_LOG_CACHE_MAX_ENTRIES = 2_000;
const APPROVAL_SCAN_CACHE_VERSION = 1;
const APPROVAL_SCAN_CACHE_MAX_SPENDERS = 10_000;
const MAX_SPENDERS_PER_TOKEN = 250;
const MAX_CONTRACT_VERIFICATION_LOOKUPS_PER_TOKEN = 20;
const CONTRACT_VERIFICATION_CACHE_MS = 5 * 60_000;
const CONTRACT_VERIFICATION_REQUEST_GAP_MS = 1_200;
export const HIGH_ALLOWANCE_THRESHOLD = 1_000_000n;
export const LARGE_OUTGOING_USDC_THRESHOLD = 100n;

const contractVerificationCache = new Map<string, { verified: boolean; expiresAt: number }>();
let lastContractVerificationRequestAt = 0;
const approvalLogsCache = new WeakMap<object, Map<string, CachedApprovalLogRange>>();
const approvalScanStateCache = new WeakMap<object, Map<string, CachedApprovalScanState>>();
interface ApprovalLogThrottleState {
  activeRequests: number;
  nextRequestAt: number;
  pauseUntil: number;
  requestWaiters: Array<() => void>;
}

const approvalLogThrottleStates = new WeakMap<object, ApprovalLogThrottleState>();
const approvalScansInFlight = new Map<string, Promise<ApprovalScanResult>>();

function getApprovalLogThrottleState(client: PublicClient): ApprovalLogThrottleState {
  const existing = approvalLogThrottleStates.get(client);
  if (existing) return existing;
  const state: ApprovalLogThrottleState = {
    activeRequests: 0,
    nextRequestAt: 0,
    pauseUntil: 0,
    requestWaiters: [],
  };
  approvalLogThrottleStates.set(client, state);
  return state;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function isArcContractVerified(address: Address): Promise<boolean> {
  const cacheKey = address.toLowerCase();
  const cached = contractVerificationCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.verified;

  const elapsed = Date.now() - lastContractVerificationRequestAt;
  if (elapsed < CONTRACT_VERIFICATION_REQUEST_GAP_MS) {
    await delay(CONTRACT_VERIFICATION_REQUEST_GAP_MS - elapsed);
  }
  lastContractVerificationRequestAt = Date.now();
  const response = await fetch(`/api/arcscan/addresses/${address}/contract-info`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(
      `ArcScan contract verification request failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`,
    );
  }

  const result: unknown = await response.json();
  if (
    typeof result !== 'object' ||
    result === null ||
    !('is_contract' in result) ||
    typeof result.is_contract !== 'boolean' ||
    !('is_verified' in result) ||
    typeof result.is_verified !== 'boolean'
  ) {
    throw new Error('ArcScan returned invalid contract verification metadata');
  }

  const verified = result.is_contract && result.is_verified;
  contractVerificationCache.set(cacheKey, {
    verified,
    expiresAt: Date.now() + CONTRACT_VERIFICATION_CACHE_MS,
  });
  return verified;
}

function classifyAllowance(allowance: bigint, decimals: number): ApprovalRisk {
  if (allowance === maxUint256) return 'High';
  if (allowance >= HIGH_ALLOWANCE_THRESHOLD * 10n ** BigInt(decimals)) return 'Medium';
  if (allowance > 0n) return 'Low';
  return 'Unknown';
}

function approvalStatus(risk: ApprovalRisk, isUnlimited: boolean): string {
  if (isUnlimited) return 'Unlimited allowance active';
  if (risk === 'Medium') return 'High allowance active';
  if (risk === 'Low') return 'Limited allowance active';
  return 'Revoked or zero allowance';
}

export function interpretAllowance(allowance: bigint, decimals: number): {
  isUnlimited: boolean;
  isRevoked: boolean;
  risk: ApprovalRisk;
  status: string;
} {
  const isUnlimited = allowance === maxUint256;
  const isRevoked = allowance === 0n;
  const risk = classifyAllowance(allowance, decimals);
  return {
    isUnlimited,
    isRevoked,
    risk,
    status: approvalStatus(risk, isUnlimited),
  };
}

export function interpretVerifiedAllowance(
  allowance: bigint,
  decimals: number,
  tokenVerified: boolean | null,
  spenderVerified: boolean | null,
): ReturnType<typeof interpretAllowance> {
  const interpreted = interpretAllowance(allowance, decimals);
  if (tokenVerified === true && spenderVerified === true) return interpreted;
  return {
    ...interpreted,
    risk: 'Unknown',
    status: `Verification ${tokenVerified === null || spenderVerified === null ? 'unavailable' : 'incomplete'}; ${interpreted.status.toLowerCase()}`,
  };
}

export interface DecodedApprovalEvent {
  owner: Address;
  spender: Address;
  value: bigint;
  blockNumber: bigint;
}

interface ApprovalLog {
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint | null;
}

interface ApprovalLogsResult {
  logs: ApprovalLog[];
  errors: string[];
  successfulRanges: Array<{ fromBlock: bigint; toBlock: bigint }>;
  recommendedBlockRange?: bigint;
  rateLimited?: boolean;
  retryAfterAt?: number;
  deferred?: boolean;
  newlyScanned?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnsupportedLogRange(error: unknown): boolean {
  let current = error;
  while (typeof current === 'object' && current !== null) {
    const rpcError = current as {
      cause?: unknown;
      code?: unknown;
      message?: unknown;
      shortMessage?: unknown;
    };
    const message = [rpcError.shortMessage, rpcError.message]
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
    if (
      rpcError.code === -32012 ||
      /request exceeds defined limit|response (?:size|too large)|result(?:s)? (?:set )?too large|too many results|requested range too large|query returned more than|maximum block span|block range.{0,40}(?:too wide|too large|exceed|maximum|limit)|(?:block )?range.{0,40}(?:too large|too wide|exceed|maximum|limit)/i.test(message)
    ) {
      return true;
    }
    current = rpcError.cause;
  }
  return false;
}

function isTransientInternalLogError(error: unknown): boolean {
  let current = error;
  while (typeof current === 'object' && current !== null) {
    const rpcError = current as {
      cause?: unknown;
      code?: unknown;
      message?: unknown;
      shortMessage?: unknown;
    };
    const message = [rpcError.shortMessage, rpcError.message]
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
    if (rpcError.code === -32603 || /\binternal error\b/i.test(message)) return true;
    current = rpcError.cause;
  }
  return false;
}

function isRateLimitError(error: unknown): boolean {
  let current = error;
  while (typeof current === 'object' && current !== null) {
    const rpcError = current as {
      cause?: unknown;
      status?: unknown;
      code?: unknown;
      message?: unknown;
      shortMessage?: unknown;
      response?: { status?: unknown; headers?: Headers | Record<string, string> };
    };
    const message = [rpcError.shortMessage, rpcError.message]
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
    if (
      rpcError.code === 429 ||
      rpcError.status === 429 ||
      rpcError.response?.status === 429 ||
      rpcError.code === -32005 ||
      /rate.?limit|too many requests|http 429|\b429\b/i.test(message)
    ) {
      return true;
    }
    current = rpcError.cause;
  }
  return false;
}

function retryAfterMs(error: unknown): number | undefined {
  let current = error;
  while (typeof current === 'object' && current !== null) {
    const candidate = current as {
      cause?: unknown;
      headers?: Headers | Record<string, string>;
      response?: { headers?: Headers | Record<string, string> };
    };
    const headers = candidate.headers ?? candidate.response?.headers;
    const retryAfter = headers instanceof Headers
      ? headers.get('retry-after')
      : headers && Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
    if (typeof retryAfter === 'string') {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
      const retryAt = Date.parse(retryAfter);
      if (Number.isFinite(retryAt)) return Math.max(0, retryAt - Date.now());
    }
    current = candidate.cause;
  }
  return undefined;
}

class ApprovalRateLimitDeferredError extends Error {
  constructor(readonly retryAt: number, message: string) {
    super(message);
    this.name = 'ApprovalRateLimitDeferredError';
  }
}

class ApprovalScanBudgetExceededError extends Error {
  constructor() {
    super('Per-token RPC request budget reached; remaining ranges are deferred until the next refresh.');
    this.name = 'ApprovalScanBudgetExceededError';
  }
}

interface ApprovalLogRequestBudget {
  remaining: number;
  rateLimited?: boolean;
  scanRateLimitState?: { detected: boolean };
}

async function acquireApprovalLogRequestSlot(
  throttle: ApprovalLogThrottleState,
): Promise<() => void> {
  while (throttle.activeRequests >= MAX_CONCURRENT_APPROVAL_LOG_REQUESTS) {
    await new Promise<void>((resolve) => throttle.requestWaiters.push(resolve));
  }
  throttle.activeRequests += 1;

  let scheduledAt = Math.max(Date.now(), throttle.nextRequestAt, throttle.pauseUntil);
  throttle.nextRequestAt = scheduledAt + APPROVAL_LOG_REQUEST_GAP_MS;
  while (Date.now() < scheduledAt) {
    await delay(scheduledAt - Date.now());
    if (throttle.pauseUntil > scheduledAt) {
      scheduledAt = throttle.pauseUntil;
      throttle.nextRequestAt = Math.max(throttle.nextRequestAt, scheduledAt + APPROVAL_LOG_REQUEST_GAP_MS);
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    throttle.activeRequests -= 1;
    const next = throttle.requestWaiters.shift();
    next?.();
  };
}

async function fetchApprovalLogs(
  client: PublicClient,
  token: ApprovalTokenConfig,
  owner: Address,
  fromBlock: bigint,
  toBlock: bigint,
  requestBudget: ApprovalLogRequestBudget,
): Promise<ApprovalLog[]> {
  let attempt = 0;
  const throttle = getApprovalLogThrottleState(client);
  while (true) {
    if (requestBudget.rateLimited && attempt === 0) {
      throw new ApprovalRateLimitDeferredError(
        throttle.pauseUntil,
        `RPC rate limit deferred queued range ${fromBlock.toString()}-${toBlock.toString()}.`,
      );
    }
    if (throttle.pauseUntil - Date.now() > MAX_APPROVAL_LOG_RETRY_DELAY_MS) {
      requestBudget.rateLimited = true;
      throw new ApprovalRateLimitDeferredError(
        throttle.pauseUntil,
        `RPC rate limit cooldown is active; retry after ${new Date(throttle.pauseUntil).toISOString()}.`,
      );
    }
    const release = await acquireApprovalLogRequestSlot(throttle);
    let requestError: unknown;
    try {
      if (requestBudget.rateLimited && attempt === 0) {
        throw new ApprovalRateLimitDeferredError(
          throttle.pauseUntil,
          `RPC rate limit deferred queued range ${fromBlock.toString()}-${toBlock.toString()}.`,
        );
      }
      if (requestBudget.remaining <= 0) throw new ApprovalScanBudgetExceededError();
      requestBudget.remaining -= 1;
      const logs = await client.getLogs({
        address: token.address,
        event: approvalEvent,
        args: { owner },
        fromBlock,
        toBlock,
      });
      requestBudget.rateLimited = false;
      if (Date.now() >= throttle.pauseUntil) throttle.pauseUntil = 0;
      return logs;
    } catch (error) {
      requestError = error;
    } finally {
      release();
    }

    if (requestError instanceof ApprovalRateLimitDeferredError) {
      throw requestError;
    }
    if (isRateLimitError(requestError)) {
      requestBudget.rateLimited = true;
      if (requestBudget.scanRateLimitState) {
        requestBudget.scanRateLimitState.detected = true;
      }
      const serverRetryDelay = retryAfterMs(requestError);
      const retryDelay = Math.max(
        serverRetryDelay ?? APPROVAL_LOG_RATE_LIMIT_COOLDOWN_MS,
        APPROVAL_LOG_RATE_LIMIT_COOLDOWN_MS,
      );
      throttle.pauseUntil = Math.max(throttle.pauseUntil, Date.now() + retryDelay);
      throw new ApprovalRateLimitDeferredError(
        throttle.pauseUntil,
        `RPC rate limit requires a later retry; retry after ${new Date(throttle.pauseUntil).toISOString()}.`,
      );
    }

    if (!isTransientInternalLogError(requestError) || attempt >= MAX_APPROVAL_LOG_RETRIES) {
      throw requestError;
    }
    const backoff = Math.min(
      MAX_APPROVAL_LOG_RETRY_DELAY_MS,
      APPROVAL_LOG_RETRY_BASE_MS * 2 ** attempt * (0.5 + Math.random()),
    );
    await delay(backoff);
    attempt += 1;
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index]);
      }
    }),
  );
  return results;
}

function cacheApprovalLogs(
  cache: Map<string, CachedApprovalLogRange>,
  key: string,
  coveredToBlock: bigint,
  logs: ApprovalLog[],
): void {
  if (cache.size >= APPROVAL_LOG_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.delete(key);
  cache.set(key, {
    coveredToBlock,
    logs,
    expiresAt: Date.now() + APPROVAL_LOG_CACHE_TTL_MS,
  });
}

function approvalScanStorageKey(token: ApprovalTokenConfig, owner: Address): string {
  return `orbit:approval-scan:v${APPROVAL_SCAN_CACHE_VERSION}:${ARC_TESTNET.id}:${token.address.toLowerCase()}:${owner.toLowerCase()}`;
}

function createApprovalScanState(fromBlock: bigint): CachedApprovalScanState {
  return {
    version: APPROVAL_SCAN_CACHE_VERSION,
    fromBlock: fromBlock.toString(),
    coveredRanges: [],
    spenderBlocks: {},
    nextScanBlock: fromBlock.toString(),
    failedRanges: [],
  };
}

function isCachedApprovalScanState(value: unknown): value is CachedApprovalScanState {
  if (typeof value !== 'object' || value === null || !('version' in value) ||
    value.version !== APPROVAL_SCAN_CACHE_VERSION || !('fromBlock' in value) ||
    typeof value.fromBlock !== 'string' || !/^\d+$/.test(value.fromBlock) ||
    !('coveredRanges' in value) || !Array.isArray(value.coveredRanges) ||
    !('spenderBlocks' in value) || typeof value.spenderBlocks !== 'object' ||
    value.spenderBlocks === null || Array.isArray(value.spenderBlocks)) {
    return false;
  }
  const validRanges = (ranges: unknown): ranges is Array<{ fromBlock: string; toBlock: string }> =>
    Array.isArray(ranges) && ranges.every((range) =>
      typeof range === 'object' && range !== null &&
      'fromBlock' in range && typeof range.fromBlock === 'string' && /^\d+$/.test(range.fromBlock) &&
      'toBlock' in range && typeof range.toBlock === 'string' && /^\d+$/.test(range.toBlock) &&
      BigInt(range.fromBlock) <= BigInt(range.toBlock),
    );
  return validRanges(value.coveredRanges) &&
    (!('failedRanges' in value) || validRanges(value.failedRanges)) &&
    (!('maxBlockRange' in value) ||
      typeof value.maxBlockRange === 'string' && /^\d+$/.test(value.maxBlockRange) &&
      BigInt(value.maxBlockRange) > 0n) &&
    (!('lastSuccessfulAt' in value) ||
      typeof value.lastSuccessfulAt === 'number' && Number.isFinite(value.lastSuccessfulAt)) &&
    (!('lastSuccessfulRange' in value) ||
      typeof value.lastSuccessfulRange === 'object' && value.lastSuccessfulRange !== null &&
      'fromBlock' in value.lastSuccessfulRange &&
      typeof value.lastSuccessfulRange.fromBlock === 'string' &&
      /^\d+$/.test(value.lastSuccessfulRange.fromBlock) &&
      'toBlock' in value.lastSuccessfulRange &&
      typeof value.lastSuccessfulRange.toBlock === 'string' &&
      /^\d+$/.test(value.lastSuccessfulRange.toBlock) &&
      BigInt(value.lastSuccessfulRange.fromBlock) <= BigInt(value.lastSuccessfulRange.toBlock)) &&
    (!('retryAfterAt' in value) ||
      typeof value.retryAfterAt === 'number' && Number.isFinite(value.retryAfterAt)) &&
    Object.entries(value.spenderBlocks).every(([spender, block]) =>
      /^0x[0-9a-f]{40}$/i.test(spender) && typeof block === 'string' && /^\d+$/.test(block),
    ) && (!('nextScanBlock' in value) ||
      typeof value.nextScanBlock === 'string' && /^\d+$/.test(value.nextScanBlock));
}

function loadApprovalScanState(
  client: PublicClient,
  token: ApprovalTokenConfig,
  owner: Address,
  initialFromBlock: bigint,
): { state: CachedApprovalScanState; error?: string } {
  const storageKey = approvalScanStorageKey(token, owner);
  try {
    if (typeof localStorage !== 'undefined') {
      const serialized = localStorage.getItem(storageKey);
      if (serialized === null) return { state: createApprovalScanState(initialFromBlock) };
      const parsed: unknown = JSON.parse(serialized);
      if (isCachedApprovalScanState(parsed)) return { state: parsed };
      return {
        state: createApprovalScanState(initialFromBlock),
        error: 'approval scan cache is invalid; a fresh scan is required.',
      };
    }
  } catch (error) {
    return {
      state: createApprovalScanState(initialFromBlock),
      error: `approval scan cache could not be read: ${errorMessage(error)}`,
    };
  }

  let clientCache = approvalScanStateCache.get(client);
  if (!clientCache) {
    clientCache = new Map();
    approvalScanStateCache.set(client, clientCache);
  }
  return { state: clientCache.get(storageKey) ?? createApprovalScanState(initialFromBlock) };
}

function saveApprovalScanState(
  client: PublicClient,
  token: ApprovalTokenConfig,
  owner: Address,
  state: CachedApprovalScanState,
): string | undefined {
  const storageKey = approvalScanStorageKey(token, owner);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(storageKey, JSON.stringify(state));
      return undefined;
    }
  } catch (error) {
    return `approval scan cache could not be saved: ${errorMessage(error)}`;
  }

  let clientCache = approvalScanStateCache.get(client);
  if (!clientCache) {
    clientCache = new Map();
    approvalScanStateCache.set(client, clientCache);
  }
  clientCache.set(storageKey, state);
  return undefined;
}

function addCoveredRange(
  state: CachedApprovalScanState,
  fromBlock: bigint,
  toBlock: bigint,
): void {
  const ranges = [
    ...state.coveredRanges.map((range) => ({
      fromBlock: BigInt(range.fromBlock),
      toBlock: BigInt(range.toBlock),
    })),
    { fromBlock, toBlock },
  ].sort((left, right) => left.fromBlock < right.fromBlock ? -1 : left.fromBlock > right.fromBlock ? 1 : 0);
  const merged: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.fromBlock <= previous.toBlock + 1n) {
      if (range.toBlock > previous.toBlock) previous.toBlock = range.toBlock;
    } else {
      merged.push({ ...range });
    }
  }
  state.coveredRanges = merged.map((range) => ({
    fromBlock: range.fromBlock.toString(),
    toBlock: range.toBlock.toString(),
  }));
}

function uncoveredApprovalRanges(
  state: CachedApprovalScanState,
  toBlock: bigint,
): Array<[bigint, bigint]> {
  const ranges: Array<[bigint, bigint]> = [];
  let nextBlock = BigInt(state.fromBlock);
  const covered = state.coveredRanges
    .map((range) => ({ fromBlock: BigInt(range.fromBlock), toBlock: BigInt(range.toBlock) }))
    .sort((left, right) => left.fromBlock < right.fromBlock ? -1 : left.fromBlock > right.fromBlock ? 1 : 0);
  for (const range of covered) {
    if (range.toBlock < nextBlock) continue;
    if (range.fromBlock > toBlock) break;
    if (range.fromBlock > nextBlock) ranges.push([nextBlock, range.fromBlock - 1n]);
    if (range.toBlock >= nextBlock) nextBlock = range.toBlock + 1n;
    if (nextBlock > toBlock) break;
  }
  if (nextBlock <= toBlock) ranges.push([nextBlock, toBlock]);

  const chunks: Array<[bigint, bigint]> = [];
  const chunkSize = state.maxBlockRange ? BigInt(state.maxBlockRange) : APPROVAL_LOG_BLOCK_CHUNK;
  for (const [rangeFrom, rangeTo] of ranges) {
    for (let chunkFrom = rangeFrom; chunkFrom <= rangeTo; chunkFrom += chunkSize) {
      if (chunks.length >= MAX_APPROVAL_LOG_RANGES_IN_MEMORY_PER_TOKEN) return chunks;
      const chunkTo = chunkFrom + chunkSize - 1n > rangeTo
        ? rangeTo
        : chunkFrom + chunkSize - 1n;
      chunks.push([chunkFrom, chunkTo]);
    }
  }
  return chunks;
}

function countUncoveredApprovalRanges(state: CachedApprovalScanState, toBlock: bigint): number {
  const chunkSize = state.maxBlockRange ? BigInt(state.maxBlockRange) : APPROVAL_LOG_BLOCK_CHUNK;
  let count = 0n;
  let nextBlock = BigInt(state.fromBlock);
  const covered = state.coveredRanges
    .map((range) => ({ fromBlock: BigInt(range.fromBlock), toBlock: BigInt(range.toBlock) }))
    .sort((left, right) => left.fromBlock < right.fromBlock ? -1 : left.fromBlock > right.fromBlock ? 1 : 0);

  for (const range of covered) {
    if (range.toBlock < nextBlock) continue;
    if (range.fromBlock > toBlock) break;
    if (range.fromBlock > nextBlock) {
      const gapSize = range.fromBlock - nextBlock;
      count += (gapSize + chunkSize - 1n) / chunkSize;
    }
    if (range.toBlock >= nextBlock) nextBlock = range.toBlock + 1n;
    if (nextBlock > toBlock) break;
  }
  if (nextBlock <= toBlock) {
    const gapSize = toBlock - nextBlock + 1n;
    count += (gapSize + chunkSize - 1n) / chunkSize;
  }

  return Number(count);
}

function constrainApprovalScanState(
  state: CachedApprovalScanState,
  fromBlock: bigint,
  toBlock: bigint,
): void {
  const constrainRanges = (ranges: Array<{ fromBlock: string; toBlock: string }>) =>
    ranges.flatMap((range) => {
      const rangeFrom = BigInt(range.fromBlock) < fromBlock ? fromBlock : BigInt(range.fromBlock);
      const rangeTo = BigInt(range.toBlock) > toBlock ? toBlock : BigInt(range.toBlock);
      return rangeFrom <= rangeTo
        ? [{ fromBlock: rangeFrom.toString(), toBlock: rangeTo.toString() }]
        : [];
    });
  state.coveredRanges = constrainRanges(state.coveredRanges);
  state.failedRanges = constrainRanges(state.failedRanges ?? []);
  state.fromBlock = fromBlock.toString();
  const nextScanBlock = BigInt(state.nextScanBlock ?? fromBlock.toString());
  state.nextScanBlock = (nextScanBlock < fromBlock ? fromBlock : nextScanBlock).toString();
}

export function selectApprovalLogRanges(
  ranges: Array<[bigint, bigint]>,
  cursor: bigint,
  limit: number,
  failedRanges: Array<[bigint, bigint]> = [],
): Array<[bigint, bigint]> {
  const retryRanges: Array<[bigint, bigint]> = [];
  for (const [fromBlock, toBlock] of ranges) {
    for (const [failedFrom, failedTo] of failedRanges) {
      const retryFrom = fromBlock > failedFrom ? fromBlock : failedFrom;
      const retryTo = toBlock < failedTo ? toBlock : failedTo;
      if (retryFrom <= retryTo) retryRanges.push([retryFrom, retryTo]);
    }
  }
  const retryKeys = new Set(retryRanges.map(([fromBlock, toBlock]) => `${fromBlock}:${toBlock}`));
  const remainingRanges = ranges.flatMap(([fromBlock, toBlock]) => {
    const overlaps = retryRanges
      .filter(([retryFrom, retryTo]) => fromBlock <= retryTo && toBlock >= retryFrom)
      .sort((left, right) => left[0] < right[0] ? -1 : 1);
    if (overlaps.length === 0) return [[fromBlock, toBlock] as [bigint, bigint]];
    const result: Array<[bigint, bigint]> = [];
    let cursor = fromBlock;
    for (const [retryFrom, retryTo] of overlaps) {
      if (retryFrom > cursor) result.push([cursor, retryFrom - 1n]);
      cursor = retryTo + 1n > cursor ? retryTo + 1n : cursor;
    }
    if (cursor <= toBlock) result.push([cursor, toBlock]);
    return result;
  }).filter(([fromBlock, toBlock]) => !retryKeys.has(`${fromBlock}:${toBlock}`));
  const nextRangeIndex = remainingRanges.findIndex(([rangeFrom]) => rangeFrom >= cursor);
  const orderedRemainingRanges = nextRangeIndex < 0
    ? remainingRanges
    : [...remainingRanges.slice(nextRangeIndex), ...remainingRanges.slice(0, nextRangeIndex)];
  return [...retryRanges, ...orderedRemainingRanges].slice(0, limit);
}

async function getApprovalLogs(
  client: PublicClient,
  token: ApprovalTokenConfig,
  owner: Address,
  fromBlock: bigint,
  toBlock: bigint,
  requestBudget: ApprovalLogRequestBudget,
  splitDepth = 0,
): Promise<ApprovalLogsResult> {
  let clientCache = approvalLogsCache.get(client);
  if (!clientCache) {
    clientCache = new Map();
    approvalLogsCache.set(client, clientCache);
  }
  const cacheKey = [
    ARC_TESTNET.id,
    token.address.toLowerCase(),
    owner.toLowerCase(),
    fromBlock.toString(),
  ].join(':');
  const cached = clientCache.get(cacheKey);
  const cacheIsValid = cached && cached.expiresAt > Date.now();
  const cachedLogs = cacheIsValid
    ? cached.logs.filter((log) => log.blockNumber !== null && log.blockNumber <= toBlock)
    : [];
  if (cacheIsValid && cached.coveredToBlock >= toBlock) {
    return { logs: cachedLogs, errors: [], successfulRanges: [{ fromBlock, toBlock }], newlyScanned: false };
  }
  const queryFromBlock = cacheIsValid ? cached.coveredToBlock + 1n : fromBlock;
  if (cached) clientCache.delete(cacheKey);

  try {
    const newLogs = await fetchApprovalLogs(client, token, owner, queryFromBlock, toBlock, requestBudget);
    const logs = [...cachedLogs, ...newLogs];
    cacheApprovalLogs(clientCache, cacheKey, toBlock, logs);
    return { logs, errors: [], successfulRanges: [{ fromBlock, toBlock }], newlyScanned: true };
  } catch (error) {
    if (fromBlock < toBlock && splitDepth < MAX_APPROVAL_LOG_SPLIT_DEPTH && isUnsupportedLogRange(error)) {
      const midpoint = fromBlock + (toBlock - fromBlock) / 2n;
      const firstHalf = await getApprovalLogs(
        client,
        token,
        owner,
        fromBlock,
        midpoint,
        requestBudget,
        splitDepth + 1,
      );
      const secondHalf: ApprovalLogsResult = firstHalf.deferred
        ? {
            logs: [],
            errors: [],
            successfulRanges: [],
            deferred: true,
            rateLimited: firstHalf.rateLimited,
            retryAfterAt: firstHalf.retryAfterAt,
          }
        : await getApprovalLogs(
            client,
            token,
            owner,
            midpoint + 1n,
            toBlock,
            requestBudget,
            splitDepth + 1,
          );
      const splitRange = (toBlock - fromBlock + 1n + 1n) / 2n;
      const recommendedBlockRange = [splitRange, firstHalf.recommendedBlockRange, secondHalf.recommendedBlockRange]
        .filter((value): value is bigint => value !== undefined)
        .reduce((smallest, value) => value < smallest ? value : smallest);
      return {
        logs: [...firstHalf.logs, ...secondHalf.logs],
        errors: [...firstHalf.errors, ...secondHalf.errors],
        successfulRanges: [...firstHalf.successfulRanges, ...secondHalf.successfulRanges],
        recommendedBlockRange,
        rateLimited: firstHalf.rateLimited || secondHalf.rateLimited,
        retryAfterAt: Math.max(firstHalf.retryAfterAt ?? 0, secondHalf.retryAfterAt ?? 0) || undefined,
        deferred: firstHalf.deferred || secondHalf.deferred,
        newlyScanned: firstHalf.newlyScanned || secondHalf.newlyScanned,
      };
    }

    if (error instanceof ApprovalScanBudgetExceededError) {
      return {
        logs: cachedLogs,
        errors: [],
        successfulRanges: cacheIsValid && cached.coveredToBlock >= fromBlock
          ? [{ fromBlock, toBlock: cached.coveredToBlock }]
          : [],
        deferred: true,
      };
    }

    return {
      logs: cachedLogs,
      errors: [`blocks ${queryFromBlock.toString()}-${toBlock.toString()}: ${errorMessage(error)}`],
      successfulRanges: cacheIsValid && cached.coveredToBlock >= fromBlock
        ? [{ fromBlock, toBlock: cached.coveredToBlock }]
        : [],
      rateLimited: isRateLimitError(error) || error instanceof ApprovalRateLimitDeferredError,
      deferred: error instanceof ApprovalRateLimitDeferredError,
      retryAfterAt: error instanceof ApprovalRateLimitDeferredError
        ? error.retryAt
        : isRateLimitError(error) ? getApprovalLogThrottleState(client).pauseUntil : undefined,
    };
  }
}

export function decodeApprovalEvent(log: ApprovalLog): DecodedApprovalEvent {
  if (log.blockNumber === null) throw new Error('Approval event has no block number');
  const [signature, ownerTopic, spenderTopic] = log.topics;
  if (log.topics.length !== 3 || !signature || !ownerTopic || !spenderTopic) {
    throw new Error('Approval event has invalid indexed topics');
  }
  const topics = [signature, ownerTopic, spenderTopic] as const;
  const decoded = decodeEventLog({
    abi: [approvalEvent],
    data: log.data,
    topics: [...topics],
    strict: true,
  });
  if (decoded.eventName !== 'Approval') throw new Error('Unexpected event in approval scan');
  return {
    owner: decoded.args.owner,
    spender: decoded.args.spender,
    value: decoded.args.value,
    blockNumber: log.blockNumber,
  };
}

export type ApprovalScanStatus =
  | 'Scanning'
  | 'Partial scan — provider limit'
  | 'Partial scan'
  | 'Window complete'
  | 'Failed';

export function getApprovalScanStatus({
  isFetching,
  isError,
  data,
  now = Date.now(),
}: {
  isFetching: boolean;
  isError: boolean;
  data: Pick<ApprovalScanResult, 'isComplete' | 'retryAfterAt'> | undefined;
  now?: number;
}): ApprovalScanStatus | null {
  if (isFetching) return 'Scanning';
  if (isError) return 'Failed';
  if (!data) return null;
  if (!data.isComplete && data.retryAfterAt !== null && data.retryAfterAt > now) {
    return 'Partial scan — provider limit';
  }
  return data.isComplete ? 'Window complete' : 'Partial scan';
}

export type SecurityAssessmentStatus =
  | 'Connect wallet'
  | 'Scan required'
  | 'Scanning'
  | 'Paused — provider limit'
  | 'Window assessed'
  | 'Assessment unavailable';

export interface SecurityAssessment {
  status: SecurityAssessmentStatus;
  description: string;
  canCalculateScore: boolean;
}

export function getSecurityAssessment({
  walletConnected,
  supportedNetwork,
  isScanning,
  providerRateLimited,
  approvalScanStarted,
  approvalWindowComplete,
  approvalHistoryStartsAtGenesis,
  approvalDataUnavailable,
  activityScanStarted,
  activityDataUnavailable,
  activityHasUnresolvedTransactions,
}: {
  walletConnected: boolean;
  supportedNetwork: boolean;
  isScanning: boolean;
  providerRateLimited: boolean;
  approvalScanStarted: boolean;
  approvalWindowComplete: boolean;
  approvalHistoryStartsAtGenesis: boolean;
  approvalDataUnavailable: boolean;
  activityScanStarted: boolean;
  activityDataUnavailable: boolean;
  activityHasUnresolvedTransactions: boolean;
}): SecurityAssessment {
  if (!walletConnected) {
    return {
      status: 'Connect wallet',
      description: 'Connect a wallet on Arc Testnet to assess configured-token approvals and recent activity.',
      canCalculateScore: false,
    };
  }
  if (!supportedNetwork) {
    return {
      status: 'Assessment unavailable',
      description: 'Security assessment data is available on Arc Testnet only.',
      canCalculateScore: false,
    };
  }
  if (providerRateLimited) {
    return {
      status: 'Paused — provider limit',
      description: 'The public RPC deferred approval-history ranges. Scanning can resume after its cooldown.',
      canCalculateScore: false,
    };
  }
  if (isScanning) {
    return {
      status: 'Scanning',
      description: 'Checking the selected approval window and recent activity sample.',
      canCalculateScore: false,
    };
  }
  if (approvalDataUnavailable || activityDataUnavailable || activityHasUnresolvedTransactions) {
    return {
      status: 'Assessment unavailable',
      description: 'Required approval or recent-activity data could not be validated. No numeric score is shown.',
      canCalculateScore: false,
    };
  }
  if (!approvalScanStarted || !activityScanStarted || !approvalWindowComplete) {
    return {
      status: 'Scan required',
      description: 'Complete the selected approval window and load a validated recent-activity sample.',
      canCalculateScore: false,
    };
  }
  if (!approvalHistoryStartsAtGenesis) {
    return {
      status: 'Window assessed',
      description: 'The selected approval window and recent activity sample are complete; older or unsupported approvals are not covered. No numeric score is shown.',
      canCalculateScore: false,
    };
  }
  return {
    status: 'Window assessed',
    description: 'The supported approval history begins at block 0 and recent activity checks are available. The score is not a security guarantee.',
    canCalculateScore: true,
  };
}

export function getApprovalCoveragePercent(coveredBlocks: bigint, totalBlocks: bigint): number {
  if (coveredBlocks <= 0n || totalBlocks <= 0n) return 0;
  const covered = coveredBlocks > totalBlocks ? totalBlocks : coveredBlocks;
  return Number(covered * 10_000n / totalBlocks) / 100;
}

export function summarizeApprovalInventory(
  approvals: readonly TokenApproval[] | undefined,
  isCoverageComplete: boolean,
): {
  observedSpenderRecords: number | null;
  activeAllowances: number | null;
  isCoverageComplete: boolean;
} {
  return {
    observedSpenderRecords: approvals?.length ?? null,
    activeAllowances: approvals && approvals.length > 0
      ? approvals.filter((approval) => approval.allowance > 0n).length
      : null,
    isCoverageComplete,
  };
}

export interface ApprovalProvider {
  scan(address: Address, historyWindowBlocks?: number): Promise<ApprovalScanResult>;
  getCooldownUntil(address: Address): number | null;
}

export function createApprovalProvider(client: PublicClient): ApprovalProvider {
  const throttle = getApprovalLogThrottleState(client);
  const runScan = async (
    address: Address,
    historyWindowBlocks: number,
  ): Promise<ApprovalScanResult> => {
      if (client.chain?.id !== ARC_TESTNET.id) {
        throw new Error('Approval scanning is only configured for Arc Testnet');
      }
      if (!APPROVAL_SCAN_HISTORY_WINDOWS.some((window) => window === historyWindowBlocks)) {
        throw new Error(`Unsupported approval scan history window: ${historyWindowBlocks}`);
      }

      const scanStartedAt = Date.now();
      const latestBlock = await client.getBlockNumber();
      const windowSize = BigInt(historyWindowBlocks);
      const fromBlock = latestBlock + 1n > windowSize ? latestBlock - windowSize + 1n : 0n;
      const approvals: TokenApproval[] = [];
      const errors: string[] = [];
      const tokenCoverage: ApprovalScanResult['tokenCoverage'] = [];
      let scannedFromBlock = fromBlock;
      let allRangesCovered = true;
      let coveredBlocks = 0n;
      let lastSuccessfulAt: number | null = null;
      let retryAfterAt: number | null = null;
      const scanRateLimitState = { detected: false };

      for (const token of APPROVAL_TOKENS) {
        const loadedCache = loadApprovalScanState(client, token, address, fromBlock);
        const scanCache = loadedCache.state;
        constrainApprovalScanState(scanCache, fromBlock, latestBlock);
        scanCache.nextScanBlock ??= fromBlock.toString();
        scanCache.failedRanges ??= [];
        if (scanCache.retryAfterAt !== undefined && scanCache.retryAfterAt <= Date.now()) {
          scanCache.retryAfterAt = undefined;
        }
        if (loadedCache.error) errors.push(`${token.symbol} ${loadedCache.error}`);
        let tokenFromBlock = BigInt(scanCache.fromBlock);
        if (tokenFromBlock > latestBlock) tokenFromBlock = fromBlock;
        if (tokenFromBlock < scannedFromBlock) scannedFromBlock = tokenFromBlock;
        const initialCacheError = saveApprovalScanState(client, token, address, scanCache);
        if (initialCacheError) errors.push(`${token.symbol} ${initialCacheError}`);

        let tokenVerified: boolean | null = null;
        try {
          tokenVerified = await isArcContractVerified(token.address);
        } catch (error) {
          errors.push(`${token.symbol} contract verification: ${errorMessage(error)}`);
        }

        const isRateLimited = scanRateLimitState.detected ||
          Math.max(scanCache.retryAfterAt ?? 0, throttle.pauseUntil) > Date.now();
        if (isRateLimited) {
          scanCache.retryAfterAt = Math.max(scanCache.retryAfterAt ?? 0, throttle.pauseUntil);
          retryAfterAt = Math.max(retryAfterAt ?? 0, scanCache.retryAfterAt);
          errors.push(scanRateLimitState.detected
            ? `${token.symbol} approval log scan paused by RPC rate limit after an earlier token exhausted retries; resume with a later refresh.`
            : `${token.symbol} approval log scan paused by RPC rate limit until ${new Date(scanCache.retryAfterAt).toISOString()}; refresh later to resume.`);
          allRangesCovered = false;
        }
        const uncoveredRanges = uncoveredApprovalRanges(scanCache, latestBlock);
        const ranges = isRateLimited ? [] : selectApprovalLogRanges(
          uncoveredRanges,
          BigInt(scanCache.nextScanBlock),
          MAX_APPROVAL_LOG_CHUNKS_PER_TOKEN_PER_SCAN,
          scanCache.failedRanges.map((range) => [
            BigInt(range.fromBlock),
            BigInt(range.toBlock),
          ]),
        );
        if (ranges.length < uncoveredRanges.length) allRangesCovered = false;
        let rateLimitStop = false;
        const requestBudget = {
          remaining: MAX_APPROVAL_LOG_REQUESTS_PER_TOKEN_PER_SCAN,
          scanRateLimitState,
        };
        const chunks = await mapWithConcurrency(
          ranges,
          MAX_CONCURRENT_APPROVAL_LOG_REQUESTS,
          async ([chunkFrom, chunkTo]) => {
            if (rateLimitStop) {
              return {
                logs: [],
                errors: [],
                successfulRanges: [],
                deferred: true,
                rateLimited: true,
              };
            }
            const result = await getApprovalLogs(client, token, address, chunkFrom, chunkTo, requestBudget);
            if (result.rateLimited) rateLimitStop = true;
            return result;
          },
        );
        const candidates = new Map<string, bigint>(
          Object.entries(scanCache.spenderBlocks).map(([spenderKey, blockNumber]) => [
            spenderKey,
            BigInt(blockNumber),
          ]),
        );
        let cacheErrorReported = initialCacheError !== undefined;
        let cacheCapacityReported = false;
        let requestBudgetReported = false;
        let lastProcessedRange: [bigint, bigint] | undefined;
        for (const [chunkIndex, chunk] of chunks.entries()) {
          if (
            ranges[chunkIndex] &&
            (!chunk.deferred || !chunk.rateLimited || chunk.retryAfterAt !== undefined)
          ) {
            lastProcessedRange = ranges[chunkIndex];
          }
          errors.push(...chunk.errors.map((scanError) => `${token.symbol} Approval events ${scanError}`));

          let chunkIsCacheable = true;
          for (const log of chunk.logs) {
            try {
              const event = decodeApprovalEvent(log);
              const key = event.spender.toLowerCase();
              const lastSeen = candidates.get(key);
              if (lastSeen === undefined || event.blockNumber > lastSeen) {
                candidates.set(key, event.blockNumber);
              }
              const cachedLastSeen = scanCache.spenderBlocks[key];
              if (cachedLastSeen === undefined && Object.keys(scanCache.spenderBlocks).length >= APPROVAL_SCAN_CACHE_MAX_SPENDERS) {
                chunkIsCacheable = false;
                if (!cacheCapacityReported) {
                  errors.push(`${token.symbol} approval scan cache reached its spender limit; coverage remains incomplete.`);
                  cacheCapacityReported = true;
                }
              } else if (cachedLastSeen === undefined || event.blockNumber > BigInt(cachedLastSeen)) {
                scanCache.spenderBlocks[key] = event.blockNumber.toString();
              }
            } catch (error) {
              errors.push(`${token.symbol} Approval event: ${errorMessage(error)}`);
              chunkIsCacheable = false;
            }
          }

          if (chunkIsCacheable) {
            for (const range of chunk.successfulRanges) {
              addCoveredRange(scanCache, range.fromBlock, range.toBlock);
            }
            if (chunk.successfulRanges.length > 0 && chunk.newlyScanned) {
              scanCache.lastSuccessfulAt = Date.now();
              const lastRange = chunk.successfulRanges[chunk.successfulRanges.length - 1];
              scanCache.lastSuccessfulRange = {
                fromBlock: lastRange.fromBlock.toString(),
                toBlock: lastRange.toBlock.toString(),
              };
              lastSuccessfulAt = Math.max(lastSuccessfulAt ?? 0, scanCache.lastSuccessfulAt);
              scanCache.retryAfterAt = undefined;
            }
          }
          if (chunk.deferred) {
            allRangesCovered = false;
            if (!requestBudgetReported && chunk.errors.length === 0 && !chunk.rateLimited) {
              errors.push(`${token.symbol} approval scan reached its bounded per-refresh RPC request budget; uncovered ranges are retained for the next refresh.`);
              requestBudgetReported = true;
            }
          }
          if (chunk.recommendedBlockRange !== undefined) {
            const previousRange = scanCache.maxBlockRange
              ? BigInt(scanCache.maxBlockRange)
              : APPROVAL_LOG_BLOCK_CHUNK;
            if (chunk.recommendedBlockRange < previousRange) {
              scanCache.maxBlockRange = chunk.recommendedBlockRange.toString();
            }
          }
          if (chunk.retryAfterAt !== undefined) {
            scanCache.retryAfterAt = Math.max(scanCache.retryAfterAt ?? 0, chunk.retryAfterAt);
            retryAfterAt = Math.max(retryAfterAt ?? 0, chunk.retryAfterAt);
            allRangesCovered = false;
          }
          const attemptedRange = ranges[chunkIndex];
          if (attemptedRange && !chunk.deferred && (chunk.errors.length > 0 || !chunkIsCacheable)) {
            const remainingFailedRanges: NonNullable<CachedApprovalScanState['failedRanges']> =
              scanCache.failedRanges.filter((range) =>
              BigInt(range.fromBlock) !== attemptedRange[0] ||
              BigInt(range.toBlock) !== attemptedRange[1],
            );
            scanCache.failedRanges = [
              ...remainingFailedRanges,
              { fromBlock: attemptedRange[0].toString(), toBlock: attemptedRange[1].toString() },
            ];
          }
          scanCache.failedRanges = scanCache.failedRanges.filter((range) =>
            !scanCache.coveredRanges.some((covered) =>
              BigInt(covered.fromBlock) <= BigInt(range.fromBlock) &&
              BigInt(covered.toBlock) >= BigInt(range.toBlock),
            ),
          );
          const stillUncoveredRanges = uncoveredApprovalRanges(scanCache, latestBlock);
          scanCache.failedRanges = scanCache.failedRanges.flatMap((failedRange) =>
            stillUncoveredRanges
              .filter(([rangeFrom, rangeTo]) =>
                rangeFrom <= BigInt(failedRange.toBlock) && rangeTo >= BigInt(failedRange.fromBlock),
              )
              .map(([rangeFrom, rangeTo]) => ({
                fromBlock: rangeFrom.toString(),
                toBlock: rangeTo.toString(),
              })),
          );
          if (!cacheErrorReported) {
            const cacheError = saveApprovalScanState(client, token, address, scanCache);
            if (cacheError) {
              errors.push(`${token.symbol} ${cacheError}`);
              cacheErrorReported = true;
            }
          }

          if (chunk.successfulRanges.length === 0 && ranges[chunkIndex]) allRangesCovered = false;
        }

        if (lastProcessedRange) {
          const lastAttemptedRange = lastProcessedRange;
          scanCache.nextScanBlock = lastAttemptedRange[1] >= latestBlock
            ? fromBlock.toString()
            : (lastAttemptedRange[1] + 1n).toString();
          if (!cacheErrorReported) {
            const cacheError = saveApprovalScanState(client, token, address, scanCache);
            if (cacheError) {
              errors.push(`${token.symbol} ${cacheError}`);
              cacheErrorReported = true;
            }
          }
        }
        if (!cacheErrorReported) {
          const cacheError = saveApprovalScanState(client, token, address, scanCache);
          if (cacheError) errors.push(`${token.symbol} ${cacheError}`);
        }

        for (const range of scanCache.coveredRanges) {
          const coveredFrom = BigInt(range.fromBlock) < fromBlock ? fromBlock : BigInt(range.fromBlock);
          const coveredTo = BigInt(range.toBlock) > latestBlock ? latestBlock : BigInt(range.toBlock);
          if (coveredTo >= coveredFrom) coveredBlocks += coveredTo - coveredFrom + 1n;
        }

        const coverage = scanCache.coveredRanges
          .map((range) => ({ fromBlock: BigInt(range.fromBlock), toBlock: BigInt(range.toBlock) }))
          .some((range) => range.fromBlock <= tokenFromBlock && range.toBlock >= latestBlock);
        if (!coverage) allRangesCovered = false;
        if (scanCache.lastSuccessfulAt !== undefined) {
          lastSuccessfulAt = Math.max(lastSuccessfulAt ?? 0, scanCache.lastSuccessfulAt);
        }
        tokenCoverage.push({
          symbol: token.symbol,
          coveredRanges: scanCache.coveredRanges.map((range) => ({
            fromBlock: BigInt(range.fromBlock),
            toBlock: BigInt(range.toBlock),
          })),
          failedRanges: scanCache.failedRanges.map((range) => ({
            fromBlock: BigInt(range.fromBlock),
            toBlock: BigInt(range.toBlock),
          })),
          remainingRanges: uncoveredApprovalRanges(scanCache, latestBlock).map(([rangeFrom, rangeTo]) => ({
            fromBlock: rangeFrom,
            toBlock: rangeTo,
          })),
          remainingRangeCount: countUncoveredApprovalRanges(scanCache, latestBlock),
          lastSuccessfulAt: scanCache.lastSuccessfulAt ?? null,
          lastSuccessfulRange: scanCache.lastSuccessfulRange
            ? {
                fromBlock: BigInt(scanCache.lastSuccessfulRange.fromBlock),
                toBlock: BigInt(scanCache.lastSuccessfulRange.toBlock),
              }
            : null,
        });

        if (candidates.size > MAX_SPENDERS_PER_TOKEN) {
          errors.push(`${token.symbol}: spender limit reached; the result is partial.`);
        }

        const selectedCandidates = [...candidates.entries()].slice(0, MAX_SPENDERS_PER_TOKEN);
        if (selectedCandidates.length === 0) continue;

        let actualTokenDecimals: number;
        try {
          const decimalsValue = await client.readContract({
            address: token.address,
            abi: erc20Abi,
            functionName: 'decimals',
            blockNumber: latestBlock,
          });
          if (
            typeof decimalsValue !== 'number' ||
            !Number.isInteger(decimalsValue) ||
            decimalsValue < 0 ||
            decimalsValue > 255
          ) {
            throw new Error(`Invalid on-chain decimals value: ${String(decimalsValue)}`);
          }
          actualTokenDecimals = decimalsValue;
          if (actualTokenDecimals !== token.decimals) {
            errors.push(
              `${token.symbol} configured decimals (${token.decimals}) do not match on-chain decimals (${actualTokenDecimals}); on-chain decimals are used.`,
            );
          }
        } catch (error) {
          errors.push(`${token.symbol} on-chain decimals: ${errorMessage(error)}`);
          allRangesCovered = false;
          continue;
        }
        const approvalToken = { ...token, decimals: actualTokenDecimals };

        let verificationLookups = 0;
        let verificationLimitReported = false;
        for (const [index, [spenderKey, lastSeenBlock]] of selectedCandidates.entries()) {
          if (index > 0) await delay(APPROVAL_LOG_REQUEST_GAP_MS);
          const spenderAddress = spenderKey as Address;
          try {
            const allowanceValue = await client.readContract({
              address: token.address,
              abi: erc20Abi,
              functionName: 'allowance',
              args: [address, spenderAddress],
              blockNumber: latestBlock,
            });
            if (typeof allowanceValue !== 'bigint' || allowanceValue < 0n) {
              throw new Error(`Invalid on-chain allowance value: ${String(allowanceValue)}`);
            }
            const allowance = allowanceValue;
            let spenderVerified: boolean | null = null;
            if (verificationLookups < MAX_CONTRACT_VERIFICATION_LOOKUPS_PER_TOKEN) {
              verificationLookups += 1;
              try {
                spenderVerified = await isArcContractVerified(spenderAddress);
              } catch (error) {
                errors.push(
                  `${token.symbol} spender verification for ${spenderAddress}: ${errorMessage(error)}`,
                );
              }
            } else if (!verificationLimitReported) {
              errors.push(`${token.symbol}: contract verification lookup limit reached; remaining spenders are unverified.`);
              verificationLimitReported = true;
            }
            const interpreted = interpretVerifiedAllowance(
              allowance,
              actualTokenDecimals,
              tokenVerified,
              spenderVerified,
            );
            approvals.push({
              id: `${token.address}:${spenderKey}`,
              token: approvalToken,
              spenderAddress,
              allowance,
              allowanceFormatted: formatUnits(allowance, actualTokenDecimals),
              ...interpreted,
              lastSeenBlock,
              allowanceCheckedBlock: latestBlock,
              allowanceCheckedAt: Date.now(),
              tokenVerified,
              spenderVerified,
            });
          } catch (error) {
            errors.push(`${token.symbol} allowance for ${spenderAddress}: ${errorMessage(error)}`);
          }
        }
      }

      return {
        approvals: approvals.sort((left, right) => {
          const riskOrder = { High: 0, Medium: 1, Low: 2, Unknown: 3 };
          return riskOrder[left.risk] - riskOrder[right.risk];
        }),
        walletAddress: address,
        chainId: ARC_TESTNET.id,
        scannedFromBlock,
        scannedToBlock: latestBlock,
        historyWindowBlocks: windowSize,
        scope: `Configured Arc Testnet ERC-20 tokens (${APPROVAL_TOKENS.map((token) => token.symbol).join(', ')}); recent approval events from block ${fromBlock.toString()} through ${latestBlock.toString()} (${windowSize.toString()}-block maximum history window).`,
        errors,
        isComplete: allRangesCovered && errors.length === 0,
        coveredBlocks,
        totalBlocks: (latestBlock - fromBlock + 1n) * BigInt(APPROVAL_TOKENS.length),
        tokenCoverage,
        lastSuccessfulAt,
        lastScanAttemptAt: Math.max(scanStartedAt, Date.now()),
        retryAfterAt,
      };
  };
  return {
    scan(address, historyWindowBlocks = DEFAULT_APPROVAL_SCAN_HISTORY_WINDOW) {
      const scanKey = `${ARC_TESTNET.id}:${address.toLowerCase()}:${historyWindowBlocks}`;
      const inFlight = approvalScansInFlight.get(scanKey);
      if (inFlight) return inFlight;
      const scan = runScan(address, historyWindowBlocks).finally(() => {
        if (approvalScansInFlight.get(scanKey) === scan) {
          approvalScansInFlight.delete(scanKey);
        }
      });
      approvalScansInFlight.set(scanKey, scan);
      return scan;
    },
    getCooldownUntil(address) {
      let retryAt = throttle.pauseUntil;
      for (const token of APPROVAL_TOKENS) {
        const cached = loadApprovalScanState(client, token, address, 0n);
        retryAt = Math.max(retryAt, cached.state.retryAfterAt ?? 0);
      }
      return retryAt > Date.now() ? retryAt : null;
    },
  };
}

export function isSameSecurityContext(
  left: { address?: Address; chainId?: number },
  right: { address?: Address; chainId?: number },
): boolean {
  return left.chainId === right.chainId &&
    left.address?.toLowerCase() === right.address?.toLowerCase();
}

export function countLargeOutgoingTransfers(transactions: ChainTransaction[], walletAddress: Address): number {
  const wallet = walletAddress.toLowerCase();
  const thresholdNative = parseUnits(LARGE_OUTGOING_USDC_THRESHOLD.toString(), 18);
  const thresholdToken = LARGE_OUTGOING_USDC_THRESHOLD * 10n ** BigInt(ARC_USDC.decimals);
  let count = 0;

  for (const transaction of transactions) {
    if (transaction.status !== 'success') continue;
    const nativeIsLarge = transaction.from.toLowerCase() === wallet &&
      transaction.nativeSymbol === 'USDC' &&
      parseUnits(transaction.value || '0', 18) >= thresholdNative;
    const tokenIsLarge = transaction.tokenTransfers.some((transfer) =>
      transfer.direction === 'sent' &&
      transfer.from?.toLowerCase() === wallet &&
      transfer.contractAddress.toLowerCase() === ARC_USDC.address.toLowerCase() &&
      BigInt(transfer.rawAmount || '0') >= thresholdToken,
    );
    if (nativeIsLarge || tokenIsLarge) count += 1;
  }

  return count;
}

export function calculateSecurityScore({
  approvals,
  transactions,
  walletAddress,
  isComplete,
}: {
  approvals: TokenApproval[];
  transactions: ChainTransaction[];
  walletAddress: Address;
  isComplete: boolean;
}): number | null {
  if (!isComplete) return null;

  const unlimitedCount = approvals.filter((approval) => approval.allowance > 0n && approval.isUnlimited).length;
  const highAllowanceCount = approvals.filter((approval) =>
    approval.allowance > 0n && !approval.isUnlimited && approval.risk === 'Medium',
  ).length;
  const failedTransactionCount = transactions.filter((transaction) => transaction.status === 'failed').length;
  const largeOutgoingCount = countLargeOutgoingTransfers(transactions, walletAddress);

  return Math.max(
    0,
    100
      - Math.min(60, unlimitedCount * 25)
      - Math.min(30, highAllowanceCount * 15)
      - Math.min(20, failedTransactionCount * 5)
      - Math.min(20, largeOutgoingCount * 10),
  );
}

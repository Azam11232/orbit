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
import { ARC_ERC20_ASSETS, ARC_USDC } from '../data/tokens';
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
  tokenVerified: boolean | null;
  spenderVerified: boolean | null;
}

export interface ApprovalScanResult {
  approvals: TokenApproval[];
  walletAddress: Address;
  chainId: number;
  scannedFromBlock: bigint;
  scannedToBlock: bigint;
  scope: string;
  errors: string[];
  isComplete: boolean;
  lastScannedAt: number;
}

export function summarizeApprovalScanErrors(errors: string[]): string[] {
  const grouped = new Map<string, { count: number; example: string }>();
  const otherErrors = [...new Set(errors)];
  const groupedPatterns = [
    {
      pattern: /^(.+?) Approval events blocks [\d-]+: (.*)$/i,
      label: (token: string, detail: string) =>
        `${token} approval log ranges ${/rate.?limit|too many requests|\b429\b/i.test(detail) ? 'rate-limited' : 'failed'}`,
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

export const APPROVAL_TOKENS: ApprovalTokenConfig[] = ARC_ERC20_ASSETS.map((asset) => ({
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

const approvalEvent = parseAbiItem(
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
);
const APPROVAL_SCAN_BLOCK_WINDOW = 1_000_000n;
const APPROVAL_LOG_BLOCK_CHUNK = 10_000n;
const APPROVAL_LOG_REQUEST_GAP_MS = 300;
const MAX_CONCURRENT_APPROVAL_LOG_REQUESTS = 2;
const MAX_APPROVAL_LOG_RETRIES = 2;
const APPROVAL_LOG_RETRY_BASE_MS = 500;
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
let activeApprovalLogRequests = 0;
let nextApprovalLogRequestAt = 0;
const approvalLogRequestWaiters: Array<() => void> = [];

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
      /requested range too large|(?:block )?range.{0,40}(?:too large|exceed|maximum|limit)/i.test(message)
    ) {
      return true;
    }
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
    };
    const message = [rpcError.shortMessage, rpcError.message]
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
    if (
      rpcError.code === 429 ||
      rpcError.status === 429 ||
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

async function acquireApprovalLogRequestSlot(): Promise<() => void> {
  if (activeApprovalLogRequests >= MAX_CONCURRENT_APPROVAL_LOG_REQUESTS) {
    await new Promise<void>((resolve) => approvalLogRequestWaiters.push(resolve));
  } else {
    activeApprovalLogRequests += 1;
  }

  const scheduledAt = Math.max(Date.now(), nextApprovalLogRequestAt);
  nextApprovalLogRequestAt = scheduledAt + APPROVAL_LOG_REQUEST_GAP_MS;
  while (Date.now() < scheduledAt) await delay(scheduledAt - Date.now());

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = approvalLogRequestWaiters.shift();
    if (next) next();
    else activeApprovalLogRequests -= 1;
  };
}

async function fetchApprovalLogs(
  client: PublicClient,
  token: ApprovalTokenConfig,
  owner: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<ApprovalLog[]> {
  let attempt = 0;
  while (true) {
    const release = await acquireApprovalLogRequestSlot();
    let requestError: unknown;
    try {
      return await client.getLogs({
        address: token.address,
        event: approvalEvent,
        args: { owner },
        fromBlock,
        toBlock,
      });
    } catch (error) {
      requestError = error;
    } finally {
      release();
    }

    if (!isRateLimitError(requestError) || attempt >= MAX_APPROVAL_LOG_RETRIES) {
      throw requestError;
    }
    const backoff = APPROVAL_LOG_RETRY_BASE_MS * 2 ** attempt;
    const jitteredBackoff = backoff * (0.5 + Math.random());
    await delay(retryAfterMs(requestError) ?? jitteredBackoff);
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
  return value.coveredRanges.every((range) =>
    typeof range === 'object' && range !== null &&
    'fromBlock' in range && typeof range.fromBlock === 'string' && /^\d+$/.test(range.fromBlock) &&
    'toBlock' in range && typeof range.toBlock === 'string' && /^\d+$/.test(range.toBlock) &&
    BigInt(range.fromBlock) <= BigInt(range.toBlock),
  ) && Object.entries(value.spenderBlocks).every(([spender, block]) =>
    /^0x[0-9a-f]{40}$/i.test(spender) && typeof block === 'string' && /^\d+$/.test(block),
  );
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
  for (const [rangeFrom, rangeTo] of ranges) {
    for (let chunkFrom = rangeFrom; chunkFrom <= rangeTo; chunkFrom += APPROVAL_LOG_BLOCK_CHUNK) {
      const chunkTo = chunkFrom + APPROVAL_LOG_BLOCK_CHUNK - 1n > rangeTo
        ? rangeTo
        : chunkFrom + APPROVAL_LOG_BLOCK_CHUNK - 1n;
      chunks.push([chunkFrom, chunkTo]);
    }
  }
  return chunks;
}

async function getApprovalLogs(
  client: PublicClient,
  token: ApprovalTokenConfig,
  owner: Address,
  fromBlock: bigint,
  toBlock: bigint,
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
    return { logs: cachedLogs, errors: [], successfulRanges: [{ fromBlock, toBlock }] };
  }
  const queryFromBlock = cacheIsValid ? cached.coveredToBlock + 1n : fromBlock;
  if (cached) clientCache.delete(cacheKey);

  try {
    const newLogs = await fetchApprovalLogs(client, token, owner, queryFromBlock, toBlock);
    const logs = [...cachedLogs, ...newLogs];
    cacheApprovalLogs(clientCache, cacheKey, toBlock, logs);
    return { logs, errors: [], successfulRanges: [{ fromBlock, toBlock }] };
  } catch (error) {
    if (fromBlock < toBlock && isUnsupportedLogRange(error)) {
      const midpoint = fromBlock + (toBlock - fromBlock) / 2n;
      const [firstHalf, secondHalf] = await Promise.all([
        getApprovalLogs(client, token, owner, fromBlock, midpoint),
        getApprovalLogs(client, token, owner, midpoint + 1n, toBlock),
      ]);
      return {
        logs: [...firstHalf.logs, ...secondHalf.logs],
        errors: [...firstHalf.errors, ...secondHalf.errors],
        successfulRanges: [...firstHalf.successfulRanges, ...secondHalf.successfulRanges],
      };
    }

    return {
      logs: cachedLogs,
      errors: [`blocks ${queryFromBlock.toString()}-${toBlock.toString()}: ${errorMessage(error)}`],
      successfulRanges: cacheIsValid && cached.coveredToBlock >= fromBlock
        ? [{ fromBlock, toBlock: cached.coveredToBlock }]
        : [],
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

export interface ApprovalProvider {
  scan(address: Address): Promise<ApprovalScanResult>;
}

export function createApprovalProvider(client: PublicClient): ApprovalProvider {
  return {
    async scan(address) {
      if (client.chain?.id !== ARC_TESTNET.id) {
        throw new Error('Approval scanning is only configured for Arc Testnet');
      }

      const scanStartedAt = Date.now();
      const latestBlock = await client.getBlockNumber();
      const minimumFromBlock = latestBlock > APPROVAL_SCAN_BLOCK_WINDOW
        ? latestBlock - APPROVAL_SCAN_BLOCK_WINDOW
        : 0n;
      const fromBlock = minimumFromBlock === 0n
        ? 0n
        : ((minimumFromBlock + APPROVAL_LOG_BLOCK_CHUNK - 1n) / APPROVAL_LOG_BLOCK_CHUNK) *
          APPROVAL_LOG_BLOCK_CHUNK;
      const approvals: TokenApproval[] = [];
      const errors: string[] = [];
      let scannedFromBlock = fromBlock;
      let allRangesCovered = true;

      for (const token of APPROVAL_TOKENS) {
        const loadedCache = loadApprovalScanState(client, token, address, fromBlock);
        const scanCache = loadedCache.state;
        if (loadedCache.error) errors.push(`${token.symbol} ${loadedCache.error}`);
        let tokenFromBlock = BigInt(scanCache.fromBlock);
        if (tokenFromBlock > latestBlock) {
          errors.push(`${token.symbol} approval scan cache is ahead of the RPC block height; a fresh scan is required.`);
          tokenFromBlock = fromBlock;
          scanCache.fromBlock = fromBlock.toString();
          scanCache.coveredRanges = [];
          scanCache.spenderBlocks = {};
        }
        if (tokenFromBlock < scannedFromBlock) scannedFromBlock = tokenFromBlock;
        const initialCacheError = saveApprovalScanState(client, token, address, scanCache);
        if (initialCacheError) errors.push(`${token.symbol} ${initialCacheError}`);

        let tokenVerified: boolean | null = null;
        try {
          tokenVerified = await isArcContractVerified(token.address);
        } catch (error) {
          errors.push(`${token.symbol} contract verification: ${errorMessage(error)}`);
        }

        const ranges = uncoveredApprovalRanges(scanCache, latestBlock);
        const chunks = await mapWithConcurrency(
          ranges,
          MAX_CONCURRENT_APPROVAL_LOG_REQUESTS,
          ([chunkFrom, chunkTo]) => getApprovalLogs(client, token, address, chunkFrom, chunkTo),
        );
        const candidates = new Map<string, bigint>(
          Object.entries(scanCache.spenderBlocks).map(([spenderKey, blockNumber]) => [
            spenderKey,
            BigInt(blockNumber),
          ]),
        );
        let cacheErrorReported = initialCacheError !== undefined;
        let cacheCapacityReported = false;
        for (const [chunkIndex, chunk] of chunks.entries()) {
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
          }
          if (!cacheErrorReported) {
            const cacheError = saveApprovalScanState(client, token, address, scanCache);
            if (cacheError) {
              errors.push(`${token.symbol} ${cacheError}`);
              cacheErrorReported = true;
            }
          }

          if (chunk.successfulRanges.length === 0 && ranges[chunkIndex]) allRangesCovered = false;
        }

        const coverage = scanCache.coveredRanges
          .map((range) => ({ fromBlock: BigInt(range.fromBlock), toBlock: BigInt(range.toBlock) }))
          .some((range) => range.fromBlock <= tokenFromBlock && range.toBlock >= latestBlock);
        if (!coverage) allRangesCovered = false;

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
        scope: `Configured Arc Testnet ERC-20 tokens (${APPROVAL_TOKENS.length}); Approval events from block ${scannedFromBlock.toString()} through ${latestBlock.toString()}. This is a bounded recent-history scan, not a complete lifetime approval inventory.`,
        errors,
        isComplete: scannedFromBlock === 0n && allRangesCovered && errors.length === 0,
        lastScannedAt: Math.max(scanStartedAt, Date.now()),
      };
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

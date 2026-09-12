import type { Address } from 'viem';
import { AAVE_BASE_POOL } from './lending/aave';

export type TxCategory =
  | 'Send'
  | 'Receive'
  | 'Swap'
  | 'Approval'
  | 'Contract Interaction'
  | 'Bridge'
  | 'Lending'
  | 'Unknown';

export type TxStatus = 'success' | 'failed' | 'pending' | 'unknown';

export interface TokenTransfer {
  hash: string;
  symbol: string;
  contractAddress: string;
  amount: string;
  decimals: number;
  direction: 'sent' | 'received';
  rawAmount: string;
}

export interface ChainTransaction {
  hash: string;
  from: string;
  to: string;
  value: string;
  timestamp: number | null;
  status: TxStatus;
  category: TxCategory;
  blockNumber: number | null;
  gasUsed?: string;
  gasPrice?: string;
  feeEth?: string;
  input?: string;
  contractAddress?: string | null;
  tokenTransfers: TokenTransfer[];
}

export interface TransactionQuery {
  address: Address;
  chainId: number;
  limit?: number;
}

export interface TransactionProvider {
  fetchTransactions(query: TransactionQuery): Promise<ChainTransaction[]>;
}

const TX_REQUEST_GAP_MS = 1200;
const ERC20_TRANSFER_SELECTOR = '0xa9059cbb';
const ERC20_APPROVE_SELECTOR = '0x095ea7b3';
const SWAP_SELECTORS = new Set([
  '0x38ed1739',
  '0x7ff36ab5',
  '0x12aa3caf',
  '0x18cbafe5',
  '0x8803dbee',
  '0x4a2f3ef7',
  '0x2f04f85b',
  '0x0b3d2d6b',
  '0x6a2e8ef4',
  '0x7a2d7d5d',
]);

const AAVE_LENDING_SELECTOR = new Set([
  '0x0d6ed9b2',
  '0x3eb1972a',
  '0xa6c3a0db',
  '0x7854cd0f',
  '0x6f9b8d07',
]);

const txRequestCache = new Map<string, Promise<ChainTransaction[]>>();
let lastTransactionRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAddress(value: string): string {
  return (value || '').toLowerCase();
}

function getAddressValue(value: unknown): string {
  if (!value) return '0x';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value && 'hash' in value && typeof (value as { hash?: string }).hash === 'string') {
    return (value as { hash: string }).hash;
  }
  return '0x';
}

function isBlockscoutRateLimitError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? '');
  return /deprecated|free api access|rate limit|notok|429|timeout/i.test(text);
}

async function throttleTransactionRequests(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastTransactionRequestAt;
  if (elapsed < TX_REQUEST_GAP_MS) {
    await sleep(TX_REQUEST_GAP_MS - elapsed);
  }
  lastTransactionRequestAt = Date.now();
}

async function fetchJson<T>(url: string): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
        },
      });

      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`Request was rate-limited or temporarily unavailable (${response.status})`);
        if (attempt < 2) {
          await sleep(750 * (attempt + 1));
          continue;
        }
        throw lastError;
      }

      if (!response.ok) {
        const raw = await response.text().catch(() => '');
        lastError = new Error(`Request failed (${response.status}): ${raw.slice(0, 200)}`);
        if (attempt < 2) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        throw lastError;
      }

      return (await response.json()) as T;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < 2 && isBlockscoutRateLimitError(lastError)) {
        await sleep(750 * (attempt + 1));
        continue;
      }
      throw lastError;
    }
  }

  throw lastError ?? new Error('Request failed');
}

function classifySwap(input: string): boolean {
  if (!input || input === '0x') return false;
  const selector = input.slice(0, 10).toLowerCase();
  return SWAP_SELECTORS.has(selector);
}

function classifyLending(input: string, to: string): boolean {
  if (!input || input === '0x') return false;
  const selector = input.slice(0, 10).toLowerCase();
  return normalizeAddress(to) === normalizeAddress(AAVE_BASE_POOL) || AAVE_LENDING_SELECTOR.has(selector);
}

function normalizeTxStatus(statusValue?: string | number | null, fallbackValue?: string | number | null): TxStatus {
  const raw = String(statusValue ?? fallbackValue ?? '').trim().toLowerCase();
  if (!raw) return 'unknown';
  if (raw === 'success' || raw === '1' || raw === 'ok' || raw === 'confirmed') return 'success';
  if (raw === 'failed' || raw === 'reverted' || raw === 'error' || raw === '0' || raw === 'false') return 'failed';
  if (raw === 'pending' || raw === 'submitted' || raw === 'inprogress' || raw === 'queued') return 'pending';
  return 'unknown';
}

function categorize(
  from: string,
  to: string,
  value: string,
  input: string,
  walletAddress: string,
  isContract: boolean,
  tokenTransfers: TokenTransfer[],
): TxCategory {
  const wallet = walletAddress.toLowerCase();
  const normalizedInput = input || '0x';
  const selector = normalizedInput.slice(0, 10).toLowerCase();

  if (selector === ERC20_APPROVE_SELECTOR) return 'Approval';
  if (classifyLending(normalizedInput, to)) return 'Lending';
  if (classifySwap(normalizedInput)) return 'Swap';

  if (tokenTransfers.length > 0) {
    const sentMatch = tokenTransfers.some(
      (transfer) => transfer.direction === 'sent' && normalizeAddress(from) === wallet,
    );
    if (sentMatch) return 'Send';
    const receivedMatch = tokenTransfers.some(
      (transfer) => transfer.direction === 'received' && normalizeAddress(to) === wallet,
    );
    if (receivedMatch) return 'Receive';
  }

  const val = BigInt(value || '0');
  if (val > 0n && normalizeAddress(from) === wallet) return 'Send';
  if (val > 0n && normalizeAddress(to) === wallet) return 'Receive';
  if (selector === ERC20_TRANSFER_SELECTOR) return 'Unknown';
  if (isContract || (normalizedInput && normalizedInput !== '0x')) return 'Contract Interaction';
  return 'Unknown';
}

export function normalizeTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const absolute = Math.abs(value);
    if (absolute >= 1_000_000_000_000) return value;
    if (absolute >= 1_000_000_000) return value * 1000;
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    if (/^[-+]?\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric)) return null;
      const absolute = Math.abs(numeric);
      if (absolute >= 1_000_000_000_000) return numeric;
      if (absolute >= 1_000_000_000) return numeric * 1000;
      return null;
    }

    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function timeAgo(timestamp: number): string {
  const validTimestamp = normalizeTimestamp(timestamp);
  if (validTimestamp === null) return 'Time unavailable';

  const diff = Date.now() - validTimestamp;
  const seconds = Math.max(0, Math.floor(diff / 1000));
  const mins = Math.floor(seconds / 60);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days > 1 ? 's' : ''} ago`;
  return new Date(validTimestamp).toLocaleDateString();
}

interface BasescanTx {
  hash: string;
  from: string;
  to: string;
  value: string;
  timeStamp: string;
  isError: string;
  input: string;
  blockNumber: string;
  contractAddress: string;
  gasUsed: string;
  gasPrice: string;
}

interface BasescanTokenTransfer {
  blockNumber: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  contractAddress: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimal: string;
}

interface BlockscoutAddressRef {
  hash?: string;
  [key: string]: unknown;
}

interface BlockscoutTxItem {
  hash?: string;
  value?: string | number;
  timestamp?: string;
  raw_input?: string;
  input?: string;
  block_number?: number | string;
  blockNumber?: number | string;
  from?: BlockscoutAddressRef | string;
  to?: BlockscoutAddressRef | string;
  gas_price?: string;
  gasUsed?: string;
  gas_used?: string;
  status?: string | number | null;
  result?: string | null;
  token_transfers?: unknown[];
}

function normalizeBlockNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric;
}

function normalizeBlockscoutTokenTransfer(raw: any, walletAddress: string, transactionHashOverride?: string): TokenTransfer | null {
  if (!raw) return null;

  const transactionHash = String(transactionHashOverride ?? raw.transaction_hash ?? raw.hash ?? '');
  if (!transactionHash) return null;

  const token = raw.token ?? {};
  const fromValue = getAddressValue(raw.from);
  const amountRaw = String(raw.amount ?? raw.value ?? raw.total ?? '0');
  const decimals = Number(token.decimals ?? raw.decimals ?? 0);
  const amount = decimals > 0 ? (BigInt(amountRaw || '0') / 10n ** BigInt(decimals)).toString() : amountRaw || '0';
  const contractAddress = String(token.address ?? raw.contract_address ?? '0x0000000000000000000000000000000000000000');

  return {
    hash: transactionHash,
    symbol: String(token.symbol ?? token.name ?? raw.token_symbol ?? raw.symbol ?? 'UNKNOWN'),
    contractAddress,
    amount,
    decimals,
    direction: normalizeAddress(fromValue) === normalizeAddress(walletAddress) ? 'sent' : 'received',
    rawAmount: amountRaw || '0',
  };
}

function normalizeBaseScanTransfer(raw: BasescanTokenTransfer, walletAddress: string): TokenTransfer {
  const decimals = Number(raw.tokenDecimal || 0);
  const amountRaw = raw.value || '0';
  const amount = decimals > 0 ? (BigInt(amountRaw) / 10n ** BigInt(decimals)).toString() : amountRaw;
  const direction = normalizeAddress(raw.from) === normalizeAddress(walletAddress) ? 'sent' : 'received';

  return {
    hash: raw.hash || '',
    symbol: raw.tokenSymbol || 'UNKNOWN',
    contractAddress: raw.contractAddress || '0x0000000000000000000000000000000000000000',
    amount,
    decimals,
    direction,
    rawAmount: amountRaw,
  };
}

async function fetchTokenTransfers(address: string, limit: number): Promise<TokenTransfer[]> {
  const params = new URLSearchParams({
    module: 'account',
    action: 'tokentx',
    address,
    page: '1',
    offset: String(Math.max(limit, 50)),
    sort: 'desc',
  });

  const response = await fetch(`https://api.basescan.org/api?${params.toString()}`);
  if (!response.ok) return [];
  const json = await response.json();
  if (json.status === '0') return [];

  const rows = (json.result as BasescanTokenTransfer[]) ?? [];
  return rows.map((row) => normalizeBaseScanTransfer(row, address));
}

function normalizeBlockscoutTx(raw: BlockscoutTxItem, walletAddress: string, tokenTransfers: TokenTransfer[]): ChainTransaction {
  const hash = raw.hash || '';
  const from = getAddressValue(raw.from);
  const to = getAddressValue(raw.to);
  const txValue = String(raw.value ?? '0');
  const input = String(raw.raw_input ?? raw.input ?? '0x');
  const timestampValue = normalizeTimestamp(raw.timestamp);
  const gasPrice = String(raw.gas_price ?? '0');
  const gasUsed = String(raw.gas_used ?? raw.gasUsed ?? '0');
  const feeWei = BigInt(gasPrice || '0') * BigInt(gasUsed || '0');
  const status = normalizeTxStatus(raw.status ?? raw.result, undefined);
  const isContract = Boolean(raw.to && typeof raw.to === 'object' && 'is_contract' in raw.to && raw.to.is_contract === true);
  const blockNumber = normalizeBlockNumber(raw.block_number ?? raw.blockNumber);

  return {
    hash,
    from,
    to: to || '0x',
    value: (Number(BigInt(txValue || '0')) / 1e18).toFixed(6),
    timestamp: timestampValue,
    status,
    category: categorize(from, to, txValue, input, walletAddress, isContract, tokenTransfers),
    blockNumber,
    gasUsed: gasUsed || undefined,
    gasPrice: gasPrice || undefined,
    feeEth: feeWei > 0n ? (Number(feeWei) / 1e18).toFixed(6) : undefined,
    input,
    contractAddress: to && to !== '0x' && typeof raw.to === 'object' && raw.to && 'is_contract' in raw.to && raw.to.is_contract === true ? to : null,
    tokenTransfers,
  };
}

async function fetchBlockscoutTransactions(address: string, limit: number): Promise<ChainTransaction[]> {
  const txUrl = `https://base.blockscout.com/api/v2/addresses/${address}/transactions?items_count=${Math.max(limit, 20)}`;
  const json = await fetchJson<{ items?: BlockscoutTxItem[] }>(txUrl);
  const transactions = Array.isArray(json.items) ? json.items : [];

  const transferMap = new Map<string, TokenTransfer[]>();
  for (const tx of transactions) {
    const txHash = String(tx.hash || '').toLowerCase();
    const nestedTransfers = Array.isArray(tx.token_transfers)
      ? tx.token_transfers
          .map((transfer) => normalizeBlockscoutTokenTransfer(transfer, address, tx.hash))
          .filter((transfer): transfer is TokenTransfer => Boolean(transfer))
      : [];

    if (nestedTransfers.length > 0) {
      transferMap.set(txHash, nestedTransfers);
    }
  }

  return transactions.map((tx) => {
    const txHash = String(tx.hash || '').toLowerCase();
    const txTransfers = transferMap.get(txHash) ?? [];
    return normalizeBlockscoutTx(tx, address, txTransfers);
  });
}

async function fetchBasescanTransactions(address: string, limit: number): Promise<ChainTransaction[]> {
  const params = new URLSearchParams({
    module: 'account',
    action: 'txlist',
    address,
    startblock: '0',
    endblock: '99999999',
    page: '1',
    offset: String(Math.max(limit, 20)),
    sort: 'desc',
  });

  const txListUrl = `https://api.basescan.org/api?${params.toString()}`;
  const txJson = await fetchJson<{ status?: string; message?: string; result?: BasescanTx[] }>(txListUrl);
  if (txJson.status === '0') {
    const message = String(txJson.message ?? 'Basescan API returned an error');
    if (message.toLowerCase().includes('deprecated') || message.toLowerCase().includes('free api access') || message.toLowerCase().includes('rate limit') || message.toLowerCase().includes('notok')) {
      throw new Error(message);
    }
    return [];
  }

  const rows = Array.isArray(txJson.result) ? txJson.result : [];
  const tokenTransferResponse = await fetchTokenTransfers(address, limit);
  const transferMap = new Map<string, TokenTransfer[]>();
  for (const transfer of tokenTransferResponse) {
    const key = transfer.hash.toLowerCase();
    const bucket = transferMap.get(key) ?? [];
    bucket.push(transfer);
    transferMap.set(key, bucket);
  }

  return rows
    .map((tx) => {
      const checksumHash = tx.hash.toLowerCase();
      const tokenTransfers = transferMap.get(checksumHash) ?? [];
      const isContract = Boolean(tx.contractAddress && tx.contractAddress !== '0x');
      const category = categorize(tx.from, tx.to, tx.value, tx.input, address, isContract, tokenTransfers);
      const gasPrice = BigInt(tx.gasPrice || '0');
      const gasUsed = BigInt(tx.gasUsed || '0');
      const feeWei = gasPrice * gasUsed;
      const blockNumber = normalizeBlockNumber(tx.blockNumber);
      const ts = normalizeTimestamp(tx.timeStamp);

      return {
        hash: tx.hash,
        from: tx.from,
        to: tx.to || tx.contractAddress,
        value: (Number(BigInt(tx.value || '0')) / 1e18).toFixed(6),
        timestamp: ts,
        status: normalizeTxStatus(tx.isError === '1' ? 'failed' : String(tx.isError ?? ''), tx.isError),
        category,
        blockNumber,
        gasUsed: tx.gasUsed || undefined,
        gasPrice: tx.gasPrice || undefined,
        feeEth: feeWei > 0n ? (Number(feeWei) / 1e18).toFixed(6) : undefined,
        input: tx.input || '0x',
        contractAddress: tx.contractAddress || null,
        tokenTransfers,
      };
    })
    .sort((left, right) => {
      const leftTime = left.timestamp ?? 0;
      const rightTime = right.timestamp ?? 0;
      return rightTime - leftTime;
    });
}

export function createBasescanProvider(): TransactionProvider {
  return {
    async fetchTransactions(query: TransactionQuery): Promise<ChainTransaction[]> {
      const { address, limit = 20 } = query;
      const cacheKey = `${address.toLowerCase()}:${limit}`;

      const cached = txRequestCache.get(cacheKey);
      if (cached) return cached;

      const request = (async (): Promise<ChainTransaction[]> => {
        await throttleTransactionRequests();

        try {
          return await fetchBasescanTransactions(address, limit);
        } catch (basescanError) {
          return await fetchBlockscoutTransactions(address, limit);
        }
      })();

      txRequestCache.set(cacheKey, request);

      try {
        return await request;
      } finally {
        txRequestCache.delete(cacheKey);
      }
    },
  };
}

export function getTimeAgo(timestamp: number | null | undefined): string {
  const normalized = normalizeTimestamp(timestamp);
  if (normalized === null) return 'Time unavailable';
  return timeAgo(normalized);
}

export function formatTransactionDate(timestamp: number | null | undefined): string {
  const normalized = normalizeTimestamp(timestamp);
  if (normalized === null) return 'Time unavailable';
  return new Date(normalized).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function getPreferredExplorerBaseUrl(): string {
  if (typeof window === 'undefined') return 'https://basescan.org';

  try {
    const stored = window.localStorage.getItem('orbit-settings-v1');
    if (!stored) return 'https://basescan.org';

    const parsed = JSON.parse(stored) as { explorer?: 'basescan' | 'blockscout' };
    if (parsed.explorer === 'blockscout') {
      return 'https://base.blockscout.com';
    }
  } catch {
    // Ignore malformed local storage and fall back to BaseScan.
  }

  return 'https://basescan.org';
}

export function explorerTxUrl(hash: string): string {
  return `${getPreferredExplorerBaseUrl()}/tx/${hash}`;
}

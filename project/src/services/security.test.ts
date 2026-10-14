import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  maxUint256,
  parseAbiItem,
  parseUnits,
  type Address,
  type Chain,
  type Hex,
} from 'viem';
import { ARC_TESTNET } from '../data/networks';
import { APPROVAL_TOKENS, calculateSecurityScore, canRevokeApproval, decodeApprovalEvent, interpretAllowance, interpretVerifiedAllowance, isArcContractVerified, isSameSecurityContext, summarizeApprovalScanErrors, type TokenApproval } from './security';
import type { ChainTransaction } from './transactions';

const wallet = '0x1111111111111111111111111111111111111111' as Address;
const spender = '0x2222222222222222222222222222222222222222' as Address;
const approvalEvent = parseAbiItem('event Approval(address indexed owner, address indexed spender, uint256 value)');
const approvalLog = {
  address: APPROVAL_TOKENS[0].address,
  topics: [
    '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
    `0x${wallet.slice(2).padStart(64, '0')}`,
    `0x${spender.slice(2).padStart(64, '0')}`,
  ] as Hex[],
  data: `0x${'0'.repeat(63)}1`,
  blockNumber: '0x5',
  transactionHash: `0x${'a'.repeat(64)}`,
  transactionIndex: '0x0',
  blockHash: `0x${'b'.repeat(64)}`,
  logIndex: '0x0',
  removed: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('approval event decoding and allowance interpretation', () => {
  it('decodes indexed owner/spender and value from a raw Approval log', () => {
    const value = 1_000_000n;
    const topics = encodeEventTopics({
      abi: [approvalEvent],
      eventName: 'Approval',
      args: { owner: wallet, spender },
    }).filter((topic): topic is `0x${string}` => typeof topic === 'string');
    const decoded = decodeApprovalEvent({
      topics,
      data: encodeAbiParameters([{ type: 'uint256' }], [value]),
      blockNumber: 45n,
    });

    expect(decoded).toEqual({ owner: wallet, spender, value, blockNumber: 45n });
  });

  it('distinguishes unlimited, high, limited, and zero allowances', () => {
    expect(interpretAllowance(maxUint256, 6)).toMatchObject({
      isUnlimited: true,
      isRevoked: false,
      risk: 'High',
      status: 'Unlimited allowance active',
    });
    expect(interpretAllowance(parseUnits('1000000', 6), 6)).toMatchObject({
      isUnlimited: false,
      isRevoked: false,
      risk: 'Medium',
      status: 'High allowance active',
    });
    expect(interpretAllowance(1n, 6)).toMatchObject({
      isUnlimited: false,
      isRevoked: false,
      risk: 'Low',
      status: 'Limited allowance active',
    });
    expect(interpretAllowance(0n, 6)).toMatchObject({
      isUnlimited: false,
      isRevoked: true,
      status: 'Revoked or zero allowance',
    });
    expect(interpretVerifiedAllowance(1n, 6, true, null)).toMatchObject({
      risk: 'Unknown',
      status: expect.stringContaining('Verification unavailable'),
    });
    expect(interpretVerifiedAllowance(1n, 6, true, false)).toMatchObject({
      risk: 'Unknown',
      status: expect.stringContaining('Verification incomplete'),
    });
    expect(interpretVerifiedAllowance(1n, 6, true, true)).toMatchObject({
      risk: 'Low',
      status: 'Limited allowance active',
    });
    expect(interpretVerifiedAllowance(maxUint256, 6, true, null)).toMatchObject({
      risk: 'Unknown',
      isUnlimited: true,
    });
  });
});

describe('security score and scan failure states', () => {
  const approval: TokenApproval = {
    id: 'token:spender',
    token: APPROVAL_TOKENS[0],
    spenderAddress: spender,
    allowance: maxUint256,
    allowanceFormatted: 'unlimited',
    isUnlimited: true,
    risk: 'High',
    status: 'Unlimited allowance active',
    lastSeenBlock: 10n,
    tokenVerified: true,
    spenderVerified: false,
  };

  const transaction: ChainTransaction = {
    hash: `0x${'a'.repeat(64)}`,
    from: wallet,
    to: spender,
    value: '100',
    timestamp: 1_700_000_000_000,
    status: 'failed',
    category: 'Send',
    blockNumber: 10,
    tokenTransfers: [],
    nativeSymbol: 'USDC',
  };

  it('returns Unknown when checks are incomplete, and applies documented deductions when complete', () => {
    const successfulLargeTransfer = { ...transaction, hash: `0x${'b'.repeat(64)}`, status: 'success' as const };
    expect(calculateSecurityScore({
      approvals: [approval],
      transactions: [transaction, successfulLargeTransfer],
      walletAddress: wallet,
      isComplete: false,
    })).toBeNull();

    expect(calculateSecurityScore({
      approvals: [approval],
      transactions: [transaction, successfulLargeTransfer],
      walletAddress: wallet,
      isComplete: true,
    })).toBe(60);
  });

  it('reports contract-verification request failures as incomplete', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'ArcScan unavailable' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    )));
    const client = createPublicClient({
      chain: ARC_TESTNET as Chain,
      transport: custom({
        request: async ({ method }) => {
          if (method === 'eth_blockNumber') return '0x1';
          if (method === 'eth_getLogs') return [];
          throw new Error(`Unexpected RPC method: ${method}`);
        },
      }, { retryCount: 0 }),
    });

    const { createApprovalProvider } = await import('./security');
    const result = await createApprovalProvider(client).scan(wallet);

    expect(result.isComplete).toBe(false);
    expect(result.errors.some((error) =>
      error.startsWith('USDC contract verification: ArcScan contract verification request failed (503)'),
    )).toBe(true);
  });

  it('preserves partial results and marks the approval scan incomplete on RPC log errors', async () => {
    let logRequests = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ is_contract: true, is_verified: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const client = createPublicClient({
      chain: ARC_TESTNET as Chain,
      transport: custom({
        request: async ({ method }) => {
          if (method === 'eth_blockNumber') return '0x1';
          if (method === 'eth_getLogs') {
            logRequests += 1;
            throw new Error('rate limit exceeded');
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        },
      }, { retryCount: 0 }),
    });

    const { createApprovalProvider } = await import('./security');
    const result = await createApprovalProvider(client).scan(wallet);

    expect(result.isComplete).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('rate limit exceeded');
    expect(logRequests).toBe(3);
  });

  it('splits RPC log ranges that the node rejects as too large', async () => {
    let logRequests = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ is_contract: true, is_verified: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const client = createPublicClient({
      chain: ARC_TESTNET as Chain,
      transport: custom({
        request: async ({ method }) => {
          if (method === 'eth_blockNumber') return '0x1';
          if (method === 'eth_getLogs') {
            logRequests += 1;
            if (logRequests === 1) {
              throw Object.assign(new Error('requested range too large'), { code: -32012 });
            }
            return [];
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        },
      }, { retryCount: 0 }),
    });

    const { createApprovalProvider } = await import('./security');
    const result = await createApprovalProvider(client).scan(wallet);

    expect(result.errors).toEqual([]);
    expect(logRequests).toBe(3);
    expect(result.isComplete).toBe(true);
    expect(result.approvals).toEqual([]);
  });

  it('keeps approvals found before a later log chunk fails', async () => {
    let logRequests = 0;
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ is_contract: true, is_verified: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const client = createPublicClient({
      chain: ARC_TESTNET as Chain,
      transport: custom({
        request: async ({ method, params }) => {
          if (method === 'eth_blockNumber') return '0x2711';
          if (method === 'eth_getLogs') {
            logRequests += 1;
            if (logRequests === 1) return [approvalLog];
            throw new Error('rate limited');
          }
          if (method === 'eth_call') {
            const call = params?.[0] as { data?: string };
            return call.data?.startsWith('0x313ce567')
              ? `0x${'0'.repeat(63)}6`
              : `0x${'0'.repeat(63)}1`;
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        },
      }, { retryCount: 0 }),
    });

    const { createApprovalProvider } = await import('./security');
    const result = await createApprovalProvider(client).scan(wallet);

    expect(result.approvals).toHaveLength(1);
    expect(result.approvals[0]).toMatchObject({
      spenderAddress: spender,
      tokenVerified: true,
      spenderVerified: true,
    });
    expect(result.isComplete).toBe(false);
    expect(result.errors.some((error) => error.includes('rate limited'))).toBe(true);
  });

  it('uses on-chain token decimals and rejects malformed allowance values', async () => {
    const owner = wallet;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ is_contract: true, is_verified: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    let allowanceResponse = `0x${'0'.repeat(63)}1`;
    const client = createPublicClient({
      chain: ARC_TESTNET as Chain,
      transport: custom({
        request: async ({ method, params }) => {
          if (method === 'eth_blockNumber') return '0x5';
          if (method === 'eth_getLogs') return [approvalLog];
          if (method === 'eth_call') {
            const call = params?.[0] as { data?: string };
            return call.data?.startsWith('0x313ce567')
              ? `0x${'0'.repeat(62)}12`
              : allowanceResponse;
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        },
      }, { retryCount: 0 }),
    });

    const { createApprovalProvider } = await import('./security');
    const provider = createApprovalProvider(client);
    const decoded = await provider.scan(owner);
    expect(decoded.approvals).toHaveLength(1);
    expect(decoded.approvals[0].token.decimals).toBe(18);
    expect(decoded.approvals[0].allowanceFormatted).toBe('0.000000000000000001');
    expect(decoded.errors.some((error) => error.includes('configured decimals (6) do not match on-chain decimals (18)'))).toBe(true);
    expect(decoded.isComplete).toBe(false);

    allowanceResponse = '0x';
    const malformed = await provider.scan(owner);
    expect(malformed.approvals).toEqual([]);
    expect(malformed.errors.some((error) => error.includes('allowance for'))).toBe(true);
    expect(malformed.isComplete).toBe(false);
  });

  it('rejects an unavailable block source rather than returning a success-shaped empty scan', async () => {
    const client = createPublicClient({
      chain: ARC_TESTNET as Chain,
      transport: custom({
        request: async () => {
          throw new Error('RPC unavailable');
        },
      }, { retryCount: 0 }),
    });

    const { createApprovalProvider } = await import('./security');
    await expect(createApprovalProvider(client).scan(wallet)).rejects.toThrow('RPC unavailable');
  });

  it('accepts only explicit ArcScan contract verification metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ is_contract: true, is_verified: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    expect(await isArcContractVerified('0x3333333333333333333333333333333333333333')).toBe(true);
  });

  it('allows revocation only for a supported token and explicitly verified nonzero spender', () => {
    expect(canRevokeApproval(approval)).toBe(false);
    expect(canRevokeApproval({
      ...approval,
      tokenVerified: true,
      spenderVerified: true,
    })).toBe(true);
    expect(canRevokeApproval({
      ...approval,
      allowance: 0n,
      tokenVerified: true,
      spenderVerified: true,
    })).toBe(false);
    expect(canRevokeApproval({
      ...approval,
      token: { ...approval.token, address: '0x3333333333333333333333333333333333333333' },
      tokenVerified: true,
      spenderVerified: true,
    })).toBe(false);
  });

  it('treats account and chain changes as a different security context', () => {
    expect(isSameSecurityContext(
      { address: wallet, chainId: ARC_TESTNET.id },
      { address: wallet.toUpperCase().replace('0X', '0x') as Address, chainId: ARC_TESTNET.id },
    )).toBe(true);
    expect(isSameSecurityContext(
      { address: wallet, chainId: ARC_TESTNET.id },
      { address: spender, chainId: ARC_TESTNET.id },
    )).toBe(false);
    expect(isSameSecurityContext(
      { address: wallet, chainId: ARC_TESTNET.id },
      { address: wallet, chainId: ARC_TESTNET.id + 1 },
    )).toBe(false);
  });
});

describe('ArcScan contract verification responses', () => {
  it('requests contract metadata through the local proxy and accepts the supported schema', async () => {
    const address = '0x7777777777777777777777777777777777777777' as Address;
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ is_contract: true, is_verified: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(isArcContractVerified(address)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/arcscan/addresses/${address}/contract-info`,
      { headers: { Accept: 'application/json' } },
    );
  });

  it('reports HTTP 400 response details instead of hiding the proxy error', async () => {
    const address = '0x4444444444444444444444444444444444444444' as Address;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ message: 'invalid ArcScan request' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(isArcContractVerified(address)).rejects.toThrow(
      'ArcScan contract verification request failed (400): {"message":"invalid ArcScan request"}',
    );
  });

  it('rejects malformed contract metadata', async () => {
    const address = '0x5555555555555555555555555555555555555555' as Address;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ is_contract: 'yes', is_verified: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(isArcContractVerified(address)).rejects.toThrow(
      'ArcScan returned invalid contract verification metadata',
    );
  });

  it('reports upstream rate limits and preserves their response body', async () => {
    const address = '0x6666666666666666666666666666666666666666' as Address;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ message: 'rate limit exceeded' }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '2' } },
    )));

    await expect(isArcContractVerified(address)).rejects.toThrow(
      'ArcScan contract verification request failed (429): {"message":"rate limit exceeded"}',
    );
  });
});

describe('approval log request controls', () => {
  it('persists successful ranges and fetches only new blocks after a client is recreated', async () => {
    const owner = '0x9999999999999999999999999999999999999999' as Address;
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ is_contract: true, is_verified: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    let latestBlock = 5;
    const requestedRanges: Array<{ address?: Address; fromBlock?: string; toBlock?: string }> = [];
    const createClient = () => createPublicClient({
      chain: ARC_TESTNET as Chain,
      cacheTime: 0,
      transport: custom({
        request: async ({ method, params }) => {
          if (method === 'eth_blockNumber') return `0x${latestBlock.toString(16)}`;
          if (method === 'eth_getLogs') {
            const range = params?.[0] as { address?: Address; fromBlock?: string; toBlock?: string };
            requestedRanges.push({
              address: range.address,
              fromBlock: range.fromBlock,
              toBlock: range.toBlock,
            });
            return [];
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        },
      }, { retryCount: 0 }),
    });

    await (await import('./security')).createApprovalProvider(createClient()).scan(owner);
    latestBlock = 6;
    const second = await (await import('./security')).createApprovalProvider(createClient()).scan(owner);

    expect(second.isComplete).toBe(true);
    expect(requestedRanges).toEqual([
      ...APPROVAL_TOKENS.map((token) => ({
        address: token.address,
        fromBlock: '0x0',
        toBlock: '0x5',
      })),
      ...APPROVAL_TOKENS.map((token) => ({
        address: token.address,
        fromBlock: '0x6',
        toBlock: '0x6',
      })),
    ]);
  });

  it('reuses cached successful log prefixes when the snapshot advances', async () => {
    const owner = '0x7777777777777777777777777777777777777777' as Address;
    let logRequests = 0;
    let latestBlock = 22;
    const requestedRanges: Array<{ fromBlock?: string; toBlock?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ is_contract: true, is_verified: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const client = createPublicClient({
      chain: ARC_TESTNET as Chain,
      cacheTime: 0,
      transport: custom({
        request: async ({ method, params }) => {
          if (method === 'eth_blockNumber') return `0x${latestBlock.toString(16)}`;
          if (method === 'eth_getLogs') {
            logRequests += 1;
            requestedRanges.push(params?.[0] as { fromBlock?: string; toBlock?: string });
            return [];
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        },
      }, { retryCount: 0 }),
    });
    const provider = (await import('./security')).createApprovalProvider(client);

    const first = await provider.scan(owner);
    latestBlock = 23;
    const second = await provider.scan(owner);

    expect(first.scannedToBlock).toBe(22n);
    expect(second.scannedToBlock).toBe(23n);
    expect(first.isComplete).toBe(true);
    expect(second.isComplete).toBe(true);
    expect(logRequests).toBe(2);
    expect(requestedRanges.map(({ fromBlock, toBlock }) => ({ fromBlock, toBlock }))).toEqual([
      { fromBlock: '0x0', toBlock: '0x16' },
      { fromBlock: '0x17', toBlock: '0x17' },
    ]);
  });

  describe('approval scan error summaries', () => {
    it('groups repeated RPC failures while preserving distinct technical details elsewhere', () => {
      expect(summarizeApprovalScanErrors([
        'USDC Approval events blocks 0-9999: rate limit exceeded',
        'USDC Approval events blocks 10000-19999: rate limit exceeded',
        'USDC contract verification: ArcScan unavailable',
      ])).toEqual([
        'USDC approval log ranges rate-limited: 2 failed (example: rate limit exceeded)',
        'USDC contract verification: ArcScan unavailable',
      ]);
    });
  });

  it('honors Retry-After while keeping RPC retries finite', async () => {
    const owner = '0x8888888888888888888888888888888888888888' as Address;
    let logRequests = 0;
    const requestTimes: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ is_contract: true, is_verified: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const client = createPublicClient({
      chain: ARC_TESTNET as Chain,
      transport: custom({
        request: async ({ method }) => {
          if (method === 'eth_blockNumber') return '0x1';
          if (method === 'eth_getLogs') {
            logRequests += 1;
            requestTimes.push(Date.now());
            if (logRequests === 1) {
              throw Object.assign(new Error('rate limit exceeded'), {
                code: 429,
                response: { headers: new Headers({ 'Retry-After': '0.05' }) },
              });
            }
            return [];
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        },
      }, { retryCount: 0 }),
    });

    const result = await (await import('./security')).createApprovalProvider(client).scan(owner);

    expect(logRequests).toBe(2);
    expect(requestTimes[1] - requestTimes[0]).toBeGreaterThanOrEqual(250);
    expect(requestTimes[1] - requestTimes[0]).toBeLessThan(700);
    expect(result.errors).toEqual([]);
    expect(result.isComplete).toBe(true);
  });

  it('keeps log request concurrency bounded', async () => {
    const owner = '0x9999999999999999999999999999999999999999' as Address;
    let activeRequests = 0;
    let maxActiveRequests = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ is_contract: true, is_verified: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const client = createPublicClient({
      chain: ARC_TESTNET as Chain,
      transport: custom({
        request: async ({ method }) => {
          if (method === 'eth_blockNumber') return '0xc351';
          if (method === 'eth_getLogs') {
            activeRequests += 1;
            maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
            await new Promise((resolve) => setTimeout(resolve, 300));
            activeRequests -= 1;
            return [];
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        },
      }, { retryCount: 0 }),
    });

    const result = await (await import('./security')).createApprovalProvider(client).scan(owner);

    expect(result.isComplete).toBe(true);
    expect(maxActiveRequests).toBe(2);
  });
});

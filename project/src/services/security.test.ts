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
import { APPROVAL_SCAN_HISTORY_WINDOWS, APPROVAL_TOKENS, calculateSecurityScore, canRevokeApproval, decodeApprovalEvent, getApprovalCoveragePercent, getApprovalScanStatus, getPreferredApprovalScanHistoryWindow, getRevokeConfirmationStatus, getSecurityAssessment, interpretAllowance, interpretVerifiedAllowance, isArcContractVerified, isSameSecurityContext, selectApprovalLogRanges, summarizeApprovalInventory, summarizeApprovalScanErrors, type TokenApproval } from './security';
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
  it('requires a successful receipt and two zero allowance reads before confirming revoke', () => {
    const base = {
      expectedWallet: wallet,
      receiptWallet: wallet,
      receiptStatus: 'success' as const,
      allowanceAtReceipt: 0n,
      refreshedAllowance: 0n,
    };
    expect(getRevokeConfirmationStatus(base)).toBe('success');
    expect(getRevokeConfirmationStatus({ ...base, receiptStatus: 'reverted' })).toBe('error');
    expect(getRevokeConfirmationStatus({ ...base, receiptStatus: null })).toBe('confirmation-pending');
    expect(getRevokeConfirmationStatus({ ...base, receiptWallet: spender })).toBe('error');
    expect(getRevokeConfirmationStatus({ ...base, refreshedAllowance: undefined })).toBe('verification-pending');
    expect(getRevokeConfirmationStatus({ ...base, allowanceAtReceipt: 1n })).toBe('error');
    expect(getRevokeConfirmationStatus({ ...base, refreshedAllowance: 1n })).toBe('error');
  });

  it('scans both deployed Arc Testnet tokens supported by the app', () => {
    expect(APPROVAL_TOKENS.map((token) => token.symbol)).toEqual(['USDC', 'EURC']);
    expect(APPROVAL_TOKENS.every((token) => token.decimals === 6)).toBe(true);
  });

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
    allowanceCheckedBlock: 12n,
    allowanceCheckedAt: 1_700_000_100_000,
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

  it('withholds the score until checks are complete, then applies documented deductions', () => {
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

  it('distinguishes assessment states without treating a completed recent window as lifetime coverage', () => {
    const completeWindow = {
      walletConnected: true,
      supportedNetwork: true,
      isScanning: false,
      providerRateLimited: false,
      approvalScanStarted: true,
      approvalWindowComplete: true,
      approvalHistoryStartsAtGenesis: false,
      approvalDataUnavailable: false,
      activityScanStarted: true,
      activityDataUnavailable: false,
      activityHasUnresolvedTransactions: false,
    };

    expect(getSecurityAssessment({ ...completeWindow, walletConnected: false }).status).toBe('Connect wallet');
    expect(getSecurityAssessment({ ...completeWindow, supportedNetwork: false }).status).toBe('Assessment unavailable');
    expect(getSecurityAssessment({ ...completeWindow, approvalScanStarted: false }).status).toBe('Scan required');
    expect(getSecurityAssessment({ ...completeWindow, isScanning: true }).status).toBe('Scanning');
    const paused = getSecurityAssessment({ ...completeWindow, providerRateLimited: true });
    expect(paused.status).toBe('Paused — provider limit');
    expect(paused.canCalculateScore).toBe(false);
    expect(getSecurityAssessment({ ...completeWindow, approvalWindowComplete: false }).status).toBe('Scan required');
    expect(getSecurityAssessment({ ...completeWindow, activityScanStarted: false }).status).toBe('Scan required');
    const approvalUnavailable = getSecurityAssessment({ ...completeWindow, approvalDataUnavailable: true });
    const activityUnavailable = getSecurityAssessment({ ...completeWindow, activityDataUnavailable: true });
    const activityUnresolved = getSecurityAssessment({ ...completeWindow, activityHasUnresolvedTransactions: true });
    expect(approvalUnavailable.status).toBe('Assessment unavailable');
    expect(activityUnavailable.status).toBe('Assessment unavailable');
    expect(activityUnresolved.status).toBe('Assessment unavailable');
    expect(approvalUnavailable.canCalculateScore).toBe(false);
    expect(activityUnavailable.canCalculateScore).toBe(false);
    expect(activityUnresolved.canCalculateScore).toBe(false);

    const assessedWindow = getSecurityAssessment(completeWindow);
    expect(assessedWindow.status).toBe('Window assessed');
    expect(assessedWindow.canCalculateScore).toBe(false);
    expect(assessedWindow.description).toContain('older or unsupported approvals are not covered');
  });

  it('allows the documented score only after supported history and activity checks validate', () => {
    const assessment = getSecurityAssessment({
      walletConnected: true,
      supportedNetwork: true,
      isScanning: false,
      providerRateLimited: false,
      approvalScanStarted: true,
      approvalWindowComplete: true,
      approvalHistoryStartsAtGenesis: true,
      approvalDataUnavailable: false,
      activityScanStarted: true,
      activityDataUnavailable: false,
      activityHasUnresolvedTransactions: false,
    });
    expect(assessment).toMatchObject({
      status: 'Window assessed',
      canCalculateScore: true,
    });
  });

  it('reports actual coverage and only shows a zero allowance count for checked records', () => {
    expect(getApprovalCoveragePercent(1_191n, 10_000n)).toBe(11.91);
    expect(getApprovalCoveragePercent(20n, 10n)).toBe(100);

    const summary = summarizeApprovalInventory(
      Array.from({ length: 4 }, (_, index) => ({
        ...approval,
        id: `token:spender:${index}`,
        allowance: 0n,
        isUnlimited: false,
      })),
      false,
    );
    expect(summary).toEqual({
      observedSpenderRecords: 4,
      activeAllowances: 0,
      isCoverageComplete: false,
    });
    expect(summarizeApprovalInventory([], false).activeAllowances).toBeNull();
  });

  it('uses scan labels only for genuine assessment states', () => {
    expect(getApprovalScanStatus({ isFetching: true, isError: false, data: undefined })).toBe('Scanning');
    expect(getApprovalScanStatus({ isFetching: false, isError: true, data: undefined })).toBe('Failed');
    expect(getApprovalScanStatus({
      isFetching: false,
      isError: true,
      data: { isComplete: true, retryAfterAt: null },
    })).toBe('Failed');
    expect(getApprovalScanStatus({
      isFetching: false,
      isError: false,
      data: { isComplete: false, retryAfterAt: 2_000 },
      now: 1_000,
    })).toBe('Partial scan — provider limit');
    expect(getApprovalScanStatus({
      isFetching: false,
      isError: false,
      data: { isComplete: false, retryAfterAt: null },
      now: 1_000,
    })).toBe('Partial scan');
    expect(getApprovalScanStatus({
      isFetching: false,
      isError: false,
      data: { isComplete: true, retryAfterAt: null },
    })).toBe('Window complete');
  });

  it('offers only bounded recent approval-history windows', () => {
    expect(APPROVAL_SCAN_HISTORY_WINDOWS).toEqual([50_000, 100_000, 250_000]);
    expect(APPROVAL_SCAN_HISTORY_WINDOWS.every((blocks) => blocks <= 250_000)).toBe(true);
  });

  it('loads a supported saved history-window preference and rejects unknown values', () => {
    let saved = '250000';
    vi.stubGlobal('localStorage', {
      getItem: () => saved,
    });
    expect(getPreferredApprovalScanHistoryWindow()).toBe(250_000);

    saved = '1000000';
    expect(getPreferredApprovalScanHistoryWindow()).toBe(50_000);
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
            throw new Error('RPC unavailable');
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        },
      }, { retryCount: 0 }),
    });

    const { createApprovalProvider } = await import('./security');
    const result = await createApprovalProvider(client).scan(wallet);

    expect(result.isComplete).toBe(false);
    expect(result.errors).toHaveLength(APPROVAL_TOKENS.length);
    expect(result.errors[0]).toContain('RPC unavailable');
    expect(logRequests).toBe(APPROVAL_TOKENS.length);
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
    expect(logRequests).toBe(4);
    expect(result.isComplete).toBe(true);
    expect(result.approvals).toEqual([]);
  });

  it('retries transient internal RPC errors with bounded backoff', async () => {
    const owner = '0x1212121212121212121212121212121212121212' as Address;
    const requestedRanges: Array<{ token: Address; fromBlock: string; toBlock: string }> = [];
    let usdcAttempts = 0;
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ is_contract: true, is_verified: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const client = createPublicClient({
      chain: ARC_TESTNET as Chain,
      transport: custom({
        request: async ({ method, params }) => {
          if (method === 'eth_blockNumber') return '0x0';
          if (method === 'eth_getLogs') {
            const filter = params?.[0] as { address: Address; fromBlock: string; toBlock: string };
            requestedRanges.push({
              token: filter.address,
              fromBlock: filter.fromBlock,
              toBlock: filter.toBlock,
            });
            if (filter.address === APPROVAL_TOKENS[0].address && usdcAttempts++ < 2) {
              throw Object.assign(new Error('Internal error'), { code: -32603 });
            }
            return [];
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        },
      }, { retryCount: 0 }),
    });

    const result = await (await import('./security')).createApprovalProvider(client).scan(owner);

    expect(requestedRanges).toEqual([
      ...Array.from({ length: 3 }, () => ({
        token: APPROVAL_TOKENS[0].address,
        fromBlock: '0x0',
        toBlock: '0x0',
      })),
      { token: APPROVAL_TOKENS[1].address, fromBlock: '0x0', toBlock: '0x0' },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.coveredBlocks).toBe(2n);
    expect(result.isComplete).toBe(true);
  });

  it('leaves ranges incomplete after bounded retries of persistent internal RPC errors', async () => {
    const owner = '0x1313131313131313131313131313131313131313' as Address;
    let usdcAttempts = 0;
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ is_contract: true, is_verified: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const client = createPublicClient({
      chain: ARC_TESTNET as Chain,
      transport: custom({
        request: async ({ method, params }) => {
          if (method === 'eth_blockNumber') return '0x0';
          if (method === 'eth_getLogs') {
            const filter = params?.[0] as { address: Address };
            if (filter.address === APPROVAL_TOKENS[0].address) {
              usdcAttempts += 1;
              throw Object.assign(new Error('Internal error'), { code: -32603 });
            }
            return [];
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        },
      }, { retryCount: 0 }),
    });

    const result = await (await import('./security')).createApprovalProvider(client).scan(owner);

    expect(usdcAttempts).toBe(3);
    expect(result.isComplete).toBe(false);
    expect(result.coveredBlocks).toBe(1n);
    expect(result.tokenCoverage[0]).toMatchObject({
      coveredRanges: [],
      remainingRanges: [{ fromBlock: 0n, toBlock: 0n }],
      failedRanges: [{ fromBlock: 0n, toBlock: 0n }],
    });
    expect(result.errors.some((error) => /Internal error/.test(error))).toBe(true);
  });

  it('does not split pruned-history errors as oversized ranges', async () => {
    const owner = '0x1414141414141414141414141414141414141414' as Address;
    let logRequests = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ is_contract: true, is_verified: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const client = createPublicClient({
      chain: ARC_TESTNET as Chain,
      transport: custom({
        request: async ({ method, params }) => {
          if (method === 'eth_blockNumber') return '0x0';
          if (method === 'eth_getLogs') {
            logRequests += 1;
            const filter = params?.[0] as { address: Address };
            if (filter.address === APPROVAL_TOKENS[0].address) {
              throw Object.assign(new Error('pruned history unavailable'), { code: 4444 });
            }
            return [];
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        },
      }, { retryCount: 0 }),
    });

    const result = await (await import('./security')).createApprovalProvider(client).scan(owner);

    expect(logRequests).toBe(2);
    expect(result.isComplete).toBe(false);
    expect(result.coveredBlocks).toBe(1n);
    expect(result.tokenCoverage[0].remainingRanges).toEqual([{ fromBlock: 0n, toBlock: 0n }]);
    expect(result.errors.some((error) => error.includes('pruned history unavailable'))).toBe(true);
  });

  it('scans only the selected recent history window and reports its exact block boundary', async () => {
    const owner = '0x1515151515151515151515151515151515151515' as Address;
    const requested: Array<{ token: Address; from: bigint; to: bigint }> = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ is_contract: true, is_verified: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const client = createPublicClient({
      chain: ARC_TESTNET as Chain,
      transport: custom({
        request: async ({ method, params }) => {
          if (method === 'eth_blockNumber') return '0x493e1';
          if (method === 'eth_getLogs') {
            const filter = params?.[0] as { address: Address; fromBlock: string; toBlock: string };
            requested.push({
              token: filter.address,
              from: BigInt(filter.fromBlock),
              to: BigInt(filter.toBlock),
            });
            return [];
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        },
      }, { retryCount: 0 }),
    });

    const result = await (await import('./security')).createApprovalProvider(client).scan(owner, 50_000);

    expect(result).toMatchObject({
      scannedFromBlock: 250_002n,
      scannedToBlock: 300_001n,
      historyWindowBlocks: 50_000n,
      totalBlocks: 100_000n,
      coveredBlocks: 100_000n,
      isComplete: true,
    });
    expect(result.scope).toContain('from block 250002 through 300001');
    expect(requested).toHaveLength(10);
    expect(requested.every((range) => range.from >= 250_002n && range.to <= 300_001n)).toBe(true);
    expect(requested[0]).toMatchObject({ from: 250_002n, to: 260_001n });
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
            throw new Error('node unavailable');
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
      allowanceCheckedBlock: 10_001n,
    });
    expect(result.approvals[0].allowanceCheckedAt).toBeGreaterThan(0);
    expect(result.isComplete).toBe(false);
    expect(result.errors.some((error) => error.includes('node unavailable'))).toBe(true);
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
    expect(decoded.approvals).toHaveLength(APPROVAL_TOKENS.length);
    expect(decoded.approvals[0].token.decimals).toBe(18);
    expect(decoded.approvals[0].allowanceFormatted).toBe('0.000000000000000001');
    expect(decoded.errors.filter((error) => error.includes('configured decimals (6) do not match on-chain decimals (18)'))).toHaveLength(APPROVAL_TOKENS.length);
    expect(decoded.isComplete).toBe(false);

    allowanceResponse = '0x';
    const malformed = await provider.scan(owner);
    expect(malformed.approvals).toEqual([]);
    expect(malformed.errors.filter((error) => error.includes('allowance for'))).toHaveLength(APPROVAL_TOKENS.length);
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
    expect(second.tokenCoverage.every((coverage) => coverage.lastSuccessfulRange?.fromBlock === 6n && coverage.lastSuccessfulRange.toBlock === 6n)).toBe(true);
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
    expect(logRequests).toBe(2 * APPROVAL_TOKENS.length);
    expect(requestedRanges.map(({ fromBlock, toBlock }) => ({ fromBlock, toBlock }))).toEqual([
      ...APPROVAL_TOKENS.map(() => ({ fromBlock: '0x0', toBlock: '0x16' })),
      ...APPROVAL_TOKENS.map(() => ({ fromBlock: '0x17', toBlock: '0x17' })),
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

    it('distinguishes RPC failure categories instead of labeling every failed range alike', () => {
      expect(summarizeApprovalScanErrors([
        'USDC Approval events blocks 0-9999: requested range too large',
        'EURC Approval events blocks 20000-29999: Request exceeds defined limit',
        'EURC Approval events blocks 10000-19999: requested data not available',
        'USDC Approval events blocks 20000-29999: request timed out',
        'USDC Approval events blocks 30000-39999: pruned history unavailable',
      ])).toEqual([
        'USDC approval log ranges range-limit rejected: 1 failed: requested range too large',
        'EURC approval log ranges range-limit rejected: 1 failed: Request exceeds defined limit',
        'EURC approval log ranges block data unavailable: 1 failed: requested data not available',
        'USDC approval log ranges timed out: 1 failed: request timed out',
        'USDC approval log ranges block data unavailable: 1 failed: pruned history unavailable',
      ]);
    });
  });

  it('honors Retry-After and defers rate-limited requests until cooldown expiry', async () => {
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
                response: { status: 429, headers: new Headers({ 'Retry-After': '0.6' }) },
              });
            }
            return [];
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        },
      }, { retryCount: 0 }),
    });

    const result = await (await import('./security')).createApprovalProvider(client).scan(owner);

    expect(logRequests).toBe(1);
    expect(requestTimes).toHaveLength(1);
    expect(result.retryAfterAt).toBeGreaterThan(Date.now() + 4_000);
    expect(result.errors.some((error) => /rate limit/i.test(error))).toBe(true);
    expect(result.isComplete).toBe(false);
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
          if (method === 'eth_blockNumber') return '0x1';
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
    expect(maxActiveRequests).toBe(1);
  });

  it('rotates bounded range batches so failed ranges are retried without starving later history', () => {
    const ranges: Array<[bigint, bigint]> = [[0n, 9n], [10n, 19n], [20n, 29n]];

    expect(selectApprovalLogRanges(ranges, 0n, 2)).toEqual([[0n, 9n], [10n, 19n]]);
    expect(selectApprovalLogRanges(ranges, 20n, 2, [[0n, 9n]])).toEqual([[0n, 9n], [20n, 29n]]);
    expect(selectApprovalLogRanges(ranges, 30n, 2)).toEqual([[0n, 9n], [10n, 19n]]);
    expect(selectApprovalLogRanges([[0n, 9n]], 0n, 3, [[2n, 4n]])).toEqual([
      [2n, 4n],
      [0n, 1n],
      [5n, 9n],
    ]);
  });

  it('retries only the failed token range while retaining other successful coverage', async () => {
    let latestBlock = 1;
    let shouldFailUsdc = true;
    const requestedTokens: Address[] = [];
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
            const request = params?.[0] as { address: Address };
            requestedTokens.push(request.address);
            if (request.address === APPROVAL_TOKENS[0].address && shouldFailUsdc) {
              shouldFailUsdc = false;
              throw new Error('temporary node failure');
            }
            return [];
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        },
      }, { retryCount: 0 }),
    });
    const provider = (await import('./security')).createApprovalProvider(client);

    const first = await provider.scan(wallet);
    latestBlock = 2;
    const second = await provider.scan(wallet);

    expect(first.isComplete).toBe(false);
    expect(first.errors.some((error) => error.includes('temporary node failure'))).toBe(true);
    expect(first.coveredBlocks).toBe(2n);
    expect(first.tokenCoverage[0]).toMatchObject({
      symbol: 'USDC',
      failedRanges: [{ fromBlock: 0n, toBlock: 1n }],
      remainingRanges: [{ fromBlock: 0n, toBlock: 1n }],
    });
    expect(first.tokenCoverage[1]).toMatchObject({
      symbol: 'EURC',
      coveredRanges: [{ fromBlock: 0n, toBlock: 1n }],
      remainingRanges: [],
    });
    expect(second.isComplete).toBe(true);
    expect(second.coveredBlocks).toBe(6n);
    expect(second.tokenCoverage.every((coverage) => coverage.failedRanges.length === 0 && coverage.remainingRanges.length === 0)).toBe(true);
    expect(requestedTokens).toEqual([
      APPROVAL_TOKENS[0].address,
      APPROVAL_TOKENS[1].address,
      APPROVAL_TOKENS[0].address,
      APPROVAL_TOKENS[0].address,
      APPROVAL_TOKENS[1].address,
    ]);
  });

  it('recursively splits oversized historical log ranges and counts only successful blocks', async () => {
    const owner = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
    const requests: Array<{ token: Address; fromBlock: bigint; toBlock: bigint }> = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ is_contract: true, is_verified: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const client = createPublicClient({
      chain: ARC_TESTNET as Chain,
      transport: custom({
        request: async ({ method, params }) => {
          if (method === 'eth_blockNumber') return '0x9';
          if (method === 'eth_getLogs') {
            const filter = params?.[0] as { address: Address; fromBlock: string; toBlock: string };
            const fromBlock = BigInt(filter.fromBlock);
            const toBlock = BigInt(filter.toBlock);
            requests.push({ token: filter.address, fromBlock, toBlock });
            if (toBlock - fromBlock + 1n > 2n) {
              throw new Error('Request exceeds defined limit');
            }
            return [];
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        },
      }, { retryCount: 0 }),
    });

    const result = await (await import('./security')).createApprovalProvider(client).scan(owner);

    expect(result.isComplete).toBe(true);
    expect(result.coveredBlocks).toBe(20n);
    expect(result.totalBlocks).toBe(20n);
    expect(result.tokenCoverage.every((coverage) => coverage.remainingRanges.length === 0)).toBe(true);
    expect(requests.some(({ fromBlock, toBlock }) => toBlock - fromBlock + 1n > 2n)).toBe(true);
    expect(requests.filter(({ toBlock, fromBlock }) => toBlock - fromBlock + 1n <= 2n)).toHaveLength(12);
  }, 20_000);

  it('resumes persisted partial coverage with failed ranges prioritized after a client reload', async () => {
    const owner = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
    const storage = new Map<string, string>();
    const requestedRanges: Array<{ token: Address; fromBlock: string; toBlock: string }> = [];
    let failFirstUsdcRange = true;
    let latestBlock = 9;
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ is_contract: true, is_verified: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const createClient = () => createPublicClient({
      chain: ARC_TESTNET as Chain,
      transport: custom({
        request: async ({ method, params }) => {
          if (method === 'eth_blockNumber') return `0x${latestBlock.toString(16)}`;
          if (method === 'eth_getLogs') {
            const filter = params?.[0] as { address: Address; fromBlock: string; toBlock: string };
            requestedRanges.push({
              token: filter.address,
              fromBlock: filter.fromBlock,
              toBlock: filter.toBlock,
            });
            if (filter.address === APPROVAL_TOKENS[0].address && failFirstUsdcRange) {
              failFirstUsdcRange = false;
              throw new Error('temporary node failure');
            }
            return [];
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        },
      }, { retryCount: 0 }),
    });

    const first = await (await import('./security')).createApprovalProvider(createClient()).scan(owner);
    latestBlock = 11;
    const second = await (await import('./security')).createApprovalProvider(createClient()).scan(owner);

    expect(first.coveredBlocks).toBe(10n);
    expect(second.coveredBlocks).toBe(24n);
    expect(second.totalBlocks).toBe(24n);
    expect(second.isComplete).toBe(true);
    expect(requestedRanges.slice(2)).toEqual([
      { token: APPROVAL_TOKENS[0].address, fromBlock: '0x0', toBlock: '0x9' },
      { token: APPROVAL_TOKENS[0].address, fromBlock: '0xa', toBlock: '0xb' },
      { token: APPROVAL_TOKENS[1].address, fromBlock: '0xa', toBlock: '0xb' },
    ]);
  });

  it('keeps successful adaptive subranges covered when one child range fails', async () => {
    const owner = '0xdddddddddddddddddddddddddddddddddddddddd' as Address;
    let failOneSubrange = true;
    const usdcRanges: Array<[string, string]> = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ is_contract: true, is_verified: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const client = createPublicClient({
      chain: ARC_TESTNET as Chain,
      transport: custom({
        request: async ({ method, params }) => {
          if (method === 'eth_blockNumber') return '0x7';
          if (method === 'eth_getLogs') {
            const filter = params?.[0] as { address: Address; fromBlock: string; toBlock: string };
            if (BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n > 2n) {
              throw new Error('Request exceeds defined limit');
            }
            if (filter.address === APPROVAL_TOKENS[0].address) {
              usdcRanges.push([filter.fromBlock, filter.toBlock]);
              if (filter.fromBlock === '0x2' && filter.toBlock === '0x3' && failOneSubrange) {
                failOneSubrange = false;
                throw new Error('temporary archive read failure');
              }
            }
            return [];
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        },
      }, { retryCount: 0 }),
    });
    const provider = (await import('./security')).createApprovalProvider(client);

    const first = await provider.scan(owner);
    const firstUsdc = first.tokenCoverage[0];
    expect(first.isComplete).toBe(false);
    expect(first.coveredBlocks).toBe(14n);
    expect(first.totalBlocks).toBe(16n);
    expect(firstUsdc.coveredRanges).toEqual([
      { fromBlock: 0n, toBlock: 1n },
      { fromBlock: 4n, toBlock: 7n },
    ]);
    expect(firstUsdc.failedRanges).toEqual([{ fromBlock: 2n, toBlock: 3n }]);
    expect(firstUsdc.remainingRanges).toEqual([{ fromBlock: 2n, toBlock: 3n }]);

    const second = await provider.scan(owner);
    expect(second.isComplete).toBe(true);
    expect(second.coveredBlocks).toBe(16n);
    expect(usdcRanges.slice(-1)).toEqual([['0x2', '0x3']]);
  }, 20_000);

  it('deduplicates simultaneous scans for the same wallet and network', async () => {
    const owner = '0xcccccccccccccccccccccccccccccccccccccccc' as Address;
    let releaseFirstLog: (() => void) | undefined;
    let logRequests = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ is_contract: true, is_verified: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const client = createPublicClient({
      chain: ARC_TESTNET as Chain,
      transport: custom({
        request: async ({ method }) => {
          if (method === 'eth_blockNumber') return '0x0';
          if (method === 'eth_getLogs') {
            logRequests += 1;
            if (logRequests === 1) await new Promise<void>((resolve) => { releaseFirstLog = resolve; });
            return [];
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        },
      }, { retryCount: 0 }),
    });
    const provider = (await import('./security')).createApprovalProvider(client);

    const firstScan = provider.scan(owner);
    const duplicateScan = provider.scan(owner);
    expect(duplicateScan).toBe(firstScan);
    await vi.waitFor(() => expect(releaseFirstLog).toBeDefined());
    releaseFirstLog?.();
    const result = await firstScan;

    expect(result.isComplete).toBe(true);
    expect(logRequests).toBe(APPROVAL_TOKENS.length);
  });

  it('does not dispatch queued split ranges after an RPC rate limit is detected', async () => {
    const owner = '0xdddddddddddddddddddddddddddddddddddddddd' as Address;
    let rateLimitSeen = false;
    const nonzeroRangesAfterRateLimit: string[] = [];
    const client = createPublicClient({
      chain: ARC_TESTNET as Chain,
      transport: custom({
        request: async ({ method, params }) => {
          if (method === 'eth_blockNumber') return '0x3';
          if (method === 'eth_getLogs') {
            const filter = params?.[0] as { fromBlock: string; toBlock: string };
            const range = `${BigInt(filter.fromBlock)}-${BigInt(filter.toBlock)}`;
            if (rateLimitSeen && range !== '0-0') nonzeroRangesAfterRateLimit.push(range);
            if (BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n > 1n) {
              throw new Error('Request exceeds defined limit');
            }
            if (range === '0-0') {
              rateLimitSeen = true;
              throw Object.assign(new Error('rate limit exceeded'), {
                status: 429,
                response: { status: 429, headers: new Headers({ 'Retry-After': '0.01' }) },
              });
            }
            return [];
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        },
      }, { retryCount: 0 }),
    });

    const result = await (await import('./security')).createApprovalProvider(client).scan(owner);

    expect(result.isComplete).toBe(false);
    expect(result.coveredBlocks).toBeLessThan(result.totalBlocks);
    expect(nonzeroRangesAfterRateLimit).toEqual([]);
    expect(result.tokenCoverage[0].failedRanges.some((failed) =>
      failed.fromBlock === 0n && failed.toBlock === 0n,
    )).toBe(false);
    expect(result.tokenCoverage[0].remainingRangeCount).toBeGreaterThan(0);
    expect(result.tokenCoverage[0].failedRanges.every((failed) =>
      result.tokenCoverage[0].remainingRanges.some((remaining) =>
        remaining.fromBlock <= failed.fromBlock && remaining.toBlock >= failed.toBlock,
      ),
    )).toBe(true);
    expect(result.tokenCoverage[0].coveredRanges.some((range) =>
      range.fromBlock <= 0n && range.toBlock >= 0n,
    )).toBe(false);
  });

  it('stops a rate-limited batch and keeps the cooldown across a later scan', async () => {
    const owner = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as Address;
    const storage = new Map<string, string>();
    let logRequests = 0;
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ is_contract: true, is_verified: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const createClient = () => createPublicClient({
      chain: ARC_TESTNET as Chain,
      transport: custom({
        request: async ({ method }) => {
          if (method === 'eth_blockNumber') return '0x0';
          if (method === 'eth_getLogs') {
            logRequests += 1;
            throw Object.assign(new Error('rate limit exceeded'), { status: 429 });
          }
          throw new Error(`Unexpected RPC method: ${method}`);
        },
      }, { retryCount: 0 }),
    });

    const first = await (await import('./security')).createApprovalProvider(createClient()).scan(owner);
    const secondProvider = (await import('./security')).createApprovalProvider(createClient());
    const second = await secondProvider.scan(owner);

    expect(first.isComplete).toBe(false);
    expect(first.coveredBlocks).toBe(0n);
    expect(first.totalBlocks).toBe(2n);
    expect(first.errors.some((error) => /rate limit/i.test(error))).toBe(true);
    expect(second.errors.some((error) => /paused by RPC rate limit/i.test(error))).toBe(true);
    expect(secondProvider.getCooldownUntil(owner)).toBeGreaterThan(Date.now());
    expect(logRequests).toBe(1);
  });
});

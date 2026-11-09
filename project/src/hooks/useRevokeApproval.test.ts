import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { arcTestnet } from 'wagmi/chains';
import type { Address, Hash } from 'viem';
import { APPROVAL_TOKENS, type TokenApproval } from '../services/security';
import { getRevokeSubmissionAction, resetPendingRevokeStateForTests } from '../services/pendingRevoke';

const mocks = vi.hoisted(() => ({
  address: '0x1111111111111111111111111111111111111111',
  spender: '0x2222222222222222222222222222222222222222',
  hash: `0x${'a'.repeat(64)}`,
  useAccount: vi.fn(),
  usePublicClient: vi.fn(),
  useWriteContract: vi.fn(),
  useQueryClient: vi.fn(),
  writeContractAsync: vi.fn(),
  getBlockNumber: vi.fn(),
  readContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
}));

vi.mock('wagmi', () => ({
  useAccount: mocks.useAccount,
  usePublicClient: mocks.usePublicClient,
  useWriteContract: mocks.useWriteContract,
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: mocks.useQueryClient,
}));

import { useRevokeApproval, type UseRevokeApprovalResult } from './useRevokeApproval';

const wallet = mocks.address as Address;
const spender = mocks.spender as Address;
const hash = mocks.hash as Hash;
const storage = new Map<string, string>();

function makeApproval(): TokenApproval {
  const token = APPROVAL_TOKENS[0];
  return {
    id: `${token.address}:${spender.toLowerCase()}`,
    token,
    spenderAddress: spender,
    allowance: 1n,
    allowanceFormatted: '1',
    isUnlimited: false,
    risk: 'Low',
    status: 'Limited allowance active',
    lastSeenBlock: 1n,
    allowanceCheckedBlock: 1n,
    allowanceCheckedAt: Date.now(),
    tokenVerified: true,
    spenderVerified: true,
  };
}

function mountHook(): UseRevokeApprovalResult {
  let result: UseRevokeApprovalResult | undefined;
  function HookProbe() {
    result = useRevokeApproval();
    return null;
  }
  renderToString(createElement(HookProbe));
  if (!result) throw new Error('The revoke hook did not render.');
  return result;
}

function setStorage(overrides: Partial<Storage> = {}) {
  vi.stubGlobal('window', {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
      ...overrides,
    },
  });
}

beforeEach(() => {
  resetPendingRevokeStateForTests();
  storage.clear();
  setStorage();
  mocks.useAccount.mockReturnValue({ address: wallet, chainId: arcTestnet.id });
  mocks.usePublicClient.mockReturnValue({
    getBlockNumber: mocks.getBlockNumber,
    readContract: mocks.readContract,
    waitForTransactionReceipt: mocks.waitForTransactionReceipt,
  });
  mocks.useWriteContract.mockReturnValue({ writeContractAsync: mocks.writeContractAsync });
  mocks.useQueryClient.mockReturnValue({
    setQueriesData: vi.fn(),
    invalidateQueries: vi.fn(),
    refetchQueries: vi.fn(),
  });
  mocks.writeContractAsync.mockResolvedValue(hash);
  mocks.getBlockNumber.mockResolvedValue(10n);
  mocks.readContract.mockResolvedValue(5n);
  mocks.waitForTransactionReceipt.mockResolvedValue({
    status: 'success',
    from: wallet,
    blockNumber: 11n,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('useRevokeApproval recovery', () => {
  it('recovers after a receipt timeout and remount, then checks the same transaction without resubmitting', async () => {
    mocks.waitForTransactionReceipt.mockRejectedValueOnce(new Error('Timed out waiting for transaction receipt'));
    const initialHook = mountHook();

    await initialHook.revoke(makeApproval());

    expect(mocks.writeContractAsync).toHaveBeenCalledTimes(1);
    expect(getRevokeSubmissionAction(wallet).type).toBe('resume');

    resetPendingRevokeStateForTests();
    const remountedHook = mountHook();
    expect(remountedHook.transactionHash).toBe(hash);
    expect(remountedHook.status).toBe('confirmation-pending');

    await remountedHook.revoke(makeApproval());
    expect(mocks.writeContractAsync).toHaveBeenCalledTimes(1);

    mocks.readContract.mockResolvedValueOnce(0n).mockResolvedValueOnce(0n);
    await remountedHook.retryRevokeCheck();

    expect(mocks.waitForTransactionReceipt).toHaveBeenLastCalledWith({ hash });
    expect(mocks.readContract).toHaveBeenCalledTimes(3);
    expect(mocks.writeContractAsync).toHaveBeenCalledTimes(1);
    expect(getRevokeSubmissionAction(wallet).type).toBe('submit');
  });

  it('does not open a wallet request when session storage cannot be verified', async () => {
    setStorage({
      setItem: () => { throw new Error('storage unavailable'); },
    });

    await mountHook().revoke(makeApproval());

    expect(mocks.writeContractAsync).not.toHaveBeenCalled();
    expect(mocks.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it('fails closed when pending-state storage fails after the recovery probe succeeds', async () => {
    let writes = 0;
    setStorage({
      setItem: (key: string, value: string) => {
        writes += 1;
        if (writes > 1) throw new Error('pending record could not be written');
        storage.set(key, value);
      },
    });

    await mountHook().revoke(makeApproval());

    expect(writes).toBe(2);
    expect(mocks.writeContractAsync).not.toHaveBeenCalled();
  });

  it('fails closed when session storage cannot be read', async () => {
    setStorage({
      getItem: () => { throw new Error('storage read denied'); },
    });

    await mountHook().revoke(makeApproval());

    expect(mocks.writeContractAsync).not.toHaveBeenCalled();
  });

  it('blocks a wallet request when saved recovery data is malformed', async () => {
    storage.set(
      `orbit:pending-revoke:v1:${wallet.toLowerCase()}`,
      JSON.stringify({ version: 2, walletAddress: wallet, phase: 'submitted', hash: 'invalid' }),
    );

    await mountHook().revoke(makeApproval());

    expect(mocks.writeContractAsync).not.toHaveBeenCalled();
  });

  it('clears the pre-submission reservation after a wallet rejection', async () => {
    mocks.writeContractAsync.mockRejectedValueOnce(
      Object.assign(new Error('User rejected request'), { code: 4001 }),
    );

    await mountHook().revoke(makeApproval());

    expect(mocks.writeContractAsync).toHaveBeenCalledTimes(1);
    expect(mocks.waitForTransactionReceipt).not.toHaveBeenCalled();
    expect(getRevokeSubmissionAction(wallet).type).toBe('submit');
  });

  it('keeps the transaction unresolved after a non-rejection wallet submission error', async () => {
    mocks.writeContractAsync.mockRejectedValueOnce(new Error('Wallet RPC timed out'));

    await mountHook().revoke(makeApproval());

    expect(mocks.waitForTransactionReceipt).not.toHaveBeenCalled();
    expect(getRevokeSubmissionAction(wallet).type).toBe('resume');
    expect(mountHook().status).toBe('confirmation-pending');
  });

  it('does not report success for a reverted receipt', async () => {
    mocks.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'reverted',
      from: wallet,
      blockNumber: 11n,
    });

    await mountHook().revoke(makeApproval());

    expect(mocks.readContract).toHaveBeenCalledTimes(1);
    expect(getRevokeSubmissionAction(wallet).type).toBe('submit');
  });

  it('keeps a confirmed transaction recoverable when allowance verification RPC fails', async () => {
    mocks.readContract.mockResolvedValueOnce(5n).mockRejectedValueOnce(new Error('RPC unavailable'));

    await mountHook().revoke(makeApproval());

    const action = getRevokeSubmissionAction(wallet);
    expect(action.type).toBe('resume');
    if (action.type === 'resume') {
      expect(action.record.phase).toBe('confirmed');
      expect(action.record.hash).toBe(hash);
      expect(action.record.receiptBlock).toBe(11n);
    }
  });
});

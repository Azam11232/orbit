import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimRevokeOperation,
  ensurePendingRevokeStorage,
  getRevokeSubmissionAction,
  loadPendingRevoke,
  releaseRevokeOperation,
  resetPendingRevokeStateForTests,
  savePendingRevoke,
} from './pendingRevoke';
import type { Address, Hash } from 'viem';

const wallet = '0x1111111111111111111111111111111111111111' as Address;
const token = '0x2222222222222222222222222222222222222222' as Address;
const spender = '0x3333333333333333333333333333333333333333' as Address;
const hash = `0x${'a'.repeat(64)}` as Hash;
const storedValues = new Map<string, string>();

beforeEach(() => {
  resetPendingRevokeStateForTests();
  storedValues.clear();
  vi.stubGlobal('window', {
    sessionStorage: {
      getItem: (key: string) => storedValues.get(key) ?? null,
      setItem: (key: string, value: string) => storedValues.set(key, value),
      removeItem: (key: string) => storedValues.delete(key),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pending revoke recovery', () => {
  it('restores the submitted hash after leaving and remounting the approvals screen', () => {
    savePendingRevoke({ walletAddress: wallet, tokenAddress: token, spenderAddress: spender, phase: 'submitted', hash });

    resetPendingRevokeStateForTests();
    const restored = loadPendingRevoke(wallet);

    expect(restored.error).toBeNull();
    expect(restored.record).toEqual({
      walletAddress: wallet,
      tokenAddress: token,
      spenderAddress: spender,
      phase: 'submitted',
      hash,
    });

    const writeContractAsync = vi.fn();
    const writeNewRevoke = () => {
      if (getRevokeSubmissionAction(wallet).type === 'submit') writeContractAsync();
    };
    writeNewRevoke();

    expect(writeContractAsync).not.toHaveBeenCalled();
    expect(getRevokeSubmissionAction(wallet).type).toBe('resume');
  });

  it('restores confirmed receipt state so remounts retry allowance verification, not submission', () => {
    savePendingRevoke({
      walletAddress: wallet,
      tokenAddress: token,
      spenderAddress: spender,
      phase: 'confirmed',
      hash,
      receiptBlock: 123n,
    });

    resetPendingRevokeStateForTests();
    const restored = loadPendingRevoke(wallet);

    expect(restored.record?.hash).toBe(hash);
    expect(restored.record?.receiptBlock).toBe(123n);
    expect(claimRevokeOperation(wallet)).toBe(true);
    expect(claimRevokeOperation(wallet)).toBe(false);
    releaseRevokeOperation(wallet);
    expect(claimRevokeOperation(wallet)).toBe(true);
    releaseRevokeOperation(wallet);
  });

  it('does not restore a pending transaction under a different wallet', () => {
    savePendingRevoke({ walletAddress: wallet, tokenAddress: token, spenderAddress: spender, phase: 'submitted', hash });

    const restored = loadPendingRevoke('0x4444444444444444444444444444444444444444' as Address);

    expect(restored.error).toBeNull();
    expect(restored.record).toBeNull();
  });

  it('blocks submission when session storage cannot be read or written', () => {
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: () => { throw new Error('storage denied'); },
        setItem: () => { throw new Error('storage denied'); },
        removeItem: () => { throw new Error('storage denied'); },
      },
    });

    expect(getRevokeSubmissionAction(wallet).type).toBe('blocked');
    expect(ensurePendingRevokeStorage(wallet)).toBeInstanceOf(Error);
  });

  it('retains the submission reservation when pending-state persistence fails', () => {
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: () => null,
        setItem: () => { throw new Error('quota exceeded'); },
        removeItem: () => undefined,
      },
    });

    expect(savePendingRevoke({
      walletAddress: wallet,
      tokenAddress: token,
      spenderAddress: spender,
      phase: 'wallet-request',
    })).toBeInstanceOf(Error);
    expect(getRevokeSubmissionAction(wallet).type).toBe('resume');
  });

  it('blocks malformed pending transaction records', () => {
    storedValues.set(
      `orbit:pending-revoke:v1:${wallet.toLowerCase()}`,
      JSON.stringify({ version: 2, walletAddress: wallet, tokenAddress: token, spenderAddress: spender, phase: 'submitted', hash: 'bad' }),
    );

    expect(getRevokeSubmissionAction(wallet).type).toBe('blocked');
  });
});

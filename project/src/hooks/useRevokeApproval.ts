import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
import { arcTestnet } from 'wagmi/chains';
import { erc20Abi, formatUnits, type Address, type Hash } from 'viem';
import { APPROVAL_TOKENS, canRevokeApproval, getRevokeConfirmationStatus, interpretVerifiedAllowance, type ApprovalScanResult, type TokenApproval } from '../services/security';
import { claimRevokeOperation, clearPendingRevoke, ensurePendingRevokeStorage, getRevokeSubmissionAction, releaseRevokeOperation, savePendingRevoke, type PendingRevokeRecord } from '../services/pendingRevoke';

export type RevokeStatus = 'idle' | 'checking' | 'pending' | 'confirmation-pending' | 'success' | 'already-zero' | 'verification-pending' | 'error';

export interface UseRevokeApprovalResult {
  revoke: (approval: TokenApproval) => Promise<void>;
  activeApprovalId: string | null;
  status: RevokeStatus;
  transactionHash: Hash | undefined;
  error: Error | null;
  retryRevokeCheck: () => Promise<void>;
}

function approvalForPendingRevoke(record: PendingRevokeRecord): TokenApproval {
  const token = APPROVAL_TOKENS.find(
    (candidate) => candidate.address.toLowerCase() === record.tokenAddress.toLowerCase(),
  );
  if (!token) throw new Error('Saved revoke transaction uses an unsupported token.');
  return {
    id: `${token.address}:${record.spenderAddress.toLowerCase()}`,
    token,
    spenderAddress: record.spenderAddress,
    allowance: 1n,
    allowanceFormatted: '1',
    isUnlimited: false,
    risk: 'Unknown',
    status: 'Verification pending',
    lastSeenBlock: 0n,
    allowanceCheckedBlock: 0n,
    allowanceCheckedAt: 0,
    tokenVerified: null,
    spenderVerified: null,
  };
}

function restorePendingRevoke(walletAddress?: Address) {
  if (!walletAddress) return { pending: null, error: null };
  const action = getRevokeSubmissionAction(walletAddress);
  if (action.type === 'blocked') return { pending: null, error: action.error };
  if (action.type === 'submit') return { pending: null, error: null };
  try {
    return {
      pending: {
        approval: approvalForPendingRevoke(action.record),
        address: action.record.walletAddress,
        phase: action.record.phase,
        hash: action.record.hash,
        receiptBlock: action.record.receiptBlock,
      },
      error: null,
    };
  } catch (caughtError) {
    return {
      pending: null,
      error: caughtError instanceof Error ? caughtError : new Error('Saved revoke transaction is invalid.'),
    };
  }
}

interface PendingVerification {
  approval: TokenApproval;
  address: Address;
  phase: PendingRevokeRecord['phase'];
  hash?: Hash;
  receiptBlock?: bigint;
}

function isWalletRejection(error: unknown): boolean {
  let current = error;
  while (typeof current === 'object' && current !== null) {
    const candidate = current as { cause?: unknown; code?: unknown; message?: unknown; name?: unknown };
    if (
      candidate.code === 4001 ||
      candidate.code === 'ACTION_REJECTED' ||
      candidate.name === 'UserRejectedRequestError' ||
      (typeof candidate.message === 'string' && /user rejected|request rejected/i.test(candidate.message))
    ) return true;
    current = candidate.cause;
  }
  return false;
}

export function useRevokeApproval(): UseRevokeApprovalResult {
  const { address, chainId } = useAccount();
  const accountContext = useRef({ address, chainId });
  accountContext.current = { address, chainId };
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const [restoredPending] = useState(() => restorePendingRevoke(address));
  const [activeApprovalId, setActiveApprovalId] = useState<string | null>(
    restoredPending.pending?.approval.id ?? null,
  );
  const [status, setStatus] = useState<RevokeStatus>(
    restoredPending.error
      ? 'error'
      : restoredPending.pending
        ? restoredPending.pending.receiptBlock === undefined ? 'confirmation-pending' : 'verification-pending'
        : 'idle',
  );
  const [transactionHash, setTransactionHash] = useState<Hash | undefined>(restoredPending.pending?.hash);
  const [error, setError] = useState<Error | null>(restoredPending.error);
  const operationInProgress = useRef(false);
  const pendingVerification = useRef<PendingVerification | null>(restoredPending.pending);

  useEffect(() => {
    const restored = restorePendingRevoke(address);
    pendingVerification.current = restored.pending;
    setActiveApprovalId(restored.pending?.approval.id ?? null);
    setTransactionHash(restored.pending?.hash);
    setError(restored.error);
    setStatus(restored.error
      ? 'error'
      : restored.pending
        ? restored.pending.receiptBlock === undefined ? 'confirmation-pending' : 'verification-pending'
        : 'idle');
  }, [address]);

  const updateVerifiedAllowance = (approval: TokenApproval, wallet: Address, allowance: bigint, blockNumber: bigint) => {
    const queryKey = ['approvals', wallet.toLowerCase(), arcTestnet.id] as const;
    const checkedAt = Date.now();
    const interpreted = interpretVerifiedAllowance(
      allowance,
      approval.token.decimals,
      approval.tokenVerified,
      approval.spenderVerified,
    );
    queryClient.setQueriesData<ApprovalScanResult>({ queryKey }, (previous) => previous && ({
      ...previous,
      approvals: previous.approvals.map((item) => item.id === approval.id ? {
        ...item,
        allowance,
        allowanceFormatted: formatUnits(allowance, approval.token.decimals),
        ...interpreted,
        allowanceCheckedBlock: blockNumber,
        allowanceCheckedAt: checkedAt,
      } : item),
    }));
    void queryClient.invalidateQueries({ queryKey, refetchType: 'none' });
  };

  const verifyConfirmedAllowance = async (
    approval: TokenApproval,
    wallet: Address,
    receiptBlock: bigint,
  ): Promise<void> => {
    if (!publicClient) throw new Error('Arc Testnet RPC client is unavailable.');
    const receiptAllowance = await publicClient.readContract({
      address: approval.token.address,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [wallet, approval.spenderAddress],
      blockNumber: receiptBlock,
    });
    if (getRevokeConfirmationStatus({
      receiptStatus: 'success',
      expectedWallet: wallet,
      receiptWallet: wallet,
      allowanceAtReceipt: receiptAllowance,
      refreshedAllowance: 0n,
    }) !== 'success') {
      throw new Error(`Transaction confirmed in block ${receiptBlock}, but the allowance is still nonzero.`);
    }
    const verifiedBlock = await publicClient.getBlockNumber();
    const refreshedAllowance = await publicClient.readContract({
      address: approval.token.address,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [wallet, approval.spenderAddress],
      blockNumber: verifiedBlock,
    });
    if (getRevokeConfirmationStatus({
      receiptStatus: 'success',
      expectedWallet: wallet,
      receiptWallet: wallet,
      allowanceAtReceipt: receiptAllowance,
      refreshedAllowance,
    }) !== 'success') {
      throw new Error(`A fresh allowance read at block ${verifiedBlock} is still nonzero.`);
    }

    updateVerifiedAllowance(approval, wallet, 0n, verifiedBlock);
    const clearError = clearPendingRevoke(wallet);
    pendingVerification.current = null;
    setStatus('success');
    setError(clearError
      ? new Error(`Revoke was verified, but its saved pending state could not be cleared: ${clearError.message}`)
      : null);
    void queryClient.refetchQueries({
      queryKey: ['approvals', wallet.toLowerCase(), arcTestnet.id],
      type: 'active',
    });
  };

  const retryRevokeCheck = async () => {
    const pending = pendingVerification.current;
    if (!pending || operationInProgress.current) return;
    operationInProgress.current = true;
    setStatus(pending.receiptBlock === undefined ? 'confirmation-pending' : 'verification-pending');
    setError(null);
    try {
      if (pending.phase === 'wallet-request' || !pending.hash) {
        throw new Error('Wallet submission outcome is unknown and no transaction hash was saved. Verify wallet activity before retrying; another revoke is blocked.');
      }
      if (pending.receiptBlock === undefined) {
        if (!publicClient) throw new Error('Arc Testnet RPC client is unavailable.');
        const receipt = await publicClient.waitForTransactionReceipt({ hash: pending.hash });
        if (receipt.status !== 'success') throw new Error('Approval revoke transaction reverted.');
        if (receipt.from.toLowerCase() !== pending.address.toLowerCase()) {
          throw new Error('Confirmed transaction was submitted by a different wallet; the connected wallet allowance was not verified.');
        }
        pending.receiptBlock = receipt.blockNumber;
        pending.phase = 'confirmed';
        const saveError = savePendingRevoke({
          walletAddress: pending.address,
          tokenAddress: pending.approval.token.address,
          spenderAddress: pending.approval.spenderAddress,
          hash: pending.hash,
          phase: pending.phase,
          receiptBlock: pending.receiptBlock,
        });
        if (saveError) throw new Error(`Receipt confirmed; pending state could not be saved: ${saveError.message}`);
      }
      await verifyConfirmedAllowance(pending.approval, pending.address, pending.receiptBlock);
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'The current allowance could not be verified.';
      if (/reverted|different wallet|allowance is still nonzero|fresh allowance read .* still nonzero/i.test(message)) {
        const clearError = clearPendingRevoke(pending.address);
        if (!clearError) pendingVerification.current = null;
        setStatus(clearError ? 'confirmation-pending' : 'error');
        setError(clearError
          ? new Error(`${message} Pending recovery state could not be cleared: ${clearError.message}`)
          : new Error(message));
      } else if (pending.phase === 'wallet-request') {
        setStatus('confirmation-pending');
        setError(new Error(`${message} The wallet request may not have produced a transaction hash. Verify wallet activity before retrying; another revoke remains blocked.`));
      } else if (pending.receiptBlock === undefined) {
        setStatus('confirmation-pending');
        setError(new Error(`Revoke transaction submitted; confirmation is pending. ${message}`));
      } else {
        setStatus('verification-pending');
        setError(new Error(`Transaction confirmed — allowance verification pending. ${message}`));
      }
    } finally {
      operationInProgress.current = false;
    }
  };

  const revoke = async (approval: TokenApproval) => {
    if (!address || chainId !== arcTestnet.id || !publicClient) {
      setError(new Error('Connect your wallet on Arc Testnet to revoke an approval'));
      setStatus('error');
      return;
    }
    if (operationInProgress.current || !claimRevokeOperation(address)) {
      setError(new Error('Another approval revoke is already in progress'));
      return;
    }
    const savedAction = getRevokeSubmissionAction(address);
    if (savedAction.type === 'blocked') {
      setStatus('error');
      setError(savedAction.error);
      releaseRevokeOperation(address);
      return;
    }
    if (savedAction.type === 'resume') {
      let pending: PendingVerification;
      try {
        pending = {
          approval: approvalForPendingRevoke(savedAction.record),
          address: savedAction.record.walletAddress,
          phase: savedAction.record.phase,
          hash: savedAction.record.hash,
          receiptBlock: savedAction.record.receiptBlock,
        };
      } catch (caughtError) {
        setStatus('error');
        setError(caughtError instanceof Error ? caughtError : new Error('Saved revoke transaction is invalid.'));
        releaseRevokeOperation(address);
        return;
      }
      pendingVerification.current = pending;
      setActiveApprovalId(pending.approval.id);
      setTransactionHash(pending.hash);
      setStatus(pending.receiptBlock === undefined ? 'confirmation-pending' : 'verification-pending');
      setError(new Error('An earlier revoke is unresolved. Check its existing transaction before submitting another.'));
      releaseRevokeOperation(address);
      return;
    }
    if (!canRevokeApproval(approval)) {
      setError(new Error('Revoking is only available for a verified token and verified spender'));
      setStatus('error');
      releaseRevokeOperation(address);
      return;
    }

    setActiveApprovalId(approval.id);
    setStatus('checking');
    operationInProgress.current = true;
    setTransactionHash(undefined);
    setError(null);

    try {
      const checkedBlock = await publicClient.getBlockNumber();
      const currentAllowance = await publicClient.readContract({
        address: approval.token.address,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address, approval.spenderAddress],
        blockNumber: checkedBlock,
      });
      if (currentAllowance === 0n) {
        updateVerifiedAllowance(approval, address, 0n, checkedBlock);
        setStatus('already-zero');
        return;
      }
      if (accountContext.current.address?.toLowerCase() !== address.toLowerCase() ||
          accountContext.current.chainId !== arcTestnet.id) {
        throw new Error('Wallet or network changed during the allowance check. Re-scan before revoking.');
      }
      const storageError = ensurePendingRevokeStorage(address);
      if (storageError) throw new Error(`Revoke submission is disabled because recovery storage is unavailable: ${storageError.message}`);
      const intent: PendingRevokeRecord = {
        walletAddress: address,
        tokenAddress: approval.token.address,
        spenderAddress: approval.spenderAddress,
        phase: 'wallet-request',
      };
      const intentError = savePendingRevoke(intent);
      if (intentError) throw new Error(`Revoke submission is disabled because its recovery state could not be saved: ${intentError.message}`);
      pendingVerification.current = {
        approval,
        address,
        phase: 'wallet-request',
      };
      const hash = await writeContractAsync({
        address: approval.token.address,
        abi: erc20Abi,
        functionName: 'approve',
        args: [approval.spenderAddress, 0n],
        chainId: arcTestnet.id,
      });
      setTransactionHash(hash);
      const pending = pendingVerification.current;
      if (!pending) throw new Error('Revoke recovery state was lost after wallet submission.');
      pending.phase = 'submitted';
      pending.hash = hash;
      const saveError = savePendingRevoke({
        walletAddress: address,
        tokenAddress: approval.token.address,
        spenderAddress: approval.spenderAddress,
        phase: pending.phase,
        hash,
      });
      releaseRevokeOperation(address);
      setStatus('pending');
      if (saveError) {
        setStatus('confirmation-pending');
        setError(new Error(`Revoke transaction submitted; confirmation is pending. Its session record could not be saved: ${saveError.message}`));
      }
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        const clearError = clearPendingRevoke(address);
        if (!clearError) pendingVerification.current = null;
        throw new Error(clearError
          ? `Approval revoke transaction reverted, but pending recovery state could not be cleared: ${clearError.message}`
          : 'Approval revoke transaction reverted.');
      }
      if (getRevokeConfirmationStatus({
        receiptStatus: receipt.status,
        expectedWallet: address,
        receiptWallet: receipt.from,
      }) !== 'verification-pending') {
        const clearError = clearPendingRevoke(address);
        if (!clearError) pendingVerification.current = null;
        throw new Error(clearError
          ? `Confirmed transaction sender did not match the connected wallet, and pending recovery state could not be cleared: ${clearError.message}`
          : 'Confirmed transaction was submitted by a different wallet; the connected wallet allowance was not verified.');
      }
      pending.receiptBlock = receipt.blockNumber;
      pending.phase = 'confirmed';
      const receiptSaveError = savePendingRevoke({
        walletAddress: address,
        tokenAddress: approval.token.address,
        spenderAddress: approval.spenderAddress,
        phase: pending.phase,
        hash,
        receiptBlock: receipt.blockNumber,
      });
      if (receiptSaveError) {
        throw new Error(`Receipt confirmed; allowance verification is pending because its session state could not be saved: ${receiptSaveError.message}`);
      }
      await verifyConfirmedAllowance(approval, address, receipt.blockNumber);
    } catch (caughtError) {
      const caught = caughtError instanceof Error ? caughtError : new Error('Revoke transaction failed');
      if (pendingVerification.current) {
        if (pendingVerification.current.phase === 'wallet-request' && isWalletRejection(caughtError)) {
          const clearError = clearPendingRevoke(address);
          if (!clearError) pendingVerification.current = null;
          setStatus(clearError ? 'confirmation-pending' : 'error');
          setError(clearError
            ? new Error(`Wallet rejected the revoke, but its recovery state could not be cleared: ${clearError.message}`)
            : caught);
        } else if (pendingVerification.current.phase === 'wallet-request') {
          setStatus('confirmation-pending');
          setError(new Error(`Wallet submission outcome is unknown; verify wallet activity before retrying. ${caught.message}`));
        } else if (pendingVerification.current.receiptBlock === undefined) {
          if (/reverted|different wallet/i.test(caught.message)) {
            const clearError = clearPendingRevoke(address);
            if (!clearError) pendingVerification.current = null;
            setStatus(clearError ? 'confirmation-pending' : 'error');
            setError(clearError
              ? new Error(`${caught.message} Pending recovery state could not be cleared: ${clearError.message}`)
              : caught);
          } else {
            setStatus('confirmation-pending');
            setError(new Error(`Revoke transaction submitted; confirmation is pending. ${caught.message}`));
          }
        } else if (/allowance is still nonzero|fresh allowance read .* still nonzero/i.test(caught.message)) {
          const clearError = clearPendingRevoke(address);
          if (!clearError) pendingVerification.current = null;
          setStatus(clearError ? 'verification-pending' : 'error');
          setError(clearError
            ? new Error(`${caught.message} Pending recovery state could not be cleared: ${clearError.message}`)
            : caught);
        } else {
          setStatus('verification-pending');
          setError(new Error(`Transaction confirmed — allowance verification pending. ${caught.message}`));
        }
      } else {
        setStatus('error');
        setError(caught);
      }
    } finally {
      operationInProgress.current = false;
      releaseRevokeOperation(address);
    }
  };

  return { revoke, activeApprovalId, status, transactionHash, error, retryRevokeCheck };
}

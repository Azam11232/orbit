import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, usePublicClient, useSendTransaction as useWagmiSendTransaction, useWriteContract } from 'wagmi';
import { arcTestnet } from 'wagmi/chains';
import { encodeFunctionData, erc20Abi, isAddress, parseUnits, type Address, type Hash } from 'viem';
import { ARC_USDC } from '../data/tokens';
import type { BaseAssetConfig } from '../data/tokens';
import {
  claimTransactionRecovery,
  inspectKnownTransactionReceipt,
  isRecoveryUnresolved,
  readTransactionRecovery,
  resolveRecoveryContext,
  updateTransactionRecoveryIfCurrent,
  type RecoveryStatus,
} from '../services/transactionRecovery';
import { isCurrentSendFlow } from '../services/sendLifecycle';

const RECEIPT_TIMEOUT_MS = 180_000;

export type SendStatus =
  | 'idle'
  | 'preparing'
  | 'ready'
  | 'confirmation'
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'rejected'
  | 'timeout'
  | 'rpc-error'
  | 'uncertain'
  | 'recovery-mismatch'
  | 'reverted';

export interface SendRequest {
  asset: BaseAssetConfig;
  recipient: Address;
  amount: bigint;
}

export interface UseSendTransactionResult {
  prepare: (request: SendRequest) => Promise<boolean>;
  confirm: (request: SendRequest) => Promise<void>;
  send: (request: SendRequest) => Promise<void>;
  status: SendStatus;
  transactionHash: Hash | undefined;
  error: Error | null;
  gasEstimate: bigint | null;
  gasCost: bigint | null;
  submissionUncertain: boolean;
  retryRecoveryCheck: () => Promise<void>;
  reset: () => void;
}

export function isArcUsdcAsset(asset: BaseAssetConfig): boolean {
  return asset.chainId === arcTestnet.id
    && asset.symbol === ARC_USDC.symbol
    && asset.address?.toLowerCase() === ARC_USDC.address.toLowerCase()
    && asset.decimals === ARC_USDC.decimals
    && !asset.isNative;
}

export function buildErc20TransferData(recipient: Address, amount: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [recipient, amount],
  });
}

export function validateSendRequest({
  address,
  recipient,
  amount,
  balance,
  decimals,
}: {
  address?: Address;
  recipient: string;
  amount: string;
  balance: bigint;
  decimals: number;
}): string | null {
  if (!isAddress(recipient) || recipient.toLowerCase() === '0x0000000000000000000000000000000000000000' || recipient.toLowerCase() === address?.toLowerCase()) {
    return 'Enter a valid non-zero recipient address that is not your own wallet.';
  }
  let rawAmount: bigint;
  try {
    const normalizedAmount = amount || '0';
    const amountParts = normalizedAmount.trim().match(/^(\d+)(?:\.(\d*))?$/);
    if (!amountParts || (amountParts[2]?.length ?? 0) > decimals) throw new Error('Invalid amount');
    rawAmount = parseUnits(normalizedAmount, decimals);
  } catch {
    return `Enter a valid amount with up to ${decimals} decimals.`;
  }
  if (rawAmount <= 0n) return 'Amount must be greater than zero.';
  if (rawAmount > balance) return 'Insufficient token balance.';
  return null;
}

export function isUserRejectedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /user rejected|user denied|rejected the request|denied transaction/i.test(message);
}

function getSendStatus(status: RecoveryStatus): SendStatus {
  if (status === 'confirmed') return 'confirmed';
  if (status === 'reverted') return 'reverted';
  if (status === 'timeout') return 'timeout';
  if (status === 'rpc-error') return 'rpc-error';
  if (status === 'uncertain' || status === 'wallet-request') return 'uncertain';
  return 'pending';
}

export function useSendTransaction(): UseSendTransactionResult {
  const { address, chainId } = useAccount();
  const activeChainId = arcTestnet.id;
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { sendTransactionAsync } = useWagmiSendTransaction();
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SendStatus>(() => {
    if (!address) return 'idle';
    const saved = readTransactionRecovery(address, 'send');
    if (saved.error) return 'uncertain';
    if (!saved.record) return 'idle';
    return resolveRecoveryContext(saved.record, address, [activeChainId]).type === 'match'
      ? getSendStatus(saved.record.status)
      : 'recovery-mismatch';
  });
  const [transactionHash, setTransactionHash] = useState<Hash | undefined>(() => {
    if (!address) return undefined;
    const transactions = readTransactionRecovery(address, 'send').record?.transactions ?? [];
    return transactions[transactions.length - 1]?.hash;
  });
  const [error, setError] = useState<Error | null>(() => {
    if (!address) return null;
    const saved = readTransactionRecovery(address, 'send');
    if (saved.error) return saved.error;
    if (saved.record && resolveRecoveryContext(saved.record, address, [activeChainId]).type !== 'match') {
      return new Error('A previous Send transaction belongs to a different chain context. Verify its wallet activity before submitting again.');
    }
    return saved.record?.error ? new Error(saved.record.error) : null;
  });
  const [gasEstimate, setGasEstimate] = useState<bigint | null>(null);
  const [gasCost, setGasCost] = useState<bigint | null>(null);
  const inFlight = useRef(false);
  const flowGenerationRef = useRef(0);
  const [submissionUncertain, setSubmissionUncertain] = useState(() => {
    if (!address) return false;
    const saved = readTransactionRecovery(address, 'send');
    return Boolean(saved.error || (saved.record && isRecoveryUnresolved(saved.record.status)));
  });
  const submissionUncertainRef = useRef(submissionUncertain);
  const submittedHash = useRef<Hash>();
  submittedHash.current = submissionUncertain ||
    status === 'pending' || status === 'timeout' || status === 'rpc-error' || status === 'uncertain'
    ? transactionHash
    : undefined;
  const preparedRequest = useRef<{ asset: BaseAssetConfig; recipient: Address; amount: bigint; address: Address; gasCost: bigint }>();
  const recoveryCheckInFlight = useRef(false);

  useEffect(() => {
    flowGenerationRef.current += 1;
    submittedHash.current = undefined;
    preparedRequest.current = undefined;
    if (!address) {
      submissionUncertainRef.current = false;
      setSubmissionUncertain(false);
      setStatus('idle');
      setTransactionHash(undefined);
      setError(null);
      return;
    }
    const saved = readTransactionRecovery(address, 'send');
    const context = saved.record
      ? resolveRecoveryContext(saved.record, address, [activeChainId])
      : { type: 'none' as const };
    const mismatch = context.type === 'chain-mismatch';
    const nextStatus: SendStatus = saved.error
      ? 'uncertain'
      : mismatch
        ? 'recovery-mismatch'
        : saved.record
          ? getSendStatus(saved.record.status)
          : 'idle';
    const savedTransactions = context.type === 'match' ? context.record.transactions : [];
    const hash = savedTransactions[savedTransactions.length - 1]?.hash;
    const uncertain = Boolean(saved.error || mismatch || (saved.record && isRecoveryUnresolved(saved.record.status)));
    submissionUncertainRef.current = uncertain;
    setSubmissionUncertain(uncertain);
    setStatus(nextStatus);
    setTransactionHash(hash);
    submittedHash.current = uncertain ? hash : undefined;
    setError(saved.error ?? (mismatch
      ? new Error('A previous Send transaction belongs to a different chain context. Verify its wallet activity before submitting again.')
      : saved.record?.error ? new Error(saved.record.error) : null));
  }, [address, activeChainId, chainId]);

  useEffect(() => () => {
    flowGenerationRef.current += 1;
  }, []);

  const retryRecoveryCheck = async () => {
    if (!address || inFlight.current || recoveryCheckInFlight.current) return;
    const flowGeneration = flowGenerationRef.current;
    const loaded = readTransactionRecovery(address, 'send');
    if (loaded.error || !loaded.record) {
      setStatus('uncertain');
      setError(loaded.error ?? new Error('No saved Send transaction is available to check.'));
      return;
    }
    const context = resolveRecoveryContext(loaded.record, address, [activeChainId]);
    if (context.type !== 'match') {
      setStatus('recovery-mismatch');
      setError(new Error('The saved Send transaction belongs to a different wallet or chain context.'));
      return;
    }
    const savedHash = context.record.transactions[context.record.transactions.length - 1]?.hash;
    if (!savedHash) {
      setStatus('uncertain');
      setError(new Error('The wallet submission outcome is unknown and no transaction hash was saved. Check wallet activity before taking further action.'));
      return;
    }
    if (!publicClient) {
      setStatus('rpc-error');
      setError(new Error('Arc Testnet RPC is unavailable. The saved transaction remains unresolved.'));
      return;
    }
    recoveryCheckInFlight.current = true;
    const result = await inspectKnownTransactionReceipt(
      async () => publicClient.getTransactionReceipt({ hash: savedHash }),
    );
    recoveryCheckInFlight.current = false;
    if (!isCurrentSendFlow(flowGeneration, flowGenerationRef.current)) {
      void retryRecoveryCheckRef.current();
      return;
    }
    const message = result.error?.message ?? (result.status === 'reverted' ? 'Send transaction reverted on Arc Testnet.' : undefined);
    const savedUpdate = await updateTransactionRecoveryIfCurrent(
      address,
      'send',
      context.record.operationId,
      { status: result.status, error: message },
      context.record.updatedAt,
    );
    if (savedUpdate.stale || savedUpdate.error) {
      if (savedUpdate.record) {
        setStatus(getSendStatus(savedUpdate.record.status));
        setTransactionHash(savedUpdate.record.transactions[savedUpdate.record.transactions.length - 1]?.hash);
      }
      setError(savedUpdate.error ?? new Error('Send recovery changed while its receipt was being checked.'));
      return;
    }
    setStatus(getSendStatus(result.status));
    setTransactionHash(savedHash);
    submittedHash.current = savedHash;
    submissionUncertainRef.current = isRecoveryUnresolved(result.status);
    setSubmissionUncertain(submissionUncertainRef.current);
    setError(message ? new Error(message) : null);
    if (result.status === 'confirmed') void queryClient.invalidateQueries();
  };
  const retryRecoveryCheckRef = useRef(retryRecoveryCheck);
  retryRecoveryCheckRef.current = retryRecoveryCheck;

  useEffect(() => {
    if (!inFlight.current && address && transactionHash && ['pending', 'timeout', 'rpc-error'].includes(status)) {
      void retryRecoveryCheckRef.current();
    }
  }, [address, chainId, status, transactionHash]);

  const reset = () => {
    if (inFlight.current || submissionUncertainRef.current) return;
    const resetGeneration = flowGenerationRef.current + 1;
    flowGenerationRef.current = resetGeneration;
    const clearForm = () => {
      setStatus('idle');
      setTransactionHash(undefined);
      setError(null);
      setGasEstimate(null);
      setGasCost(null);
      submittedHash.current = undefined;
      preparedRequest.current = undefined;
    };
    if (address) {
      const saved = readTransactionRecovery(address, 'send');
      if (saved.error) {
        submissionUncertainRef.current = true;
        setSubmissionUncertain(true);
        setStatus('uncertain');
        setError(saved.error);
        return;
      }
      if (saved.record && isRecoveryUnresolved(saved.record.status)) {
        submissionUncertainRef.current = true;
        setSubmissionUncertain(true);
        setStatus(getSendStatus(saved.record.status));
        setTransactionHash(saved.record.transactions[saved.record.transactions.length - 1]?.hash);
        setError(new Error('A Send transaction is still unresolved. Verify wallet activity and the Arc explorer before starting another.'));
        return;
      }
      if (saved.record) {
        if (isRecoveryUnresolved(saved.record.status)) return;
      }
    }
    submissionUncertainRef.current = false;
    setSubmissionUncertain(false);
    clearForm();
  };

  const prepare = async ({ asset, recipient, amount }: SendRequest): Promise<boolean> => {
    if (inFlight.current) return false;
    if (address) {
      const saved = readTransactionRecovery(address, 'send');
      if (saved.error || (saved.record && isRecoveryUnresolved(saved.record.status))) {
        submissionUncertainRef.current = true;
        setSubmissionUncertain(true);
        setStatus(saved.record ? getSendStatus(saved.record.status) : 'uncertain');
        const savedTransactions = saved.record?.transactions ?? [];
        setTransactionHash(savedTransactions[savedTransactions.length - 1]?.hash);
        setError(saved.error ?? new Error('A previous Send transaction is unresolved. Check its saved transaction before sending again.'));
        return false;
      }
    }
    if (submissionUncertainRef.current) {
      setStatus('failed');
      setError(new Error('A previous wallet submission has an unknown outcome. Check wallet activity and the Arc explorer before sending again.'));
      return false;
    }
    if (submittedHash.current) {
      setStatus('failed');
      setError(new Error('A send transaction was already submitted. Check its confirmation before starting another.'));
      return false;
    }
    preparedRequest.current = undefined;
    if (!address) {
      setStatus('failed');
      setError(new Error('Connect your wallet before sending assets'));
      return false;
    }
    if (chainId !== arcTestnet.id) {
      setStatus('failed');
      setError(new Error('Switch to a supported send network before sending assets'));
      return false;
    }
    if (!publicClient) {
      setStatus('failed');
      setError(new Error('Arc Testnet RPC is unavailable'));
      return false;
    }
    if (!isAddress(recipient) || recipient === '0x0000000000000000000000000000000000000000' || recipient.toLowerCase() === address.toLowerCase()) {
      setStatus('failed');
      setError(new Error('Enter a valid recipient address that is not your own wallet'));
      return false;
    }
    if (amount <= 0n) {
      setStatus('failed');
      setError(new Error('Amount must be greater than zero'));
      return false;
    }

    setStatus('preparing');
    setTransactionHash(undefined);
    setError(null);
    setGasEstimate(null);
    setGasCost(null);
    inFlight.current = true;

    try {
      if (chainId === arcTestnet.id && !isArcUsdcAsset(asset)) {
        throw new Error('Arc Send is restricted to the official Arc USDC contract');
      }
      if (asset.chainId !== arcTestnet.id) {
        throw new Error('Send asset metadata does not match Arc Testnet');
      }
      const currentBalance = await publicClient.getBalance({ address });
      if (asset.isNative && amount > currentBalance) {
        throw new Error('Insufficient native balance for this transfer');
      }
      if (!asset.isNative) {
        if (!asset.address) throw new Error('Token contract address is missing');
        const tokenBalance = await publicClient.readContract({
          address: asset.address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [address],
        });
        if (amount > tokenBalance) throw new Error(`Insufficient ${asset.symbol} balance`);
      }
      const gasPrice = await publicClient.getGasPrice();
      const gasLimit = asset.isNative
        ? await publicClient.estimateGas({ account: address, to: recipient, value: amount })
        : await publicClient.estimateGas({
            account: address,
            to: asset.address as Address,
            data: buildErc20TransferData(recipient, amount),
          });
      const requiredNativeForGas = gasLimit * gasPrice;
      setGasEstimate(gasLimit);
      setGasCost(requiredNativeForGas);
      const nativeBalanceAfterSend = currentBalance - (asset.isNative ? amount : 0n);
      if (nativeBalanceAfterSend < requiredNativeForGas) {
        throw new Error('Insufficient native USDC for Arc network gas');
      }

      preparedRequest.current = { asset, recipient, amount, address, gasCost: requiredNativeForGas };
      setStatus('ready');
      return true;
    } catch (caughtError) {
      setStatus(isUserRejectedError(caughtError) ? 'rejected' : 'failed');
      setError(caughtError instanceof Error ? caughtError : new Error('Transaction failed'));
      return false;
    } finally {
      inFlight.current = false;
    }
  };

  const confirm = async ({ asset, recipient, amount }: SendRequest) => {
    const prepared = preparedRequest.current;
    if (!prepared || prepared.asset !== asset || prepared.recipient !== recipient || prepared.amount !== amount) {
      setStatus('failed');
      setError(new Error('Send details changed. Review the transaction again.'));
      return;
    }
    if (submittedHash.current) {
      setStatus('failed');
      setError(new Error('A send transaction was already submitted. Check its confirmation before starting another.'));
      return;
    }
    if (inFlight.current) return;
    if (!address || address.toLowerCase() !== prepared.address.toLowerCase() || chainId !== arcTestnet.id || !publicClient) {
      setStatus('failed');
      setError(new Error('Wallet account or network changed. Review the send again.'));
      return;
    }

    inFlight.current = true;
    setStatus('confirmation');
    setError(null);
    let walletSubmissionAttempted = false;
    let recoveryOperationId: string | undefined;
    let recoveryUpdatedAt: number | undefined;
    try {
      const currentBalance = await publicClient.getBalance({ address });
      if (asset.isNative && amount > currentBalance) throw new Error('Insufficient native balance for this transfer');
      if (!asset.isNative) {
        if (!asset.address) throw new Error('Token contract address is missing');
        const tokenBalance = await publicClient.readContract({
          address: asset.address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [address],
        });
        if (amount > tokenBalance) throw new Error(`Insufficient ${asset.symbol} balance`);
      }
      const gasPrice = await publicClient.getGasPrice();
      const gasLimit = asset.isNative
        ? await publicClient.estimateGas({ account: address, to: recipient, value: amount })
        : await publicClient.estimateGas({
            account: address,
            to: asset.address as Address,
            data: buildErc20TransferData(recipient, amount),
          });
      const requiredNativeForGas = gasLimit * gasPrice;
      if (requiredNativeForGas !== prepared.gasCost) {
        setGasEstimate(gasLimit);
        setGasCost(requiredNativeForGas);
        preparedRequest.current = { ...prepared, gasCost: requiredNativeForGas };
        throw new Error('The estimated fee changed. Review the updated fee and slide to send again.');
      }
      setGasEstimate(gasLimit);
      setGasCost(requiredNativeForGas);
      if (currentBalance - (asset.isNative ? amount : 0n) < requiredNativeForGas) {
        throw new Error('Insufficient native USDC for Arc network gas');
      }

      const claim = await claimTransactionRecovery(address, 'send', [activeChainId]);
      if (claim.error) throw claim.error;
      if (!claim.claimed) {
        submissionUncertainRef.current = true;
        setSubmissionUncertain(true);
        setStatus(claim.record ? getSendStatus(claim.record.status) : 'uncertain');
        const savedTransactions = claim.record?.transactions ?? [];
        setTransactionHash(savedTransactions[savedTransactions.length - 1]?.hash);
        throw new Error('A previous Send transaction is unresolved. Check its saved transaction before sending again.');
      }
      recoveryOperationId = claim.record?.operationId;
      if (!recoveryOperationId) throw new Error('Send recovery operation identity is unavailable.');
      walletSubmissionAttempted = true;
      const hash = asset.isNative
        ? await sendTransactionAsync({ to: recipient, value: amount, chainId: arcTestnet.id })
        : await writeContractAsync({
            address: asset.address as Address,
            abi: erc20Abi,
            functionName: 'transfer',
            args: [recipient, amount],
            chainId: activeChainId,
          });
      submittedHash.current = hash;
      setTransactionHash(hash);
      setStatus('pending');
      const pendingSave = await updateTransactionRecoveryIfCurrent(address, 'send', recoveryOperationId, {
        status: 'pending',
        transactions: [{ chainId: activeChainId, hash, step: 'send' }],
        error: undefined,
      });
      if (pendingSave.error || pendingSave.stale) {
        throw new Error(`Send submitted with hash ${hash}, but its recovery record could not be updated: ${pendingSave.error?.message ?? 'the recovery operation changed'}`);
      }
      recoveryUpdatedAt = pendingSave.record?.updatedAt;
      const receipt = await Promise.race([
        publicClient.waitForTransactionReceipt({ hash }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Transaction confirmation timed out')), RECEIPT_TIMEOUT_MS)),
      ]);
      if (receipt.status !== 'success') {
        const recoverySave = await updateTransactionRecoveryIfCurrent(address, 'send', recoveryOperationId, {
          status: 'reverted',
          error: 'Transaction reverted on Arc Testnet.',
        }, recoveryUpdatedAt);
        if (recoverySave.error) throw recoverySave.error;
        setStatus('reverted');
        submissionUncertainRef.current = false;
        setSubmissionUncertain(false);
        throw new Error('Transaction reverted on Arc Testnet');
      }
      const recoverySave = await updateTransactionRecoveryIfCurrent(address, 'send', recoveryOperationId, {
        status: 'confirmed',
        error: undefined,
      }, recoveryUpdatedAt);
      if (recoverySave.error) throw recoverySave.error;
      submissionUncertainRef.current = false;
      setSubmissionUncertain(false);
      setStatus('confirmed');
      void queryClient.invalidateQueries();
    } catch (caughtError) {
      const rejected = isUserRejectedError(caughtError);
      let recoverySaveError: Error | null = null;
      if (walletSubmissionAttempted && !submittedHash.current) {
        const message = caughtError instanceof Error ? caughtError.message : 'Wallet submission outcome is unknown.';
        const recoverySave = recoveryOperationId
          ? await updateTransactionRecoveryIfCurrent(prepared.address, 'send', recoveryOperationId, {
              status: 'uncertain',
              error: message,
              }, recoveryUpdatedAt)
          : null;
        submissionUncertainRef.current = true;
        setSubmissionUncertain(true);
        if (recoverySave?.record?.transactions.length) {
          setTransactionHash(recoverySave.record.transactions[recoverySave.record.transactions.length - 1]?.hash);
        }
        recoverySaveError = recoverySave?.error ?? (recoverySave?.stale ? new Error('Send recovery changed while the wallet submission outcome was being saved.') : null);
      } else {
        const caught = caughtError instanceof Error ? caughtError : new Error('Transaction failed');
        if (submittedHash.current && address) {
          const result = caught.message === 'Transaction reverted on Arc Testnet'
            ? { status: 'reverted' as const }
            : /timed?\s*out|timeout|deadline exceeded/i.test(caught.message)
              ? { status: 'timeout' as const }
              : { status: 'rpc-error' as const };
          if (recoveryOperationId) {
            const recoverySave = await updateTransactionRecoveryIfCurrent(address, 'send', recoveryOperationId, {
              status: result.status,
              error: caught.message,
            }, recoveryUpdatedAt);
            recoverySaveError = recoverySave.error ?? (recoverySave.stale ? new Error('Send recovery changed while receipt verification was in flight.') : null);
          }
          if (!recoverySaveError) setStatus(result.status === 'reverted' ? 'reverted' : result.status);
          submissionUncertainRef.current = result.status !== 'reverted';
          setSubmissionUncertain(submissionUncertainRef.current);
        }
        setError(recoverySaveError ?? caught);
      }
      if (walletSubmissionAttempted && !submittedHash.current) {
        setError(recoverySaveError ?? new Error('Wallet submission outcome is unknown. Check wallet activity and the Arc explorer before sending again.'));
      }
      if (!submittedHash.current) setStatus(walletSubmissionAttempted ? 'uncertain' : rejected ? 'rejected' : 'failed');
    } finally {
      inFlight.current = false;
    }
  };

  const send = async (request: SendRequest) => {
    if (await prepare(request)) await confirm(request);
  };

  return { prepare, confirm, send, status, transactionHash, error, gasEstimate, gasCost, submissionUncertain, retryRecoveryCheck, reset };
}

import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, usePublicClient, useSendTransaction as useWagmiSendTransaction, useWriteContract } from 'wagmi';
import { arcTestnet } from 'wagmi/chains';
import { encodeFunctionData, erc20Abi, isAddress, type Address, type Hash } from 'viem';
import { ARC_USDC } from '../data/tokens';
import type { BaseAssetConfig } from '../data/tokens';

const RECEIPT_TIMEOUT_MS = 180_000;

export type SendStatus =
  | 'idle'
  | 'preparing'
  | 'confirmation'
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'rejected';

export interface SendRequest {
  asset: BaseAssetConfig;
  recipient: Address;
  amount: bigint;
}

export interface UseSendTransactionResult {
  send: (request: SendRequest) => Promise<void>;
  status: SendStatus;
  transactionHash: Hash | undefined;
  error: Error | null;
  gasEstimate: bigint | null;
  gasCost: bigint | null;
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
    rawAmount = BigInt(0);
    rawAmount = importParseUnits(amount || '0', decimals);
  } catch {
    return `Enter a valid amount with up to ${decimals} decimals.`;
  }
  if (rawAmount <= 0n) return 'Amount must be greater than zero.';
  if (rawAmount > balance) return 'Insufficient token balance.';
  return null;
}

function importParseUnits(value: string, decimals: number): bigint {
  const [whole = '', fraction = ''] = value.trim().split('.');
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > decimals) throw new Error('Invalid amount');
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

export function isUserRejectedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /user rejected|user denied|rejected the request|denied transaction/i.test(message);
}

export function useSendTransaction(): UseSendTransactionResult {
  const { address, chainId } = useAccount();
  const activeChainId = arcTestnet.id;
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { sendTransactionAsync } = useWagmiSendTransaction();
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SendStatus>('idle');
  const [transactionHash, setTransactionHash] = useState<Hash>();
  const [error, setError] = useState<Error | null>(null);
  const [gasEstimate, setGasEstimate] = useState<bigint | null>(null);
  const [gasCost, setGasCost] = useState<bigint | null>(null);
  const inFlight = useRef(false);

  const reset = () => {
    setStatus('idle');
    setTransactionHash(undefined);
    setError(null);
    setGasEstimate(null);
    setGasCost(null);
  };

  const send = async ({ asset, recipient, amount }: SendRequest) => {
    if (!address) {
      setStatus('failed');
      setError(new Error('Connect your wallet before sending assets'));
      return;
    }
    if (chainId !== arcTestnet.id) {
      setStatus('failed');
      setError(new Error('Switch to a supported send network before sending assets'));
      return;
    }
    if (!publicClient) {
      setStatus('failed');
      setError(new Error('Arc Testnet RPC is unavailable'));
      return;
    }
    if (inFlight.current || status === 'preparing' || status === 'confirmation' || status === 'pending') {
      setError(new Error('A send is already in progress'));
      return;
    }
    if (!isAddress(recipient) || recipient === '0x0000000000000000000000000000000000000000' || recipient.toLowerCase() === address.toLowerCase()) {
      setStatus('failed');
      setError(new Error('Enter a valid recipient address that is not your own wallet'));
      return;
    }
    if (amount <= 0n) {
      setStatus('failed');
      setError(new Error('Amount must be greater than zero'));
      return;
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

      setStatus('confirmation');
      const hash = asset.isNative
        ? await sendTransactionAsync({ to: recipient, value: amount, chainId: arcTestnet.id })
        : await writeContractAsync({
            address: asset.address as Address,
            abi: erc20Abi,
            functionName: 'transfer',
            args: [recipient, amount],
            chainId: activeChainId,
          });
      setTransactionHash(hash);
      setStatus('pending');
      const receipt = await Promise.race([
        publicClient.waitForTransactionReceipt({ hash }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Transaction confirmation timed out')), RECEIPT_TIMEOUT_MS)),
      ]);
      if (receipt.status !== 'success') {
        throw new Error('Transaction reverted on Arc Testnet');
      }
      setStatus('confirmed');
      await queryClient.invalidateQueries({ queryKey: ['prices'] });
      await queryClient.invalidateQueries({ queryKey: ['transactions', address, activeChainId] });
      await queryClient.invalidateQueries({ queryKey: ['balance'] });
      await queryClient.invalidateQueries();
    } catch (caughtError) {
      setStatus(isUserRejectedError(caughtError) ? 'rejected' : 'failed');
      setError(caughtError instanceof Error ? caughtError : new Error('Transaction failed'));
    } finally {
      inFlight.current = false;
    }
  };

  return { send, status, transactionHash, error, gasEstimate, gasCost, reset };
}

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, usePublicClient, useSendTransaction as useWagmiSendTransaction, useWriteContract } from 'wagmi';
import { base } from 'wagmi/chains';
import { encodeFunctionData, erc20Abi, type Address, type Hash } from 'viem';
import type { BaseAssetConfig } from '../data/tokens';

export type SendStatus =
  | 'idle'
  | 'preparing'
  | 'confirmation'
  | 'pending'
  | 'confirmed'
  | 'failed';

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
  reset: () => void;
}

export function useSendTransaction(): UseSendTransactionResult {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: base.id });
  const { sendTransactionAsync } = useWagmiSendTransaction();
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SendStatus>('idle');
  const [transactionHash, setTransactionHash] = useState<Hash>();
  const [error, setError] = useState<Error | null>(null);

  const reset = () => {
    setStatus('idle');
    setTransactionHash(undefined);
    setError(null);
  };

  const send = async ({ asset, recipient, amount }: SendRequest) => {
    if (!address) {
      setStatus('failed');
      setError(new Error('Connect your wallet before sending assets'));
      return;
    }
    if (chainId !== base.id) {
      setStatus('failed');
      setError(new Error('Switch to Base before sending assets'));
      return;
    }
    if (!publicClient) {
      setStatus('failed');
      setError(new Error('Base RPC is unavailable'));
      return;
    }
    if (status === 'preparing' || status === 'confirmation' || status === 'pending') {
      setError(new Error('A send is already in progress'));
      return;
    }
    if (!recipient || recipient === '0x0000000000000000000000000000000000000000' || recipient.toLowerCase() === address.toLowerCase()) {
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

    try {
      const currentBalance = await publicClient.getBalance({ address });
      const gasPrice = await publicClient.getGasPrice();
      const gasLimit = asset.isNative
        ? await publicClient.estimateGas({ account: address, to: recipient, value: amount })
        : await publicClient.estimateGas({
            account: address,
            to: asset.address as Address,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'transfer',
              args: [recipient, amount],
            }),
          });
      const requiredNativeForGas = gasLimit * gasPrice;
      const nativeBalanceAfterSend = currentBalance - (asset.isNative ? amount : 0n);
      if (nativeBalanceAfterSend < requiredNativeForGas) {
        throw new Error('Insufficient ETH for this transfer and network gas');
      }

      setStatus('confirmation');
      const hash = asset.isNative
        ? await sendTransactionAsync({ to: recipient, value: amount, chainId: base.id })
        : await writeContractAsync({
            address: asset.address as Address,
            abi: erc20Abi,
            functionName: 'transfer',
            args: [recipient, amount],
            chainId: base.id,
          });
      setTransactionHash(hash);
      setStatus('pending');
      await publicClient.waitForTransactionReceipt({ hash });
      setStatus('confirmed');
      await queryClient.invalidateQueries();
    } catch (caughtError) {
      setStatus('failed');
      setError(caughtError instanceof Error ? caughtError : new Error('Transaction failed'));
    }
  };

  return { send, status, transactionHash, error, reset };
}

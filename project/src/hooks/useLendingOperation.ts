import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
import { base } from 'wagmi/chains';
import type { Hash } from 'viem';
import { AAVE_BASE_POOL, createAaveProvider } from '../services/lending/aave';
import type { LendingAssetConfig, LendingOperation, LendingPosition } from '../types/lending';

export function useLendingOperation(operation: LendingOperation, asset: LendingAssetConfig | undefined, amount: bigint | null, position: LendingPosition | undefined) {
  const { address, chainId } = useAccount();
  const client = usePublicClient({ chainId: base.id });
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'idle' | 'confirmation' | 'pending' | 'confirmed' | 'failed'>('idle');
  const [hash, setHash] = useState<Hash>();
  const [error, setError] = useState<Error | null>(null);
  const execute = async () => {
    setError(null); setHash(undefined);
    if (status === 'confirmation' || status === 'pending') {
      setStatus('failed');
      setError(new Error('A lending transaction is already in progress'));
      return;
    }
    if (!address || chainId !== base.id || !client || !asset || !amount || amount <= 0n || !position) { setStatus('failed'); setError(new Error('Lending data is unavailable or the request is invalid')); return; }
    const current = position.assets.find((item) => item.symbol === asset.symbol);
    if (!current) { setStatus('failed'); setError(new Error('Unsupported lending asset')); return; }
    if ((operation === 'withdraw' && amount > current.supplied) || (operation === 'repay' && amount > current.borrowed)) { setStatus('failed'); setError(new Error(`Amount exceeds current ${operation} position`)); return; }
    if (operation === 'borrow') {
      if (!current.priceBase) { setStatus('failed'); setError(new Error('Borrow oracle price is unavailable')); return; }
      const borrowBaseValue = amount * current.priceBase / 10n ** BigInt(asset.decimals);
      if (borrowBaseValue > position.availableBorrowsBase) { setStatus('failed'); setError(new Error('Borrow amount exceeds available capacity')); return; }
      if (position.totalDebtBase + borrowBaseValue > 0n) {
        const projectedHealth = position.totalCollateralBase * position.currentLiquidationThreshold / (position.totalDebtBase + borrowBaseValue) / 10000n;
        if (projectedHealth < 10n ** 18n) { setStatus('failed'); setError(new Error('Borrow would make the position unhealthy')); return; }
      }
    }
    if (operation === 'withdraw' && position.totalDebtBase > 0n) {
      if (!current.priceBase) { setStatus('failed'); setError(new Error('Withdrawal oracle price is unavailable')); return; }
      const reduction = amount * current.priceBase / 10n ** BigInt(asset.decimals);
      if (reduction >= position.totalCollateralBase) { setStatus('failed'); setError(new Error('Withdrawal would remove all collateral')); return; }
      const projectedHealth = (position.totalCollateralBase - reduction) * position.currentLiquidationThreshold / position.totalDebtBase / 10000n;
      if (projectedHealth < 10n ** 18n) { setStatus('failed'); setError(new Error('Withdrawal would make the position unhealthy')); return; }
    }
    setStatus('confirmation');
    try {
      const provider = createAaveProvider(client);
      const request = provider.encode(operation, asset, amount, address);
      if (request.address !== AAVE_BASE_POOL) throw new Error('Aave Pool target verification failed');
      const txHash = await writeContractAsync({ ...request, chainId: base.id } as never);
      setHash(txHash); setStatus('pending'); await client.waitForTransactionReceipt({ hash: txHash }); setStatus('confirmed'); await queryClient.invalidateQueries();
    } catch (caught) { setStatus('failed'); setError(caught instanceof Error ? caught : new Error(`${operation} transaction failed`)); }
  };
  return { execute, status, hash, error };
}

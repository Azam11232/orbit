import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAccount, usePublicClient, useReadContract, useReadContracts, useSendTransaction, useSignTypedData, useSwitchChain, useWriteContract } from 'wagmi';
import { useState } from 'react';
import { erc20Abi, formatUnits, type Address, type Hex, encodeFunctionData } from 'viem';
import { getOrbitNetwork } from '../data/networks';
import {
  createGatewayTransferSpec,
  createGatewayTypedData,
  estimateGatewayTransfer,
  fetchGatewayBalances,
  gatewayMinterAbi,
  gatewayNetworks,
  gatewayWalletAbi,
  parseGatewayAmount,
  submitGatewayTransfer,
  sumGatewayBalances,
} from '../services/gateway';

export type GatewayOperationState = 'idle' | 'approval' | 'deposit' | 'signing' | 'minting' | 'pending' | 'confirmed' | 'failed';
const RECEIPT_TIMEOUT_MS = 180_000;

async function waitForReceipt(client: ReturnType<typeof usePublicClient>, hash: Hex) {
  if (!client) throw new Error('Selected network RPC is unavailable');
  const receipt = await Promise.race([
    client.waitForTransactionReceipt({ hash }),
    new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Gateway transaction confirmation timed out')), RECEIPT_TIMEOUT_MS)),
  ]);
  if (receipt.status !== 'success') throw new Error('Gateway transaction reverted');
  return receipt;
}

export function useGateway(sourceId: number, destinationId: number) {
  const { address, chainId, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();
  const { signTypedDataAsync } = useSignTypedData();
  const queryClient = useQueryClient();
  const source = getOrbitNetwork(sourceId);
  const destination = getOrbitNetwork(destinationId);
  const sourceClient = usePublicClient({ chainId: sourceId });
  const destinationClient = usePublicClient({ chainId: destinationId });
  const sourceBalance = useReadContract({
    address: source?.usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: sourceId,
    query: { enabled: Boolean(address && isConnected && source?.capabilities.gateway) },
  });
  const sourceAllowance = useReadContract({
    address: source?.usdc,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address && source ? [address, source.gatewayWallet] : undefined,
    chainId: sourceId,
    query: { enabled: Boolean(address && isConnected && chainId === sourceId && source?.capabilities.gateway) },
  });
  const walletBalancesQuery = useReadContracts({
    contracts: gatewayNetworks.map((network) => ({ address: network.usdc, abi: erc20Abi, functionName: 'balanceOf' as const, args: address ? [address] as const : undefined, chainId: network.id })),
    query: { enabled: Boolean(address && isConnected) },
  });
  const balancesQuery = useQuery({
    queryKey: ['gateway-balances', address],
    queryFn: () => fetchGatewayBalances(address as Address),
    enabled: Boolean(address && isConnected),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
  const [depositState, setDepositState] = useState<GatewayOperationState>('idle');
  const [spendState, setSpendState] = useState<GatewayOperationState>('idle');
  const [depositHash, setDepositHash] = useState<Hex>();
  const [mintHash, setMintHash] = useState<Hex>();
  const [error, setError] = useState<Error | null>(null);
  const gatewayBalances = balancesQuery.isError ? [] : balancesQuery.data ?? [];
  const sourceGatewayBalance = gatewayBalances.find((balance) => balance.domain === source?.cctpDomain)?.raw ?? 0n;
  const totalGatewayBalance = sumGatewayBalances(gatewayBalances);
  const busy = depositState === 'approval' || depositState === 'deposit' || depositState === 'pending' || spendState === 'signing' || spendState === 'minting' || spendState === 'pending';

  const deposit = async (amount: string) => {
    setError(null);
    setDepositHash(undefined);
    if (busy) { setError(new Error('A Gateway operation is already in progress')); return; }
    if (!address || !source || !sourceClient) { setDepositState('failed'); setError(new Error('Connect a wallet and select a supported Gateway network')); return; }
    if (chainId !== sourceId) { setDepositState('failed'); setError(new Error(`Switch wallet to ${source.name}`)); return; }
    let rawAmount: bigint;
    try { rawAmount = parseGatewayAmount(amount); } catch { setDepositState('failed'); setError(new Error('Enter a valid USDC amount with up to 6 decimals')); return; }
    if (rawAmount <= 0n) { setDepositState('failed'); setError(new Error('Amount must be greater than zero')); return; }
    if (rawAmount > (sourceBalance.data ?? 0n)) { setDepositState('failed'); setError(new Error('Insufficient source-chain USDC balance')); return; }
    try {
      if ((sourceAllowance.data ?? 0n) < rawAmount) {
        setDepositState('approval');
        const approvalHash = await writeContractAsync({ address: source.usdc, abi: erc20Abi, functionName: 'approve', args: [source.gatewayWallet, rawAmount], chainId: sourceId });
        await waitForReceipt(sourceClient, approvalHash);
      }
      setDepositState('deposit');
      const hash = await writeContractAsync({ address: source.gatewayWallet, abi: gatewayWalletAbi, functionName: 'deposit', args: [source.usdc, rawAmount], chainId: sourceId });
      setDepositHash(hash);
      setDepositState('pending');
      await waitForReceipt(sourceClient, hash);
      setDepositState('confirmed');
      await queryClient.invalidateQueries({ queryKey: ['gateway-balances', address] });
      await queryClient.invalidateQueries({ queryKey: ['balance'] });
    } catch (caughtError) { setDepositState('failed'); setError(caughtError instanceof Error ? caughtError : new Error('Gateway deposit failed')); }
  };

  const spend = async (amount: string) => {
    setError(null);
    setMintHash(undefined);
    if (busy) { setError(new Error('A Gateway operation is already in progress')); return; }
    if (!address || !source || !destination || !destinationClient) { setSpendState('failed'); setError(new Error('Connect a wallet and select supported Gateway networks')); return; }
    if (sourceId === destinationId) { setSpendState('failed'); setError(new Error('Gateway source and destination must differ')); return; }
    let rawAmount: bigint;
    try { rawAmount = parseGatewayAmount(amount); } catch { setSpendState('failed'); setError(new Error('Enter a valid USDC amount with up to 6 decimals')); return; }
    if (rawAmount <= 0n) { setSpendState('failed'); setError(new Error('Amount must be greater than zero')); return; }
    if (rawAmount > sourceGatewayBalance) { setSpendState('failed'); setError(new Error('Insufficient available Gateway balance on the selected source')); return; }
    try {
      setSpendState('signing');
      if (chainId !== sourceId) throw new Error(`Switch wallet to ${source.name} before authorizing a Gateway spend`);
      const spec = createGatewayTransferSpec(sourceId, destinationId, address, rawAmount);
      const estimate = await estimateGatewayTransfer(spec);
      const typedData = createGatewayTypedData(spec, estimate.maxFee, estimate.maxBlockHeight);
      const signature = await signTypedDataAsync(typedData as Parameters<typeof signTypedDataAsync>[0]) as Hex;
      const transfer = await submitGatewayTransfer(spec, estimate.maxFee, estimate.maxBlockHeight, signature);
      await switchChainAsync({ chainId: destinationId });
      setSpendState('minting');
      const hash = await sendTransactionAsync({ to: destination.gatewayMinter, data: encodeFunctionData({ abi: gatewayMinterAbi, functionName: 'gatewayMint', args: [transfer.attestation, transfer.operatorSignature] }), value: 0n, chainId: destinationId });
      setMintHash(hash);
      setSpendState('pending');
      await waitForReceipt(destinationClient, hash);
      setSpendState('confirmed');
      await queryClient.invalidateQueries({ queryKey: ['gateway-balances', address] });
      await queryClient.invalidateQueries({ queryKey: ['balance'] });
    } catch (caughtError) { setSpendState('failed'); setError(caughtError instanceof Error ? caughtError : new Error('Gateway spend failed')); }
  };

  return {
    gatewayNetworks,
    sourceBalance: sourceBalance.data ?? 0n,
    sourceBalanceDisplay: sourceBalance.isFetching
      ? 'Loading...'
      : sourceBalance.isError || sourceBalance.data === undefined
        ? 'Unavailable'
        : `${formatUnits(sourceBalance.data, 6)} USDC`,
    walletBalances: gatewayNetworks.map((network, index) => {
      const result = walletBalancesQuery.data?.[index];
      return {
        network,
        raw: result?.status === 'success' ? result.result : undefined,
        isLoading: walletBalancesQuery.isFetching,
        isError: result?.status === 'failure' || walletBalancesQuery.isError || (!walletBalancesQuery.isFetching && !result),
      };
    }),
    sourceGatewayBalance,
    totalGatewayBalance,
    gatewayBalances,
    hasGatewayBalanceData: gatewayBalances.length > 0,
    isGatewayBalanceLoading: balancesQuery.isLoading,
    isGatewayBalanceError: balancesQuery.isError,
    isBalanceLoading: balancesQuery.isLoading || sourceBalance.isLoading,
    isBalanceError: balancesQuery.isError || sourceBalance.isError,
    isWrongSourceNetwork: Boolean(isConnected && chainId !== sourceId),
    deposit, spend, depositState, spendState, depositHash, mintHash, error, busy,
    refresh: () => queryClient.invalidateQueries({ queryKey: ['gateway-balances', address] }),
  };
}

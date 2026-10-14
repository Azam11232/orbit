import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAccount, usePublicClient, useReadContract, useReadContracts, useSendTransaction, useSignTypedData, useSwitchChain, useWriteContract } from 'wagmi';
import { useEffect, useRef, useState } from 'react';
import { decodeEventLog, erc20Abi, formatUnits, type Address, type EIP1193Provider, type Hex, encodeFunctionData } from 'viem';
import { getOrbitNetwork } from '../data/networks';
import {
  createGatewayTransferSpec,
  createGatewayTypedData,
  estimateGatewayTransfer,
  fetchGatewayBalances,
  gatewayNetworkForDomain,
  gatewayMinterAbi,
  gatewayNetworks,
  gatewayWalletAbi,
  isGatewayTransferRouteValid,
  parseGatewayAmount,
  submitGatewayTransfer,
  sumGatewayBalances,
  sumGatewayPendingBatches,
} from '../services/gateway';
import { watchConfirmedGatewayDeposit, type GatewayDepositPollResult } from '../services/gatewayDepositPolling';
import {
  estimateFastGatewayDeposit,
  executeFastGatewayDeposit,
  FAST_GATEWAY_DEPOSIT_DESTINATION_CHAIN_ID,
  FAST_GATEWAY_DEPOSIT_SOURCE_CHAIN_ID,
  getFastGatewayDepositRoute,
  type FastGatewayDepositEstimate,
} from '../services/gatewayFastDeposit';

export type GatewayOperationState = 'idle' | 'checking' | 'estimating' | 'approval' | 'deposit' | 'signing' | 'minting' | 'pending' | 'relaying' | 'confirmed' | 'failed';
const RECEIPT_TIMEOUT_MS = 180_000;
const FAST_DEPOSIT_QUOTE_MAX_AGE_MS = 30_000;

type DepositPollContext = {
  address: Address;
  domain: number;
  amount: bigint;
  baselineBalance: bigint;
  sourceNetworkName: string;
  gatewayNetworkName: string;
  hash: Hex;
  chainId: number;
  transferSpeed: 'STANDARD' | 'FAST';
};

type DepositAvailability = {
  status: 'waiting' | 'available' | 'timeout';
  networkName: string;
  amount: string;
  transferSpeed: 'STANDARD' | 'FAST';
  checkError?: string;
};

type PreparedFastDeposit = FastGatewayDepositEstimate & {
  account: Address;
  amount: bigint;
  baselineBalance: bigint;
  quotedAt: number;
};

export function verifyGatewayTransactionReceipt(input: {
  status: 'success' | 'reverted';
  to?: string | null;
  expectedTo: Address;
}) {
  return input.status === 'success' && input.to?.toLowerCase() === input.expectedTo.toLowerCase();
}

export async function refetchGatewayBalanceSources(
  refetchWalletBalances: () => Promise<unknown>,
  refetchGatewayBalances: () => Promise<unknown>,
  refetchSelectedWalletBalance: () => Promise<unknown>,
  refetchAllowance: () => Promise<unknown>,
) {
  await Promise.all([
    refetchWalletBalances(),
    refetchGatewayBalances(),
    refetchSelectedWalletBalance(),
    refetchAllowance(),
  ]);
}

export function verifyGatewayMintReceipt(input: {
  status: 'success' | 'reverted';
  to?: string | null;
  expectedMinter: Address;
  expectedToken: Address;
  recipient: Address;
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[];
}) {
  if (!verifyGatewayTransactionReceipt({ status: input.status, to: input.to, expectedTo: input.expectedMinter })) return false;
  return input.logs.some((log) => {
    if (log.address.toLowerCase() !== input.expectedToken.toLowerCase()) return false;
    try {
      const topics = [...log.topics] as [] | [Hex, ...Hex[]];
      const decoded = decodeEventLog({ abi: erc20Abi, data: log.data, topics });
      return decoded.eventName === 'Transfer' &&
        decoded.args.to.toLowerCase() === input.recipient.toLowerCase() &&
        decoded.args.value > 0n;
    } catch {
      return false;
    }
  });
}

export function verifyFastGatewaySourceReceipt(input: {
  status: 'success' | 'reverted';
  to?: string | null;
  expectedMessenger: Address;
  expectedToken: Address;
  depositor: Address;
  minimumAmount: bigint;
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[];
}) {
  if (!verifyGatewayTransactionReceipt({ status: input.status, to: input.to, expectedTo: input.expectedMessenger })) return false;
  return input.logs.some((log) => {
    if (log.address.toLowerCase() !== input.expectedToken.toLowerCase()) return false;
    try {
      const topics = [...log.topics] as [] | [Hex, ...Hex[]];
      const decoded = decodeEventLog({ abi: erc20Abi, data: log.data, topics });
      return decoded.eventName === 'Transfer' &&
        decoded.args.from.toLowerCase() === input.depositor.toLowerCase() &&
        decoded.args.to === '0x0000000000000000000000000000000000000000' &&
        decoded.args.value >= input.minimumAmount;
    } catch {
      return false;
    }
  });
}

export function verifyFastGatewayDestinationReceipt(input: {
  status: 'success' | 'reverted';
  to?: string | null;
  expectedExecutor: Address;
}) {
  return verifyGatewayTransactionReceipt({ status: input.status, to: input.to, expectedTo: input.expectedExecutor });
}

export function isGatewayDepositAvailabilityVerified(transferSpeed: 'STANDARD' | 'FAST', destinationReceiptVerified: boolean) {
  return transferSpeed === 'STANDARD' || destinationReceiptVerified;
}

export function claimGatewayDepositNotification(hash: Hex, notifiedHashes: Set<string>) {
  if (notifiedHashes.has(hash)) return false;
  notifiedHashes.add(hash);
  return true;
}

async function waitForReceipt(client: ReturnType<typeof usePublicClient>, hash: Hex, expectedTo: Address) {
  if (!client) throw new Error('Selected network RPC is unavailable');
  const receipt = await Promise.race([
    client.waitForTransactionReceipt({ hash }),
    new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Gateway transaction confirmation timed out')), RECEIPT_TIMEOUT_MS)),
  ]);
  if (!verifyGatewayTransactionReceipt({ status: receipt.status, to: receipt.to, expectedTo })) {
    throw new Error(receipt.status !== 'success' ? 'Gateway transaction reverted' : 'Gateway receipt did not match the expected contract');
  }
  return receipt;
}

export function useGateway(depositSourceId: number, transferSourceId: number, destinationId: number) {
  const { address, chainId, isConnected, connector } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();
  const { signTypedDataAsync } = useSignTypedData();
  const queryClient = useQueryClient();
  const depositSource = getOrbitNetwork(depositSourceId);
  const transferSource = getOrbitNetwork(transferSourceId);
  const destination = getOrbitNetwork(destinationId);
  const sourceClient = usePublicClient({ chainId: depositSourceId });
  const destinationClient = usePublicClient({ chainId: destinationId });
  const fastDepositDestination = getOrbitNetwork(FAST_GATEWAY_DEPOSIT_DESTINATION_CHAIN_ID);
  const fastDepositDestinationClient = usePublicClient({ chainId: FAST_GATEWAY_DEPOSIT_DESTINATION_CHAIN_ID });
  const sourceBalance = useReadContract({
    address: depositSource?.usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: depositSourceId,
    query: { enabled: Boolean(address && isConnected && depositSource?.capabilities.gateway) },
  });
  const sourceAllowance = useReadContract({
    address: depositSource?.usdc,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address && depositSource ? [address, depositSource.gatewayWallet] : undefined,
    chainId: depositSourceId,
    query: { enabled: Boolean(address && isConnected && chainId === depositSourceId && depositSource?.capabilities.gateway) },
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
  const [depositHashChainId, setDepositHashChainId] = useState<number>();
  const [successNotification, setSuccessNotification] = useState<{
    title: string;
    description: string;
    hash: Hex;
    chainId: number;
    amount: string;
    networkName: string;
    successChimeKey: string;
    additionalTransactions?: { label: string; transactionHash?: string; explorerUrl?: string | null }[];
  } | null>(null);
  const [depositAvailability, setDepositAvailability] = useState<DepositAvailability | null>(null);
  const [fastDepositEstimate, setFastDepositEstimate] = useState<PreparedFastDeposit | null>(null);
  const [fastDestinationHash, setFastDestinationHash] = useState<Hex>();
  const [fastRelayStatus, setFastRelayStatus] = useState<'DONE' | 'PENDING' | 'FAILED'>();
  const [error, setError] = useState<Error | null>(null);
  const [refreshError, setRefreshError] = useState<Error | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshInProgress = useRef(false);
  const depositPollController = useRef<AbortController | null>(null);
  const lastDepositPollContext = useRef<DepositPollContext | null>(null);
  const depositSubmissionInProgress = useRef(false);
  const fastEstimateInProgress = useRef(false);
  const fastQuoteGeneration = useRef(0);
  const fastSourceHashRef = useRef<Hex>();
  const fastSourceReceiptVerifiedRef = useRef(false);
  const fastDestinationReceiptVerifiedRef = useRef(false);
  const depositNotificationHashes = useRef(new Set<string>());
  const gatewayBalances = balancesQuery.isError ? [] : balancesQuery.data ?? [];
  const sourceGatewayBalance = gatewayBalances.find((balance) => balance.domain === transferSource?.cctpDomain)?.raw ?? null;
  const totalGatewayBalance = sumGatewayBalances(gatewayBalances);
  const totalGatewayPendingBatch = sumGatewayPendingBatches(gatewayBalances);
  const busy = depositSubmissionInProgress.current || fastEstimateInProgress.current || depositState === 'checking' || depositState === 'estimating' || depositState === 'approval' || depositState === 'deposit' || depositState === 'pending' || depositState === 'relaying' || spendState === 'signing' || spendState === 'minting' || spendState === 'pending';

  useEffect(() => () => {
    depositPollController.current?.abort();
    depositPollController.current = null;
  }, []);

  useEffect(() => {
    fastQuoteGeneration.current += 1;
    setFastDepositEstimate(null);
  }, [address, chainId, depositSourceId]);

  const refresh = async () => {
    if (refreshInProgress.current) return;
    refreshInProgress.current = true;
    setIsRefreshing(true);
    setRefreshError(null);
    try {
      await refetchGatewayBalanceSources(
        () => walletBalancesQuery.refetch({ throwOnError: true }),
        () => balancesQuery.refetch({ throwOnError: true }),
        () => sourceBalance.refetch({ throwOnError: true }),
        () => sourceAllowance.refetch({ throwOnError: true }),
      );
    } catch (caughtError) {
      setRefreshError(caughtError instanceof Error ? caughtError : new Error('Unable to refresh Gateway and wallet balances'));
    } finally {
      refreshInProgress.current = false;
      setIsRefreshing(false);
    }
  };

  const watchDepositAvailability = (context: DepositPollContext, notifyConfirmed: boolean) => {
    depositPollController.current?.abort();
    const controller = new AbortController();
    depositPollController.current = controller;
    setDepositAvailability({
      status: 'waiting',
      networkName: context.gatewayNetworkName,
      amount: formatUnits(context.amount, 6),
      transferSpeed: context.transferSpeed,
    });
    void watchConfirmedGatewayDeposit({
      onConfirmed: () => {
        if (notifyConfirmed && claimGatewayDepositNotification(context.hash, depositNotificationHashes.current)) {
          setSuccessNotification({
            title: 'Deposit transaction confirmed',
            description: context.transferSpeed === 'STANDARD'
              ? `Your ${formatUnits(context.amount, 6)} USDC deposit is confirmed on ${context.sourceNetworkName}. Circle must wait for source-chain finality before adding it to your available Gateway balance.`
              : `Your ${formatUnits(context.amount, 6)} USDC fast deposit burn is confirmed on ${context.sourceNetworkName}. Circle is relaying it to ${context.gatewayNetworkName}; it is not spendable until Gateway reports it available.`,
            hash: context.hash,
            chainId: context.chainId,
            amount: formatUnits(context.amount, 6),
            networkName: context.sourceNetworkName,
            successChimeKey: `gateway-deposit:${context.hash}`,
          });
        }
      },
      readAvailableBalance: async () => {
        const balances = await fetchGatewayBalances(context.address, controller.signal);
        queryClient.setQueryData(['gateway-balances', context.address], balances);
        const balance = balances.find((entry) => entry.domain === context.domain);
        if (!balance) throw new Error(`Circle did not return a balance for ${context.gatewayNetworkName}`);
        setDepositAvailability((current) => current?.status === 'waiting' && current.checkError
          ? { status: 'waiting', networkName: current.networkName, amount: current.amount, transferSpeed: current.transferSpeed }
          : current);
        if (!isGatewayDepositAvailabilityVerified(context.transferSpeed, fastDestinationReceiptVerifiedRef.current)) {
          return context.baselineBalance;
        }
        return balance.raw;
      },
      baselineBalance: context.baselineBalance,
      depositAmount: context.amount,
      signal: controller.signal,
      ...(context.domain === 26
        ? { timeoutMs: 60_000, initialIntervalMs: 500, maxIntervalMs: 5_000 }
        : {}),
      onReadError: (caughtError) => {
        if (controller.signal.aborted) return;
        setDepositAvailability((current) => current?.status === 'waiting'
          ? { ...current, checkError: caughtError instanceof Error ? caughtError.message : 'Circle balance check failed' }
          : current);
      },
    }).then((result: GatewayDepositPollResult) => {
      if (controller.signal.aborted || depositPollController.current !== controller) return;
      if (result === 'available') {
        setDepositAvailability({
          status: 'available',
          networkName: context.gatewayNetworkName,
          amount: formatUnits(context.amount, 6),
          transferSpeed: context.transferSpeed,
        });
        setDepositState('confirmed');
      } else if (result === 'timeout') {
        setDepositAvailability({
          status: 'timeout',
          networkName: context.gatewayNetworkName,
          amount: formatUnits(context.amount, 6),
          transferSpeed: context.transferSpeed,
        });
      }
      depositPollController.current = null;
    });
  };

  const retryDepositAvailability = () => {
    if (depositAvailability?.status !== 'timeout' || !lastDepositPollContext.current) return;
    watchDepositAvailability(lastDepositPollContext.current, false);
  };

  const clearFastDepositEstimate = () => {
    fastQuoteGeneration.current += 1;
    setFastDepositEstimate(null);
  };

  const prepareFastDeposit = async (amount: string) => {
    setError(null);
    setFastDepositEstimate(null);
    if (fastEstimateInProgress.current || busy || depositSubmissionInProgress.current) return;
    if (!address || !connector || !depositSource || !fastDepositDestination || !gatewayNetworkForDomain(fastDepositDestination.cctpDomain)) {
      setError(new Error('Connect a wallet and select supported Gateway networks'));
      return;
    }
    if (!getFastGatewayDepositRoute(depositSource.cctpDomain, fastDepositDestination.cctpDomain)) {
      setError(new Error('Fast Gateway Deposit is currently supported only from Ethereum Sepolia to Arc Testnet'));
      return;
    }
    if (chainId !== depositSourceId) {
      setError(new Error(`Switch wallet to ${depositSource.name} before preparing a fast deposit`));
      return;
    }
    let rawAmount: bigint;
    try {
      rawAmount = parseGatewayAmount(amount);
    } catch {
      setError(new Error('Enter a valid USDC amount with up to 6 decimals'));
      return;
    }
    if (rawAmount <= 0n || rawAmount > (sourceBalance.data ?? 0n)) {
      setError(new Error(rawAmount <= 0n ? 'Amount must be greater than zero' : 'Insufficient source-chain USDC balance'));
      return;
    }
    fastEstimateInProgress.current = true;
    const quoteGeneration = fastQuoteGeneration.current;
    setDepositState('estimating');
    try {
      const balancesBefore = await fetchGatewayBalances(address);
      queryClient.setQueryData(['gateway-balances', address], balancesBefore);
      const baselineBalance = balancesBefore.find((entry) => entry.domain === fastDepositDestination.cctpDomain)?.raw;
      if (baselineBalance === undefined) throw new Error(`Circle did not return a baseline balance for ${fastDepositDestination.name}`);
      const provider = await connector.getProvider();
      const prepared = await estimateFastGatewayDeposit({
        provider: provider as EIP1193Provider,
        sourceDomain: depositSource.cctpDomain,
        destinationDomain: fastDepositDestination.cctpDomain,
        amount: formatUnits(rawAmount, 6),
      });
      if (quoteGeneration !== fastQuoteGeneration.current) {
        setDepositState('idle');
        return;
      }
      setFastDepositEstimate({
        ...prepared,
        account: address,
        amount: rawAmount,
        baselineBalance,
        quotedAt: Date.now(),
      });
      setDepositState('idle');
    } catch (caughtError) {
      setDepositState('failed');
      setError(caughtError instanceof Error ? caughtError : new Error('Unable to estimate Circle Fast Gateway Deposit'));
    } finally {
      fastEstimateInProgress.current = false;
    }
  };

  const confirmFastDeposit = async (amount: string) => {
    const prepared = fastDepositEstimate;
    setError(null);
    if (!prepared || !address || !connector || !depositSource || !fastDepositDestination || !sourceClient || !fastDepositDestinationClient) {
      setError(new Error('Prepare a valid Fast Gateway Deposit quote before confirming'));
      return;
    }
    if (busy || depositSubmissionInProgress.current) {
      setError(new Error('A Gateway operation is already in progress'));
      return;
    }
    let currentAmount: bigint;
    try {
      currentAmount = parseGatewayAmount(amount);
    } catch {
      setFastDepositEstimate(null);
      setError(new Error('The amount changed or is invalid. Prepare a fresh Fast Gateway Deposit quote.'));
      return;
    }
    if (address.toLowerCase() !== prepared.account.toLowerCase() ||
      depositSourceId !== FAST_GATEWAY_DEPOSIT_SOURCE_CHAIN_ID ||
      fastDepositDestination.id !== FAST_GATEWAY_DEPOSIT_DESTINATION_CHAIN_ID ||
      chainId !== depositSourceId ||
      currentAmount !== prepared.amount ||
      Date.now() - prepared.quotedAt > FAST_DEPOSIT_QUOTE_MAX_AGE_MS) {
      setFastDepositEstimate(null);
      setDepositState('idle');
      setError(new Error('The wallet, route, or fee estimate changed or expired. Prepare a fresh Fast Gateway Deposit quote.'));
      return;
    }
    depositSubmissionInProgress.current = true;
    fastSourceHashRef.current = undefined;
    fastSourceReceiptVerifiedRef.current = false;
    fastDestinationReceiptVerifiedRef.current = false;
    setFastDestinationHash(undefined);
    setFastRelayStatus(undefined);
    setDepositHash(undefined);
    setDepositHashChainId(undefined);
    setSuccessNotification(null);
    setDepositAvailability(null);
    setDepositState('deposit');
    let sourceReceiptPromise: Promise<boolean> | null = null;
    let relayStatus: 'DONE' | 'PENDING' | 'FAILED' | undefined;
    try {
      const provider = await connector.getProvider();
      const result = await executeFastGatewayDeposit({
        provider: provider as EIP1193Provider,
        prepared,
        onTransactionHash: (hash, to) => {
          if (to?.toLowerCase() !== prepared.route.sourceTokenMessengerWithFees.toLowerCase() || fastSourceHashRef.current) return;
          fastSourceHashRef.current = hash;
          setDepositHash(hash);
          setDepositHashChainId(depositSourceId);
          sourceReceiptPromise = waitForReceipt(sourceClient, hash, prepared.route.sourceTokenMessengerWithFees)
            .then((receipt) => {
              const verified = verifyFastGatewaySourceReceipt({
                status: receipt.status,
                to: receipt.to,
                expectedMessenger: prepared.route.sourceTokenMessengerWithFees,
                expectedToken: depositSource.usdc,
                depositor: address,
                minimumAmount: prepared.amount,
                logs: receipt.logs,
              });
              if (!verified) throw new Error('Fast deposit source receipt did not verify the expected USDC burn');
              fastSourceReceiptVerifiedRef.current = true;
              setDepositState('relaying');
              const pollContext: DepositPollContext = {
                address,
                domain: fastDepositDestination.cctpDomain,
                amount: prepared.amount,
                baselineBalance: prepared.baselineBalance,
                sourceNetworkName: depositSource.name,
                gatewayNetworkName: fastDepositDestination.name,
                hash,
                chainId: depositSourceId,
                transferSpeed: 'FAST',
              };
              lastDepositPollContext.current = pollContext;
              watchDepositAvailability(pollContext, true);
              return true;
            })
            .catch((caughtError) => {
              setError(caughtError instanceof Error ? caughtError : new Error('Fast deposit source receipt verification failed'));
              setDepositState('failed');
              throw caughtError;
            });
        },
      });
      if (!sourceReceiptPromise) {
        throw new Error('Circle Fast Deposit did not expose its source transaction for receipt verification. Check the wallet transaction before retrying.');
      }
      if (!await sourceReceiptPromise) throw new Error('Fast deposit source transaction was not confirmed');
      relayStatus = result.progress?.status;
      setFastRelayStatus(relayStatus);
      if (result.progress?.status === 'FAILED') {
        setDepositState('failed');
        setError(new Error('The Sepolia source burn is confirmed, but Circle reported a terminal relay failure. Do not submit another deposit; check the source transaction and contact Circle support.'));
      } else if (result.progress?.status === 'DONE') {
        if (!/^0x[0-9a-fA-F]{64}$/.test(result.txHash)) {
          throw new Error('Circle reported fast relay completion without a valid destination transaction hash');
        }
        const destinationHash = result.txHash as Hex;
        const receipt = await waitForReceipt(fastDepositDestinationClient, destinationHash, prepared.route.destinationGenericExecutor);
        if (!verifyFastGatewayDestinationReceipt({
          status: receipt.status,
          to: receipt.to,
          expectedExecutor: prepared.route.destinationGenericExecutor,
        })) {
          throw new Error('Circle relay receipt did not verify successful execution by the Arc Generic Executor');
        }
        fastDestinationReceiptVerifiedRef.current = true;
        setFastDestinationHash(destinationHash);
        setSuccessNotification((current) => {
          if (!current || current.hash !== fastSourceHashRef.current) return current;
          return {
            ...current,
            description: `Your ${formatUnits(prepared.amount, 6)} USDC source burn is confirmed and Circle's fast relay was verified on ${fastDepositDestination.name}. Gateway availability is still checked separately.`,
            additionalTransactions: [{ label: 'Arc relay transaction', transactionHash: destinationHash, explorerUrl: `${fastDepositDestination.explorerUrl}/tx/${destinationHash}` }],
          };
        });
      }
    } catch (caughtError) {
      if (fastSourceHashRef.current) {
        setDepositState(fastSourceReceiptVerifiedRef.current
          ? relayStatus === 'PENDING' ? 'relaying' : 'failed'
          : 'pending');
      } else {
        setDepositState('failed');
      }
      setError(caughtError instanceof Error ? caughtError : new Error('Fast Gateway Deposit failed'));
    } finally {
      if (fastSourceReceiptVerifiedRef.current || !fastSourceHashRef.current) {
        depositSubmissionInProgress.current = false;
      }
    }
  };

  const deposit = async (amount: string) => {
    setError(null);
    if (busy || depositSubmissionInProgress.current) { setError(new Error('A Gateway operation is already in progress')); return; }
    if (!address || !depositSource || !sourceClient) { setDepositState('failed'); setError(new Error('Connect a wallet and select a supported Gateway network')); return; }
    if (chainId !== depositSourceId) { setDepositState('failed'); setError(new Error(`Switch wallet to ${depositSource.name}`)); return; }
    if (depositAvailability && depositAvailability.status !== 'available') {
      setError(new Error('Wait for the previous confirmed deposit to become available in Gateway before submitting another deposit'));
      return;
    }
    let rawAmount: bigint;
    try { rawAmount = parseGatewayAmount(amount); } catch { setDepositState('failed'); setError(new Error('Enter a valid USDC amount with up to 6 decimals')); return; }
    if (rawAmount <= 0n) { setDepositState('failed'); setError(new Error('Amount must be greater than zero')); return; }
    if (rawAmount > (sourceBalance.data ?? 0n)) { setDepositState('failed'); setError(new Error('Insufficient source-chain USDC balance')); return; }
    depositSubmissionInProgress.current = true;
    setDepositHash(undefined);
    setDepositHashChainId(undefined);
    setSuccessNotification(null);
    setDepositAvailability(null);
    setFastDepositEstimate(null);
    setFastRelayStatus(undefined);
    try {
      setDepositState('checking');
      const balancesBefore = await fetchGatewayBalances(address);
      queryClient.setQueryData(['gateway-balances', address], balancesBefore);
      const baselineBalance = balancesBefore.find((entry) => entry.domain === depositSource.cctpDomain)?.raw;
      if (baselineBalance === undefined) throw new Error(`Circle did not return a balance for ${depositSource.name}`);
      if ((sourceAllowance.data ?? 0n) < rawAmount) {
        setDepositState('approval');
        const approvalHash = await writeContractAsync({ address: depositSource.usdc, abi: erc20Abi, functionName: 'approve', args: [depositSource.gatewayWallet, rawAmount], chainId: depositSourceId });
        await waitForReceipt(sourceClient, approvalHash, depositSource.usdc);
      }
      setDepositState('deposit');
      const hash = await writeContractAsync({ address: depositSource.gatewayWallet, abi: gatewayWalletAbi, functionName: 'deposit', args: [depositSource.usdc, rawAmount], chainId: depositSourceId });
      setDepositHash(hash);
      setDepositHashChainId(depositSourceId);
      setDepositState('pending');
      await waitForReceipt(sourceClient, hash, depositSource.gatewayWallet);
      setDepositState('confirmed');
      const pollContext: DepositPollContext = {
        address,
        domain: depositSource.cctpDomain,
        amount: rawAmount,
        baselineBalance,
        sourceNetworkName: depositSource.name,
        gatewayNetworkName: depositSource.name,
        hash,
        chainId: depositSourceId,
        transferSpeed: 'STANDARD',
      };
      lastDepositPollContext.current = pollContext;
      watchDepositAvailability(pollContext, true);
      setDepositHashChainId(depositSourceId);
      void Promise.all([
        walletBalancesQuery.refetch({ throwOnError: true }),
        sourceBalance.refetch({ throwOnError: true }),
        sourceAllowance.refetch({ throwOnError: true }),
        queryClient.invalidateQueries({ queryKey: ['balance'] }),
      ]).catch((caughtError) => {
        setRefreshError(caughtError instanceof Error ? caughtError : new Error('Unable to refresh wallet balances after deposit'));
      });
    } catch (caughtError) { setDepositState('failed'); setError(caughtError instanceof Error ? caughtError : new Error('Gateway deposit failed')); }
    finally { depositSubmissionInProgress.current = false; }
  };

  const spend = async (amount: string) => {
    setError(null);
    setMintHash(undefined);
    setSuccessNotification(null);
    if (busy) { setError(new Error('A Gateway operation is already in progress')); return; }
    if (!address || !transferSource || !destination || !destinationClient) { setSpendState('failed'); setError(new Error('Connect a wallet and select supported Gateway networks')); return; }
    if (!isGatewayTransferRouteValid(transferSourceId, destinationId)) { setSpendState('failed'); setError(new Error(transferSourceId === destinationId ? 'Gateway source and destination must differ' : 'Gateway does not support this network route')); return; }
    if (sourceGatewayBalance === null) { setSpendState('failed'); setError(new Error('Gateway balance for the selected source is unavailable. Refresh balances before retrying.')); return; }
    let rawAmount: bigint;
    try { rawAmount = parseGatewayAmount(amount); } catch { setSpendState('failed'); setError(new Error('Enter a valid USDC amount with up to 6 decimals')); return; }
    if (rawAmount <= 0n) { setSpendState('failed'); setError(new Error('Amount must be greater than zero')); return; }
    if (rawAmount > sourceGatewayBalance) { setSpendState('failed'); setError(new Error('Insufficient available Gateway balance on the selected source')); return; }
    try {
      setSpendState('signing');
      if (chainId !== transferSourceId) throw new Error(`Switch wallet to ${transferSource.name} before authorizing a Gateway spend`);
      const spec = createGatewayTransferSpec(transferSourceId, destinationId, address, rawAmount);
      const estimate = await estimateGatewayTransfer(spec);
      const typedData = createGatewayTypedData(spec, estimate.maxFee, estimate.maxBlockHeight);
      const signature = await signTypedDataAsync(typedData as Parameters<typeof signTypedDataAsync>[0]) as Hex;
      const transfer = await submitGatewayTransfer(spec, estimate.maxFee, estimate.maxBlockHeight, signature);
      await switchChainAsync({ chainId: destinationId });
      setSpendState('minting');
      const hash = await sendTransactionAsync({ to: destination.gatewayMinter, data: encodeFunctionData({ abi: gatewayMinterAbi, functionName: 'gatewayMint', args: [transfer.attestation, transfer.operatorSignature] }), value: 0n, chainId: destinationId });
      setMintHash(hash);
      setSpendState('pending');
      const receipt = await waitForReceipt(destinationClient, hash, destination.gatewayMinter);
      if (!verifyGatewayMintReceipt({
        status: receipt.status,
        to: receipt.to,
        expectedMinter: destination.gatewayMinter,
        expectedToken: destination.usdc,
        recipient: address,
        logs: receipt.logs,
      })) {
        throw new Error('Destination receipt did not verify a USDC transfer to your wallet. Check the destination transaction before retrying.');
      }
      setSpendState('confirmed');
      setSuccessNotification({
        title: `Transfer complete on ${destination.name}`,
        description: `Your ${formatUnits(rawAmount, 6)} USDC Gateway transfer completed and the destination USDC receipt was verified.`,
        hash,
        chainId: destinationId,
        amount: formatUnits(rawAmount, 6),
        networkName: destination.name,
        successChimeKey: `gateway-transfer:${hash}`,
      });
      await refresh();
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
    totalGatewayPendingBatch,
    gatewayBalances,
    gatewayBalanceError: balancesQuery.error,
    hasGatewayBalanceData: gatewayBalances.length > 0,
    isGatewayBalanceLoading: balancesQuery.isLoading,
    isGatewayBalanceError: balancesQuery.isError,
    isBalanceLoading: balancesQuery.isLoading || sourceBalance.isLoading,
    isBalanceError: balancesQuery.isError || sourceBalance.isError || walletBalancesQuery.isError,
    isWalletBalancesError: walletBalancesQuery.isError,
    isRefreshing,
    refreshError,
    isWrongDepositNetwork: Boolean(isConnected && chainId !== depositSourceId),
    isWrongTransferNetwork: Boolean(isConnected && chainId !== transferSourceId),
    deposit, spend, prepareFastDeposit, confirmFastDeposit, clearFastDepositEstimate,
    depositState, spendState, depositHash, depositHashChainId, mintHash, fastDestinationHash,
    successNotification, clearSuccessNotification: () => setSuccessNotification(null),
    fastDepositEstimate, fastRelayStatus, depositAvailability, retryDepositAvailability, error, busy,
    refresh,
  };
}

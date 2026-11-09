import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAccount, usePublicClient, useReadContract, useReadContracts, useSendTransaction, useSignTypedData, useSwitchChain, useWriteContract } from 'wagmi';
import { useEffect, useRef, useState } from 'react';
import { decodeEventLog, encodeEventTopics, erc20Abi, formatUnits, type Address, type EIP1193Provider, type Hex, encodeFunctionData } from 'viem';
import { getOrbitNetwork } from '../data/networks';
import {
  createGatewayTransferSpec,
  createGatewayTypedData,
  estimateGatewayTransfer,
  fetchGatewayBalances,
  getGatewayBalanceStatus,
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
  claimTransactionRecovery,
  inspectKnownTransactionReceipt,
  isExplicitWalletRejection,
  isRecoveryUnresolved,
  isTransactionRecoveryUnresolved,
  readTransactionRecovery,
  resolveTerminalTransactionRecovery,
  resolveUnsubmittedTransactionRecovery,
  resolveRecoveryContext,
  updateTransactionRecovery,
  updateTransactionRecoveryIfCurrent,
  type RecoverableAction,
  type RecoveryStatus,
} from '../services/transactionRecovery';
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
const GATEWAY_DEPOSIT_RECOVERY_ACTIONS: RecoverableAction[] = ['gateway-deposit', 'gateway-fast-deposit'];
const TRANSFER_EVENT_TOPIC = encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer' })[0];
const DEPOSITED_EVENT_TOPIC = encodeEventTopics({ abi: gatewayWalletAbi, eventName: 'Deposited' })[0];
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

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

type PreparedGatewaySpend = {
  account: Address;
  sourceId: number;
  destinationId: number;
  amount: bigint;
  spec: ReturnType<typeof createGatewayTransferSpec>;
  estimate: Awaited<ReturnType<typeof estimateGatewayTransfer>>;
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
  expectedAmount: bigint;
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[];
}) {
  if (
    input.expectedAmount <= 0n ||
    !verifyGatewayTransactionReceipt({ status: input.status, to: input.to, expectedTo: input.expectedMinter })
  ) return false;
  const transfers: Array<{ from: Address; value: bigint }> = [];
  for (const log of input.logs) {
    if (
      log.address.toLowerCase() !== input.expectedToken.toLowerCase() ||
      log.topics[0]?.toLowerCase() !== TRANSFER_EVENT_TOPIC.toLowerCase()
    ) continue;
    try {
      const topics = [...log.topics] as [] | [Hex, ...Hex[]];
      const decoded = decodeEventLog({ abi: erc20Abi, data: log.data, topics });
      if (decoded.eventName === 'Transfer' && decoded.args.to.toLowerCase() === input.recipient.toLowerCase()) {
        transfers.push({ from: decoded.args.from, value: decoded.args.value });
      }
    } catch {
      return false;
    }
  }
  return transfers.length === 1 &&
    transfers[0].from.toLowerCase() === ZERO_ADDRESS &&
    transfers[0].value === input.expectedAmount;
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
        decoded.args.to === ZERO_ADDRESS &&
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
  expectedWallet: Address;
  expectedToken: Address;
  recipient: Address;
  expectedAmount: bigint;
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[];
}) {
  if (
    input.expectedAmount <= 0n ||
    !verifyGatewayTransactionReceipt({ status: input.status, to: input.to, expectedTo: input.expectedExecutor })
  ) return false;
  const transfers: Array<{ from: Address; value: bigint }> = [];
  for (const log of input.logs) {
    if (
      log.address.toLowerCase() !== input.expectedToken.toLowerCase() ||
      log.topics[0]?.toLowerCase() !== TRANSFER_EVENT_TOPIC.toLowerCase()
    ) continue;
    try {
      const topics = [...log.topics] as [] | [Hex, ...Hex[]];
      const decoded = decodeEventLog({ abi: erc20Abi, data: log.data, topics });
      if (decoded.eventName === 'Transfer' && decoded.args.to.toLowerCase() === input.expectedWallet.toLowerCase()) {
        transfers.push({ from: decoded.args.from, value: decoded.args.value });
      }
    } catch {
      return false;
    }
  }
  const deposits: Array<{ token: Address; depositor: Address; sender: Address; value: bigint }> = [];
  for (const log of input.logs) {
    if (
      log.address.toLowerCase() !== input.expectedWallet.toLowerCase() ||
      log.topics[0]?.toLowerCase() !== DEPOSITED_EVENT_TOPIC.toLowerCase()
    ) continue;
    try {
      const topics = [...log.topics] as [] | [Hex, ...Hex[]];
      const decoded = decodeEventLog({ abi: gatewayWalletAbi, eventName: 'Deposited', data: log.data, topics });
      deposits.push(decoded.args);
    } catch {
      return false;
    }
  }
  return transfers.length === 1 &&
    transfers[0].value === input.expectedAmount &&
    deposits.length === 1 &&
    deposits[0].token.toLowerCase() === input.expectedToken.toLowerCase() &&
    deposits[0].depositor.toLowerCase() === input.recipient.toLowerCase() &&
    deposits[0].sender.toLowerCase() === transfers[0].from.toLowerCase() &&
    deposits[0].value === input.expectedAmount;
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
  const sourceAllowanceRefetch = useRef(sourceAllowance.refetch);
  sourceAllowanceRefetch.current = sourceAllowance.refetch;
  const walletBalancesQuery = useReadContracts({
    contracts: gatewayNetworks.map((network) => ({ address: network.usdc, abi: erc20Abi, functionName: 'balanceOf' as const, args: address ? [address] as const : undefined, chainId: network.id })),
    query: { enabled: Boolean(address && isConnected) },
  });
  const balancesQuery = useQuery({
    queryKey: ['gateway-balances', address],
    queryFn: ({ signal }) => fetchGatewayBalances(address as Address, signal),
    enabled: Boolean(address && isConnected),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
  const isWalletBalancesError = walletBalancesQuery.isError ||
    walletBalancesQuery.data?.some((result) => result.status === 'failure') === true ||
    sourceBalance.isError;
  const [depositState, setDepositState] = useState<GatewayOperationState>('idle');
  const [spendState, setSpendState] = useState<GatewayOperationState>('idle');
  const [spendEstimate, setSpendEstimate] = useState<PreparedGatewaySpend['estimate'] | null>(null);
  const [depositHash, setDepositHash] = useState<Hex>();
  const [depositHashStep, setDepositHashStep] = useState<'approval' | 'deposit' | 'source'>('deposit');
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
  const spendEstimateInProgress = useRef(false);
  const spendSubmissionInProgress = useRef(false);
  const spendSubmissionBlockedRef = useRef(false);
  const preparedSpendRef = useRef<PreparedGatewaySpend>();
  const fastQuoteGeneration = useRef(0);
  const fastSourceHashRef = useRef<Hex>();
  const fastSourceReceiptVerifiedRef = useRef(false);
  const fastDestinationReceiptVerifiedRef = useRef(false);
  const depositNotificationHashes = useRef(new Set<string>());
  const [recoveryStatus, setRecoveryStatus] = useState<Partial<Record<RecoverableAction, RecoveryStatus>>>({});
  const recoveryCheckRef = useRef<() => Promise<void>>(async () => undefined);
  const gatewayBalances = balancesQuery.data ?? [];
  const gatewayBalanceStatus = getGatewayBalanceStatus({
    hasData: gatewayBalances.length > 0,
    isLoading: balancesQuery.isLoading,
    isError: balancesQuery.isError,
  });
  const sourceGatewayBalance = gatewayBalances.find((balance) => balance.domain === transferSource?.cctpDomain)?.raw ?? null;
  const totalGatewayBalance = sumGatewayBalances(gatewayBalances);
  const totalGatewayPendingBatch = sumGatewayPendingBatches(gatewayBalances);
  const hasUnresolvedGatewayDepositRecovery = GATEWAY_DEPOSIT_RECOVERY_ACTIONS.some((action) => {
    const status = recoveryStatus[action];
    return status !== undefined && isRecoveryUnresolved(status);
  });
  const busy = depositSubmissionInProgress.current || fastEstimateInProgress.current || spendEstimateInProgress.current || spendSubmissionInProgress.current || depositState === 'checking' || depositState === 'estimating' || depositState === 'approval' || depositState === 'deposit' || depositState === 'pending' || depositState === 'relaying' || spendState === 'estimating' || spendState === 'signing' || spendState === 'minting' || spendState === 'pending';

  useEffect(() => () => {
    depositPollController.current?.abort();
    depositPollController.current = null;
  }, []);

  useEffect(() => {
    fastQuoteGeneration.current += 1;
    setFastDepositEstimate(null);
  }, [address, chainId, depositSourceId]);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    const recover = async (
      action: RecoverableAction,
      expectedChainIds: number[],
      client: ReturnType<typeof usePublicClient>,
      step: string,
      alternateClient?: ReturnType<typeof usePublicClient>,
    ) => {
      const saved = readTransactionRecovery(address, action);
      if (!saved.record) {
        if (saved.error) {
          setRecoveryStatus((current) => ({ ...current, [action]: 'uncertain' }));
          setError(saved.error);
        }
        return;
      }
      if (resolveRecoveryContext(saved.record, address, expectedChainIds).type !== 'match') {
        const mismatchUnresolved = isTransactionRecoveryUnresolved(saved.record);
        const mismatchStatus = mismatchUnresolved && saved.record.status === 'confirmed'
          ? 'pending'
          : saved.record.status;
        setRecoveryStatus((current) => ({ ...current, [action]: mismatchStatus }));
        setError(new Error(`A saved ${action.replace('gateway-', 'Gateway ')} transaction belongs to a different network route. Verify its wallet activity before submitting again.`));
        return;
      }
      const savedRecoveryUnresolved = isTransactionRecoveryUnresolved(saved.record);
      const visibleRecoveryStatus = savedRecoveryUnresolved && saved.record.status === 'confirmed'
        ? 'pending'
        : saved.record.status;
      setRecoveryStatus((current) => ({ ...current, [action]: visibleRecoveryStatus }));
      const latest = action === 'gateway-fast-deposit'
        ? [...saved.record.transactions].reverse().find((transaction) => transaction.step === 'source' || transaction.step === 'destination')
        : [...saved.record.transactions].reverse().find((transaction) => action === 'gateway-deposit' || transaction.step === step);
      if (action === 'gateway-fast-deposit') {
        const source = saved.record.transactions.find((transaction) => transaction.step === 'source');
        const destinationTransaction = [...saved.record.transactions].reverse().find((transaction) => transaction.step === 'destination');
        setDepositHash(source?.hash);
        setDepositHashChainId(source?.chainId);
        setDepositHashStep('source');
        setFastDestinationHash(destinationTransaction?.hash);
      } else if (latest && action === 'gateway-deposit') {
        setDepositHash(latest.hash);
        setDepositHashChainId(latest.chainId);
        setDepositHashStep(latest.step === 'approval' ? 'approval' : latest.step === 'source' ? 'source' : 'deposit');
      } else if (latest && action === 'gateway-spend') {
        setMintHash(latest.hash);
      }
      if (!savedRecoveryUnresolved) {
        if (action === 'gateway-deposit' && latest?.step === 'deposit' && saved.record.status === 'confirmed') setDepositState('confirmed');
        if (action === 'gateway-deposit' && latest?.step === 'approval' && saved.record.status === 'confirmed') {
          setError(new Error('Gateway approval confirmed, but the deposit was not submitted. Review and confirm the deposit to continue.'));
        }
        if (action === 'gateway-spend' && saved.record.status === 'confirmed') setSpendState('confirmed');
        if ((action === 'gateway-deposit' || action === 'gateway-fast-deposit') && saved.record.status === 'reverted') setDepositState('failed');
        return;
      }
      if (action === 'gateway-spend') spendSubmissionBlockedRef.current = true;
      if (!latest) {
        setError(new Error(`A saved ${action.replace('gateway-', 'Gateway ')} wallet request has no transaction hash. Check wallet activity before retrying.`));
        if (action === 'gateway-spend') setSpendState('failed');
        else setDepositState('failed');
        return;
      }
      if (action === 'gateway-deposit' && depositSubmissionInProgress.current ||
        action === 'gateway-fast-deposit' && depositSubmissionInProgress.current ||
        action === 'gateway-spend' && spendSubmissionInProgress.current) return;
      const receiptClient = alternateClient && latest.chainId === FAST_GATEWAY_DEPOSIT_DESTINATION_CHAIN_ID ? alternateClient : client;
      if (!receiptClient) {
        setError(new Error('The saved Gateway transaction RPC is unavailable. Its outcome remains unresolved.'));
        return;
      }
      const result = await inspectKnownTransactionReceipt(
        async () => receiptClient.getTransactionReceipt({ hash: latest.hash }),
      );
      if (cancelled) return;
      let verified = result.status === 'confirmed';
      if (verified && action === 'gateway-deposit') {
        verified = verifyGatewayTransactionReceipt({
          status: result.receipt!.status,
          to: result.receipt!.to,
          expectedTo: latest.step === 'approval'
            ? depositSource?.usdc ?? '0x0000000000000000000000000000000000000000'
            : depositSource?.gatewayWallet ?? '0x0000000000000000000000000000000000000000',
        });
      } else if (verified && action === 'gateway-fast-deposit' && latest.step === 'source') {
        const route = getFastGatewayDepositRoute(depositSource?.cctpDomain ?? -1, fastDepositDestination?.cctpDomain ?? -1);
        const operation = saved.record.gatewayOperation;
        verified = Boolean(route && operation?.type === 'fast-deposit' && verifyFastGatewaySourceReceipt({
          status: result.receipt!.status,
          to: result.receipt!.to,
          expectedMessenger: route.sourceTokenMessengerWithFees,
          expectedToken: depositSource?.usdc ?? '0x0000000000000000000000000000000000000000',
          depositor: address,
          minimumAmount: BigInt(operation.expectedAmount),
          logs: result.receipt!.logs,
        }));
      } else if (verified && action === 'gateway-fast-deposit' && latest.step === 'destination') {
        const route = getFastGatewayDepositRoute(depositSource?.cctpDomain ?? -1, fastDepositDestination?.cctpDomain ?? -1);
        const operation = saved.record.gatewayOperation;
        verified = Boolean(route && operation?.type === 'fast-deposit' &&
          operation.expectedToken.toLowerCase() === fastDepositDestination?.usdc.toLowerCase() &&
          verifyFastGatewayDestinationReceipt({
            status: result.receipt!.status,
            to: result.receipt!.to,
            expectedExecutor: route.destinationGenericExecutor,
            expectedWallet: route.destinationGatewayWallet,
            expectedToken: operation.expectedToken,
            recipient: operation.recipientAddress,
            expectedAmount: BigInt(operation.expectedAmount),
            logs: result.receipt!.logs,
          }));
      } else if (verified && action === 'gateway-spend') {
        const operation = saved.record.gatewayOperation;
        verified = Boolean(destination && operation?.type === 'spend' &&
          operation.expectedToken.toLowerCase() === destination.usdc.toLowerCase() &&
          operation.recipientAddress.toLowerCase() === address.toLowerCase() &&
          verifyGatewayMintReceipt({
            status: result.receipt!.status,
            to: result.receipt!.to,
            expectedMinter: destination.gatewayMinter,
            expectedToken: operation.expectedToken,
            recipient: operation.recipientAddress,
            expectedAmount: BigInt(operation.expectedAmount),
            logs: result.receipt!.logs,
          }));
      }
      const verifiedDestination = result.status === 'confirmed' && verified &&
        (action === 'gateway-spend' || action === 'gateway-fast-deposit' && latest.step === 'destination');
      const nextStatus: RecoveryStatus = result.status === 'confirmed' && (!verified || action === 'gateway-fast-deposit' && latest.step === 'source') ||
        result.status === 'reverted' && (action === 'gateway-spend' || action === 'gateway-fast-deposit' && latest.step === 'destination')
        ? 'pending'
        : result.status;
      const gatewayOperation = verifiedDestination && saved.record.gatewayOperation
        ? { ...saved.record.gatewayOperation, destinationVerified: true }
        : undefined;
      const message = result.error?.message
        ?? (result.status === 'reverted'
          ? 'The saved Gateway transaction reverted.'
          : result.status === 'confirmed' && action === 'gateway-fast-deposit' && latest.step === 'source'
            ? 'The source burn is confirmed; fast relay and Gateway availability remain unresolved.'
          : result.status === 'confirmed' && !verified
            ? 'The saved Gateway receipt did not verify the expected contract action.'
            : undefined);
      const savedUpdate = await updateTransactionRecoveryIfCurrent(address, action, saved.record.operationId, {
        status: nextStatus,
        error: message,
        ...(gatewayOperation ? { gatewayOperation } : {}),
      }, saved.record.updatedAt);
      if (savedUpdate.stale || savedUpdate.error) {
        setRecoveryStatus((current) => ({ ...current, [action]: savedUpdate.record?.status ?? 'uncertain' }));
        setError(savedUpdate.error ?? new Error('Gateway recovery changed while its receipt was being checked.'));
        return;
      }
      const persistedStatus = savedUpdate.error ? saved.record.status : nextStatus;
      setRecoveryStatus((current) => ({ ...current, [action]: persistedStatus }));
      if (message) setError(new Error(message));
      if (savedUpdate.error) setError(savedUpdate.error);
      if (action === 'gateway-spend' && nextStatus === 'confirmed') spendSubmissionBlockedRef.current = false;
      if (action === 'gateway-deposit' && nextStatus === 'confirmed' && latest.step === 'deposit') setDepositState('confirmed');
      if (action === 'gateway-deposit' && nextStatus === 'confirmed' && latest.step === 'approval') {
        setError(new Error('Gateway approval confirmed, but the deposit was not submitted. Review and confirm the deposit to continue.'));
        void sourceAllowanceRefetch.current();
      }
      if ((action === 'gateway-deposit' || action === 'gateway-fast-deposit') && ['reverted', 'timeout', 'rpc-error', 'uncertain'].includes(nextStatus)) setDepositState('failed');
      if (action === 'gateway-spend' && (nextStatus === 'reverted' || nextStatus === 'rpc-error' || nextStatus === 'timeout' || nextStatus === 'uncertain' || result.status === 'reverted')) setSpendState('failed');
      if ((action === 'gateway-deposit' || action === 'gateway-fast-deposit') && nextStatus === 'pending') setDepositState('pending');
      if (action === 'gateway-spend' && nextStatus === 'pending') setSpendState('pending');
    };
    recoveryCheckRef.current = async () => {
      await Promise.all([
        recover('gateway-deposit', [depositSourceId], sourceClient, 'deposit'),
        recover('gateway-fast-deposit', [FAST_GATEWAY_DEPOSIT_SOURCE_CHAIN_ID, FAST_GATEWAY_DEPOSIT_DESTINATION_CHAIN_ID], sourceClient, 'source', fastDepositDestinationClient),
        recover('gateway-spend', [transferSourceId, destinationId], destinationClient, 'mint'),
      ]);
    };
    void recoveryCheckRef.current();
    return () => { cancelled = true; };
  }, [address, depositSource, depositSourceId, destination, destinationClient, fastDepositDestination, fastDepositDestinationClient, sourceClient, transferSourceId, destinationId]);

  const retryRecoveryCheck = () => recoveryCheckRef.current();

  const manuallyResolveGatewayDepositRecovery = async () => {
    if (!address) return;
    const recoveryError = await resolveTerminalTransactionRecovery(
      address,
      GATEWAY_DEPOSIT_RECOVERY_ACTIONS,
      GATEWAY_DEPOSIT_RECOVERY_ACTIONS,
    );
    if (recoveryError) {
      setError(recoveryError);
      return;
    }
    setRecoveryStatus((current) => ({
      ...current,
      'gateway-deposit': undefined,
      'gateway-fast-deposit': undefined,
    }));
    setDepositState('idle');
    setDepositHash(undefined);
    setDepositHashChainId(undefined);
    setDepositHashStep('deposit');
    setFastDestinationHash(undefined);
    fastSourceHashRef.current = undefined;
    fastSourceReceiptVerifiedRef.current = false;
    fastDestinationReceiptVerifiedRef.current = false;
    setFastRelayStatus(undefined);
    setError(null);
  };

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
      const expectedAmount = parseGatewayAmount(prepared.estimate.amount);
      if (expectedAmount !== rawAmount) {
        throw new Error('Circle Fast Gateway Deposit estimate does not match the requested deposit amount');
      }
      if (quoteGeneration !== fastQuoteGeneration.current) {
        setDepositState('idle');
        return;
      }
      setFastDepositEstimate({
        ...prepared,
        account: address,
        amount: expectedAmount,
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
    const recoveryClaim = await claimTransactionRecovery(address, 'gateway-fast-deposit', [
      FAST_GATEWAY_DEPOSIT_SOURCE_CHAIN_ID,
      FAST_GATEWAY_DEPOSIT_DESTINATION_CHAIN_ID,
    ], GATEWAY_DEPOSIT_RECOVERY_ACTIONS, undefined, {
      type: 'fast-deposit',
      recipientAddress: address,
      expectedToken: fastDepositDestination.usdc,
      expectedAmount: prepared.amount.toString(),
      destinationVerified: false,
    });
    if (recoveryClaim.error || !recoveryClaim.claimed) {
      depositSubmissionInProgress.current = false;
      const blockingRecord = recoveryClaim.record;
      if (blockingRecord) {
        setRecoveryStatus((current) => ({ ...current, [blockingRecord.action]: blockingRecord.status }));
      } else if (recoveryClaim.error) {
        setRecoveryStatus((current) => ({
          ...current,
          'gateway-deposit': 'uncertain',
          'gateway-fast-deposit': 'uncertain',
        }));
      }
      setError(recoveryClaim.error ?? new Error('A previous Fast Gateway Deposit is unresolved. Check its saved transaction before retrying.'));
      return;
    }
    setRecoveryStatus((current) => ({ ...current, 'gateway-fast-deposit': 'wallet-request' }));
    fastSourceHashRef.current = undefined;
    fastSourceReceiptVerifiedRef.current = false;
    fastDestinationReceiptVerifiedRef.current = false;
    setFastDestinationHash(undefined);
    setFastRelayStatus(undefined);
    setDepositHash(undefined);
    setDepositHashStep('source');
    setDepositHashChainId(undefined);
    setSuccessNotification(null);
    setDepositAvailability(null);
    setDepositState('deposit');
    let sourceReceiptPromise: Promise<boolean> | null = null;
    let sourceRecoveryUpdatedAt: number | undefined;
    let relayStatus: 'DONE' | 'PENDING' | 'FAILED' | undefined;
    let walletSubmissionAttempted = false;
    const recoveryOperationId = recoveryClaim.record?.operationId;
    if (!recoveryOperationId) {
      depositSubmissionInProgress.current = false;
      setDepositState('failed');
      setError(new Error('Fast Gateway Deposit recovery operation identity is unavailable.'));
      return;
    }
    try {
      const provider = await connector.getProvider();
      walletSubmissionAttempted = true;
      const result = await executeFastGatewayDeposit({
        provider: provider as EIP1193Provider,
        prepared,
        onTransactionHash: (hash, to) => {
          if (to?.toLowerCase() !== prepared.route.sourceTokenMessengerWithFees.toLowerCase() || fastSourceHashRef.current) return;
          fastSourceHashRef.current = hash;
          setDepositHash(hash);
          setDepositHashChainId(depositSourceId);
          setDepositHashStep('source');
          const recoverySave = updateTransactionRecovery(address, 'gateway-fast-deposit', {
            status: 'pending',
            transactions: [{ chainId: depositSourceId, hash, step: 'source' }],
            error: undefined,
          });
          sourceRecoveryUpdatedAt = recoverySave.record?.updatedAt;
          setRecoveryStatus((current) => ({ ...current, 'gateway-fast-deposit': 'pending' }));
          if (recoverySave.error) throw new Error(`Fast deposit submitted with hash ${hash}, but its recovery record could not be updated: ${recoverySave.error.message}`);
          sourceReceiptPromise = waitForReceipt(sourceClient, hash, prepared.route.sourceTokenMessengerWithFees)
            .then(async (receipt) => {
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
              const recoverySave = await updateTransactionRecoveryIfCurrent(address, 'gateway-fast-deposit', recoveryOperationId!, {
                status: 'pending',
                error: 'Source burn confirmed; fast relay and Gateway availability remain unresolved.',
              }, sourceRecoveryUpdatedAt);
              if (recoverySave.error || recoverySave.stale) {
                throw recoverySave.error ?? new Error('Fast Gateway Deposit recovery changed during source receipt verification.');
              }
              sourceRecoveryUpdatedAt = recoverySave.record?.updatedAt;
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
        const destinationRecoverySave = updateTransactionRecovery(address, 'gateway-fast-deposit', {
          status: 'pending',
          transactions: [
            { chainId: depositSourceId, hash: fastSourceHashRef.current!, step: 'source' },
            { chainId: FAST_GATEWAY_DEPOSIT_DESTINATION_CHAIN_ID, hash: destinationHash, step: 'destination' },
          ],
          error: 'Circle relay transaction is known; exact Gateway credit remains unverified.',
        });
        sourceRecoveryUpdatedAt = destinationRecoverySave.record?.updatedAt;
        if (destinationRecoverySave.error) {
          throw new Error(`Fast deposit destination transaction ${destinationHash} could not be saved for recovery: ${destinationRecoverySave.error.message}`);
        }
        setFastDestinationHash(destinationHash);
        const receipt = await waitForReceipt(fastDepositDestinationClient, destinationHash, prepared.route.destinationGenericExecutor);
        if (!verifyFastGatewayDestinationReceipt({
          status: receipt.status,
          to: receipt.to,
          expectedExecutor: prepared.route.destinationGenericExecutor,
          expectedWallet: prepared.route.destinationGatewayWallet,
          expectedToken: fastDepositDestination.usdc,
          recipient: prepared.account,
          expectedAmount: prepared.amount,
          logs: receipt.logs,
        })) {
          throw new Error('Circle relay receipt did not verify the exact USDC amount credited to your Gateway account');
        }
        fastDestinationReceiptVerifiedRef.current = true;
        const recoverySave = await updateTransactionRecoveryIfCurrent(address, 'gateway-fast-deposit', recoveryOperationId, {
          status: 'confirmed',
          transactions: [
            { chainId: depositSourceId, hash: fastSourceHashRef.current!, step: 'source' },
            { chainId: FAST_GATEWAY_DEPOSIT_DESTINATION_CHAIN_ID, hash: destinationHash, step: 'destination' },
          ],
          gatewayOperation: {
            type: 'fast-deposit',
            recipientAddress: prepared.account,
            expectedToken: fastDepositDestination.usdc,
            expectedAmount: prepared.amount.toString(),
            destinationVerified: true,
          },
          error: undefined,
        }, sourceRecoveryUpdatedAt);
        if (recoverySave.error || recoverySave.stale) throw recoverySave.error ?? new Error('Fast Gateway Deposit recovery changed before final confirmation.');
        setRecoveryStatus((current) => ({ ...current, 'gateway-fast-deposit': 'confirmed' }));
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
      const message = caughtError instanceof Error ? caughtError.message : 'Fast Gateway Deposit failed';
      let recoveryError: Error | null = null;
      if (fastSourceHashRef.current) {
        const status: RecoveryStatus = fastSourceReceiptVerifiedRef.current
          ? 'pending'
          : /reverted/i.test(message)
            ? 'reverted'
            : /timed?\s*out|timeout|deadline exceeded/i.test(message)
              ? 'timeout'
              : 'rpc-error';
        const recoverySave = await updateTransactionRecoveryIfCurrent(
          address,
          'gateway-fast-deposit',
          recoveryOperationId!,
          { status, error: message },
          sourceRecoveryUpdatedAt,
        );
        if (recoverySave.error) recoveryError = recoverySave.error;
        setRecoveryStatus((current) => ({ ...current, 'gateway-fast-deposit': status }));
        setDepositState(fastSourceReceiptVerifiedRef.current
          ? relayStatus === 'PENDING' ? 'relaying' : 'failed'
          : 'pending');
      } else {
        if (walletSubmissionAttempted) {
          const recoverySave = recoveryOperationId
            ? await updateTransactionRecoveryIfCurrent(address, 'gateway-fast-deposit', recoveryOperationId, {
                status: 'uncertain',
                error: message,
              })
            : null;
          if (recoverySave?.error) recoveryError = recoverySave.error;
          setRecoveryStatus((current) => ({
            ...current,
            'gateway-fast-deposit': recoverySave?.record?.status ?? 'uncertain',
          }));
        } else if (recoveryOperationId) {
          recoveryError = await resolveUnsubmittedTransactionRecovery(
            address,
            'gateway-fast-deposit',
            GATEWAY_DEPOSIT_RECOVERY_ACTIONS,
            recoveryOperationId,
          );
          const saved = readTransactionRecovery(address, 'gateway-fast-deposit');
          setRecoveryStatus((current) => ({
            ...current,
            'gateway-fast-deposit': recoveryError ? saved.record?.status ?? 'uncertain' : undefined,
          }));
        }
        setDepositState('failed');
      }
      setError(recoveryError
        ? new Error(`Fast Gateway Deposit recovery could not be safely cleared: ${recoveryError.message}`)
        : caughtError instanceof Error ? caughtError : new Error('Fast Gateway Deposit failed'));
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
    setDepositHashStep('deposit');
    setDepositHashChainId(undefined);
    setSuccessNotification(null);
    setDepositAvailability(null);
    setFastDepositEstimate(null);
    setFastRelayStatus(undefined);
    let activeHash: Hex | undefined;
    let activeRecoveryStep: 'approval' | 'deposit' = 'deposit';
    let approvalReceiptConfirmed = false;
    let walletSubmissionAttempted = false;
    let recoveryClaimed = false;
    let recoveryOperationId: string | undefined;
    let recoveryUpdatedAt: number | undefined;
    try {
      setDepositState('checking');
      const balancesBefore = await fetchGatewayBalances(address);
      queryClient.setQueryData(['gateway-balances', address], balancesBefore);
      const baselineBalance = balancesBefore.find((entry) => entry.domain === depositSource.cctpDomain)?.raw;
      if (baselineBalance === undefined) throw new Error(`Circle did not return a balance for ${depositSource.name}`);
      const recoveryClaim = await claimTransactionRecovery(address, 'gateway-deposit', [depositSourceId], GATEWAY_DEPOSIT_RECOVERY_ACTIONS);
      if (recoveryClaim.error) {
        setRecoveryStatus((current) => ({
          ...current,
          'gateway-deposit': 'uncertain',
          'gateway-fast-deposit': 'uncertain',
        }));
        throw recoveryClaim.error;
      }
      if (!recoveryClaim.claimed) {
        const blockingRecord = recoveryClaim.record;
        if (blockingRecord) {
          setRecoveryStatus((current) => ({ ...current, [blockingRecord.action]: blockingRecord.status }));
        }
        throw new Error('A previous Gateway Deposit is unresolved. Check its saved transaction before retrying.');
      }
      recoveryClaimed = true;
      recoveryOperationId = recoveryClaim.record?.operationId;
      if (!recoveryOperationId) throw new Error('Gateway Deposit recovery operation identity is unavailable.');
      setRecoveryStatus((current) => ({ ...current, 'gateway-deposit': 'wallet-request' }));
      if ((sourceAllowance.data ?? 0n) < rawAmount) {
        activeRecoveryStep = 'approval';
        setDepositState('approval');
        walletSubmissionAttempted = true;
        const approvalHash = await writeContractAsync({ address: depositSource.usdc, abi: erc20Abi, functionName: 'approve', args: [depositSource.gatewayWallet, rawAmount], chainId: depositSourceId });
        activeHash = approvalHash;
        setDepositHash(approvalHash);
        setDepositHashChainId(depositSourceId);
        setDepositHashStep('approval');
        const approvalSave = await updateTransactionRecoveryIfCurrent(address, 'gateway-deposit', recoveryOperationId, {
          status: 'pending',
          transactions: [
            ...(recoveryClaim.record?.transactions ?? []),
            { chainId: depositSourceId, hash: approvalHash, step: 'approval' },
          ],
          error: undefined,
        });
        if (approvalSave.error || approvalSave.stale) throw new Error(`Gateway approval submitted with hash ${approvalHash}, but its recovery record could not be updated: ${approvalSave.error?.message ?? 'the recovery operation changed'}`);
        await waitForReceipt(sourceClient, approvalHash, depositSource.usdc);
        approvalReceiptConfirmed = true;
      }
      const currentRecovery = readTransactionRecovery(address, 'gateway-deposit');
      if (currentRecovery.error || !currentRecovery.record || currentRecovery.record.operationId !== recoveryOperationId) {
        throw currentRecovery.error ?? new Error('Gateway Deposit recovery operation changed before deposit submission.');
      }
      const depositIntent = updateTransactionRecovery(address, 'gateway-deposit', {
        status: 'wallet-request',
        transactions: currentRecovery.record.transactions,
        error: undefined,
      });
      if (depositIntent.error) throw depositIntent.error;
      recoveryUpdatedAt = depositIntent.record?.updatedAt;
      activeRecoveryStep = 'deposit';
      activeHash = undefined;
      walletSubmissionAttempted = false;
      setDepositState('deposit');
      walletSubmissionAttempted = true;
      const hash = await writeContractAsync({ address: depositSource.gatewayWallet, abi: gatewayWalletAbi, functionName: 'deposit', args: [depositSource.usdc, rawAmount], chainId: depositSourceId });
      activeHash = hash;
      setDepositHash(hash);
      setDepositHashChainId(depositSourceId);
      setDepositHashStep('deposit');
      const depositSave = await updateTransactionRecoveryIfCurrent(address, 'gateway-deposit', recoveryOperationId, {
        status: 'pending',
        transactions: [
          ...(readTransactionRecovery(address, 'gateway-deposit').record?.transactions ?? []),
          { chainId: depositSourceId, hash, step: 'deposit' },
        ],
        error: undefined,
      });
      if (depositSave.error || depositSave.stale) throw new Error(`Gateway deposit submitted with hash ${hash}, but its recovery record could not be updated: ${depositSave.error?.message ?? 'the recovery operation changed'}`);
      recoveryUpdatedAt = depositSave.record?.updatedAt;
      setDepositState('pending');
      await waitForReceipt(sourceClient, hash, depositSource.gatewayWallet);
      setDepositState('confirmed');
      const confirmationSave = await updateTransactionRecoveryIfCurrent(address, 'gateway-deposit', recoveryOperationId, {
        status: 'confirmed',
        error: undefined,
      }, recoveryUpdatedAt);
      if (confirmationSave.error || confirmationSave.stale) throw confirmationSave.error ?? new Error('Gateway Deposit recovery operation changed after confirmation.');
      recoveryUpdatedAt = confirmationSave.record?.updatedAt;
      setRecoveryStatus((current) => ({ ...current, 'gateway-deposit': 'confirmed' }));
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
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Gateway deposit failed';
      let recoveryError: Error | null = null;
      if (activeHash) {
        const submittedHash = activeHash;
        const status: RecoveryStatus = activeRecoveryStep === 'approval' && approvalReceiptConfirmed
          ? 'confirmed'
          : /reverted/i.test(message)
            ? 'reverted'
            : /timed?\s*out|timeout|deadline exceeded/i.test(message)
              ? 'timeout'
              : 'rpc-error';
        const saved = readTransactionRecovery(address, 'gateway-deposit');
        const transactions = saved.record?.transactions.some((transaction) =>
          transaction.hash.toLowerCase() === submittedHash.toLowerCase(),
        )
          ? saved.record.transactions
          : [
              ...(saved.record?.transactions ?? []),
              { chainId: depositSourceId, hash: submittedHash, step: activeRecoveryStep },
            ];
        const recoverySave = recoveryOperationId
          ? await updateTransactionRecoveryIfCurrent(address, 'gateway-deposit', recoveryOperationId, {
              status,
              transactions,
              error: `${activeRecoveryStep === 'approval' ? 'Approval' : 'Deposit'}: ${message}`,
            }, saved.record?.updatedAt)
          : null;
        if (recoverySave?.error) recoveryError = recoverySave.error;
        setRecoveryStatus((current) => ({ ...current, 'gateway-deposit': status }));
      } else if (walletSubmissionAttempted && recoveryClaimed) {
        const recoverySave = recoveryOperationId
          ? await updateTransactionRecoveryIfCurrent(address, 'gateway-deposit', recoveryOperationId, { status: 'uncertain', error: message })
          : null;
        if (recoverySave?.error) recoveryError = recoverySave.error;
        setRecoveryStatus((current) => ({ ...current, 'gateway-deposit': 'uncertain' }));
      } else if (recoveryClaimed && recoveryOperationId) {
        recoveryError = await resolveUnsubmittedTransactionRecovery(
          address,
          'gateway-deposit',
          GATEWAY_DEPOSIT_RECOVERY_ACTIONS,
          recoveryOperationId,
        );
        const saved = readTransactionRecovery(address, 'gateway-deposit');
        setRecoveryStatus((current) => ({
          ...current,
          'gateway-deposit': recoveryError ? saved.record?.status ?? 'uncertain' : undefined,
        }));
      }
      setDepositState('failed');
      setError(recoveryError
        ? new Error(`Gateway Deposit recovery could not be safely cleared: ${recoveryError.message}`)
        : caughtError instanceof Error ? caughtError : new Error('Gateway deposit failed'));
    }
    finally { depositSubmissionInProgress.current = false; }
  };

  const prepareSpend = async (amount: string) => {
    setError(null);
    if (busy || spendEstimateInProgress.current) {
      setError(new Error('A Gateway operation is already in progress'));
      return null;
    }
    if (spendSubmissionBlockedRef.current) {
      setError(new Error('A previous Gateway authorization has an uncertain outcome. Check transaction and Gateway activity before starting another transfer.'));
      return null;
    }
    if (!address || !transferSource || !destination) {
      setError(new Error('Connect a wallet and select supported Gateway networks'));
      return null;
    }
    if (!isGatewayTransferRouteValid(transferSourceId, destinationId)) {
      setError(new Error(transferSourceId === destinationId ? 'Gateway source and destination must differ' : 'Gateway does not support this network route'));
      return null;
    }
    if (chainId !== transferSourceId) {
      setError(new Error(`Switch wallet to ${transferSource.name} before authorizing a Gateway spend`));
      return null;
    }
    if (sourceGatewayBalance === null) {
      setError(new Error('Gateway balance for the selected source is unavailable. Refresh balances before retrying.'));
      return null;
    }
    let rawAmount: bigint;
    try { rawAmount = parseGatewayAmount(amount); } catch {
      setError(new Error('Enter a valid USDC amount with up to 6 decimals'));
      return null;
    }
    if (rawAmount <= 0n) {
      setError(new Error('Amount must be greater than zero'));
      return null;
    }
    if (rawAmount > sourceGatewayBalance) {
      setError(new Error('Insufficient available Gateway balance on the selected source'));
      return null;
    }
    spendEstimateInProgress.current = true;
    setSpendState('estimating');
    setSpendEstimate(null);
    preparedSpendRef.current = undefined;
    try {
      const spec = createGatewayTransferSpec(transferSourceId, destinationId, address, rawAmount);
      const estimate = await estimateGatewayTransfer(spec);
      preparedSpendRef.current = {
        account: address,
        sourceId: transferSourceId,
        destinationId,
        amount: rawAmount,
        spec,
        estimate,
        quotedAt: Date.now(),
      };
      setSpendEstimate(estimate);
      setSpendState('idle');
      return estimate;
    } catch (caughtError) {
      setSpendState('failed');
      setError(caughtError instanceof Error ? caughtError : new Error('Unable to estimate Gateway transfer'));
      return null;
    } finally {
      spendEstimateInProgress.current = false;
    }
  };

  const spend = async (amount: string) => {
    setError(null);
    setSuccessNotification(null);
    if (spendSubmissionInProgress.current || busy) {
      setError(new Error('A Gateway operation is already in progress'));
      return;
    }
    if (spendSubmissionBlockedRef.current) {
      setError(new Error('A previous Gateway authorization has an uncertain outcome. Check transaction and Gateway activity before starting another transfer.'));
      return;
    }
    const prepared = preparedSpendRef.current;
    if (!prepared || !address || !transferSource || !destination || !destinationClient) {
      setSpendState('failed');
      setError(new Error('Prepare a valid Gateway transfer estimate before confirming'));
      return;
    }
    let rawAmount: bigint;
    try { rawAmount = parseGatewayAmount(amount); } catch {
      setSpendState('failed');
      setError(new Error('Enter a valid USDC amount with up to 6 decimals'));
      return;
    }
    if (address.toLowerCase() !== prepared.account.toLowerCase() ||
      chainId !== prepared.sourceId ||
      transferSourceId !== prepared.sourceId ||
      destinationId !== prepared.destinationId ||
      rawAmount !== prepared.amount ||
      Date.now() - prepared.quotedAt >= 30_000 ||
      !isGatewayTransferRouteValid(transferSourceId, destinationId)) {
      preparedSpendRef.current = undefined;
      setSpendEstimate(null);
      setSpendState('failed');
      setError(new Error('The wallet, route, amount, or Gateway fee estimate changed or expired. Review and estimate the transfer again.'));
      return;
    }
    if (sourceGatewayBalance === null || rawAmount > sourceGatewayBalance) {
      setSpendState('failed');
      setError(new Error('The available Gateway balance changed. Refresh balances before confirming.'));
      return;
    }
    spendSubmissionInProgress.current = true;
    setMintHash(undefined);
    setSpendState('signing');
    let gatewayTransferSubmitted = false;
    let gatewayTransferSubmissionAttempted = false;
    let walletSignatureRequested = false;
    const recoveryClaim = await claimTransactionRecovery(address, 'gateway-spend', [transferSourceId, destinationId], undefined, undefined, {
      type: 'spend',
      recipientAddress: address,
      expectedToken: destination.usdc,
      expectedAmount: prepared.spec.value.toString(),
      destinationVerified: false,
    });
    if (recoveryClaim.error || !recoveryClaim.claimed) {
      spendSubmissionInProgress.current = false;
      setSpendState('failed');
      setError(recoveryClaim.error ?? new Error('A previous Gateway transfer is unresolved. Check its saved transaction before retrying.'));
      return;
    }
    const recoveryOperationId = recoveryClaim.record?.operationId;
    if (!recoveryOperationId) {
      spendSubmissionInProgress.current = false;
      setSpendState('failed');
      setError(new Error('Gateway spend recovery operation identity is unavailable.'));
      return;
    }
    setRecoveryStatus((current) => ({ ...current, 'gateway-spend': 'wallet-request' }));
    try {
      const typedData = createGatewayTypedData(prepared.spec, prepared.estimate.maxFee, prepared.estimate.maxBlockHeight);
      spendSubmissionBlockedRef.current = true;
      walletSignatureRequested = true;
      const signature = await signTypedDataAsync(typedData as Parameters<typeof signTypedDataAsync>[0]) as Hex;
      gatewayTransferSubmissionAttempted = true;
      const transfer = await submitGatewayTransfer(prepared.spec, prepared.estimate.maxFee, prepared.estimate.maxBlockHeight, signature);
      gatewayTransferSubmitted = true;
      const signatureAcceptedSave = await updateTransactionRecoveryIfCurrent(address, 'gateway-spend', recoveryOperationId, {
        status: 'uncertain',
        error: 'Gateway authorization was accepted; destination mint outcome is unresolved.',
      });
      if (signatureAcceptedSave.error || signatureAcceptedSave.stale) {
        throw signatureAcceptedSave.error ?? new Error('Gateway spend recovery operation changed.');
      }
      await switchChainAsync({ chainId: destinationId });
      setSpendState('minting');
      const hash = await sendTransactionAsync({ to: destination.gatewayMinter, data: encodeFunctionData({ abi: gatewayMinterAbi, functionName: 'gatewayMint', args: [transfer.attestation, transfer.operatorSignature] }), value: 0n, chainId: destinationId });
      setMintHash(hash);
      const recoverySave = await updateTransactionRecoveryIfCurrent(address, 'gateway-spend', recoveryOperationId, {
        status: 'pending',
        transactions: [
          ...(readTransactionRecovery(address, 'gateway-spend').record?.transactions ?? []),
          { chainId: destinationId, hash, step: 'mint' },
        ],
        error: undefined,
      });
      if (recoverySave.error || recoverySave.stale) throw new Error(`Gateway mint submitted with hash ${hash}, but its recovery record could not be updated: ${recoverySave.error?.message ?? 'the recovery operation changed'}`);
      const mintRecoveryUpdatedAt = recoverySave.record?.updatedAt;
      setSpendState('pending');
      const receipt = await waitForReceipt(destinationClient, hash, destination.gatewayMinter);
      if (!verifyGatewayMintReceipt({
        status: receipt.status,
        to: receipt.to,
        expectedMinter: destination.gatewayMinter,
        expectedToken: destination.usdc,
        recipient: address,
        expectedAmount: prepared.spec.value,
        logs: receipt.logs,
      })) {
        throw new Error('Destination receipt did not verify the exact USDC amount minted to your wallet. Check the destination transaction before retrying.');
      }
      const completionSave = await updateTransactionRecoveryIfCurrent(address, 'gateway-spend', recoveryOperationId, {
        status: 'confirmed',
        gatewayOperation: {
          type: 'spend',
          recipientAddress: address,
          expectedToken: destination.usdc,
          expectedAmount: prepared.spec.value.toString(),
          destinationVerified: true,
        },
        error: undefined,
      }, mintRecoveryUpdatedAt);
      if (completionSave.error || completionSave.stale) {
        throw new Error(`Gateway mint was verified, but recovery state could not be saved: ${completionSave.error?.message ?? 'the recovery operation changed'}`);
      }
      setSpendState('confirmed');
      setRecoveryStatus((current) => ({ ...current, 'gateway-spend': 'confirmed' }));
      spendSubmissionBlockedRef.current = false;
      preparedSpendRef.current = undefined;
      setSpendEstimate(null);
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
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : String(caughtError ?? '');
      const savedHash = readTransactionRecovery(address, 'gateway-spend').record?.transactions.slice(-1)[0]?.hash;
      let recoveryError: Error | null = null;
      if (walletSignatureRequested && !gatewayTransferSubmissionAttempted && isExplicitWalletRejection(caughtError)) {
        spendSubmissionBlockedRef.current = false;
        recoveryError = await resolveUnsubmittedTransactionRecovery(address, 'gateway-spend', ['gateway-spend'], recoveryOperationId);
        if (recoveryError) spendSubmissionBlockedRef.current = true;
        setRecoveryStatus((current) => ({ ...current, 'gateway-spend': recoveryError ? 'uncertain' : undefined }));
      } else if (savedHash && /reverted/i.test(message)) {
        const saved = readTransactionRecovery(address, 'gateway-spend');
        const recoverySave = await updateTransactionRecoveryIfCurrent(address, 'gateway-spend', recoveryOperationId, { status: 'pending', error: message }, saved.record?.updatedAt);
        if (recoverySave.error) recoveryError = recoverySave.error;
        setRecoveryStatus((current) => ({ ...current, 'gateway-spend': 'pending' }));
      } else if (savedHash) {
        const status: RecoveryStatus = /timed?\s*out|timeout|deadline exceeded/i.test(message) ? 'timeout' : 'rpc-error';
        const saved = readTransactionRecovery(address, 'gateway-spend');
        const recoverySave = await updateTransactionRecoveryIfCurrent(address, 'gateway-spend', recoveryOperationId, {
          status,
          error: message,
        }, saved.record?.updatedAt);
        if (recoverySave.error) recoveryError = recoverySave.error;
        setRecoveryStatus((current) => ({ ...current, 'gateway-spend': status }));
      } else if (gatewayTransferSubmitted) {
        const saved = readTransactionRecovery(address, 'gateway-spend');
        const recoverySave = await updateTransactionRecoveryIfCurrent(address, 'gateway-spend', recoveryOperationId, { status: 'uncertain', error: message }, saved.record?.updatedAt);
        if (recoverySave.error) recoveryError = recoverySave.error;
        setRecoveryStatus((current) => ({ ...current, 'gateway-spend': 'uncertain' }));
      } else {
        const saved = readTransactionRecovery(address, 'gateway-spend');
        const recoverySave = await updateTransactionRecoveryIfCurrent(address, 'gateway-spend', recoveryOperationId, { status: 'uncertain', error: message }, saved.record?.updatedAt);
        if (recoverySave.error) recoveryError = recoverySave.error;
        setRecoveryStatus((current) => ({ ...current, 'gateway-spend': 'uncertain' }));
      }
      setSpendState('failed');
      setError(recoveryError
        ? new Error(`Wallet rejected the Gateway authorization, but its recovery lock could not be cleared: ${recoveryError.message}`)
        : caughtError instanceof Error ? caughtError : new Error('Gateway spend failed'));
    } finally {
      spendSubmissionInProgress.current = false;
    }
  };

  return {
    gatewayNetworks,
    sourceBalance: sourceBalance.data ?? 0n,
    sourceBalanceDisplay: sourceBalance.isLoading && sourceBalance.data === undefined
      ? 'Loading...'
      : sourceBalance.data === undefined
        ? 'Unavailable'
        : `${formatUnits(sourceBalance.data, 6)} USDC`,
    walletBalances: gatewayNetworks.map((network, index) => {
      const result = walletBalancesQuery.data?.[index];
      return {
        network,
        raw: result?.status === 'success' ? result.result : undefined,
        isLoading: walletBalancesQuery.isLoading && !result,
        isError: result?.status === 'failure' || (!walletBalancesQuery.isFetching && !result),
      };
    }),
    sourceGatewayBalance,
    totalGatewayBalance,
    totalGatewayPendingBatch,
    gatewayBalances,
    gatewayBalanceStatus,
    gatewayBalanceError: balancesQuery.error,
    hasGatewayBalanceData: gatewayBalances.length > 0,
    isGatewayBalanceLoading: balancesQuery.isLoading,
    isGatewayBalanceError: balancesQuery.isError,
    isBalanceLoading: balancesQuery.isLoading || (sourceBalance.isLoading && sourceBalance.data === undefined),
    isBalanceError: balancesQuery.isError || isWalletBalancesError,
    isWalletBalancesError,
    isRefreshing,
    refreshError,
    isWrongDepositNetwork: Boolean(isConnected && chainId !== depositSourceId),
    isWrongTransferNetwork: Boolean(isConnected && chainId !== transferSourceId),
    deposit, spend, prepareSpend, spendEstimate, spendSubmissionBlocked: spendSubmissionBlockedRef.current, prepareFastDeposit, confirmFastDeposit, clearFastDepositEstimate,
    depositState, spendState, depositHash, depositHashChainId, depositHashStep, mintHash, fastDestinationHash,
    successNotification, clearSuccessNotification: () => setSuccessNotification(null),
    fastDepositEstimate, fastRelayStatus, depositAvailability, retryDepositAvailability, error, busy,
    recoveryStatus,
    hasUnresolvedGatewayDepositRecovery,
    manuallyResolveGatewayDepositRecovery,
    hasUnresolvedRecovery: Object.values(recoveryStatus).some((status) => status !== undefined && isRecoveryUnresolved(status)),
    retryRecoveryCheck,
    refresh,
  };
}

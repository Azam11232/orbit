import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2';
import { UnifiedBalanceKit, type EstimateDepositResult } from '@circle-fin/unified-balance-kit';
import { isAddress, type EIP1193Provider } from 'viem';
import { gatewayNetworkForDomain } from './gateway';

const kit = new UnifiedBalanceKit();

export const FAST_GATEWAY_DEPOSIT_SOURCE_CHAIN_ID = 11155111;
export const FAST_GATEWAY_DEPOSIT_DESTINATION_CHAIN_ID = 5042002;
export const FAST_GATEWAY_DEPOSIT_SOURCE_DOMAIN = 0;
export const FAST_GATEWAY_DEPOSIT_DESTINATION_DOMAIN = 26;

export interface FastGatewayDepositRoute {
  sourceChain: 'Ethereum_Sepolia';
  destinationChain: 'Arc_Testnet';
  sourceTokenMessengerWithFees: `0x${string}`;
  destinationGenericExecutor: `0x${string}`;
  destinationGatewayWallet: `0x${string}`;
}

export interface FastGatewayDepositEstimate {
  estimate: EstimateDepositResult;
  route: FastGatewayDepositRoute;
}

export function getFastGatewayDepositRoute(sourceDomain: number, destinationDomain: number): FastGatewayDepositRoute | null {
  if (sourceDomain !== FAST_GATEWAY_DEPOSIT_SOURCE_DOMAIN || destinationDomain !== FAST_GATEWAY_DEPOSIT_DESTINATION_DOMAIN) return null;
  const source = kit.getSupportedChains().find((chain) => chain.chain === 'Ethereum_Sepolia');
  const destination = kit.getSupportedChains().find((chain) => chain.chain === 'Arc_Testnet');
  const sourceGatewayNetwork = gatewayNetworkForDomain(sourceDomain);
  const destinationGatewayNetwork = gatewayNetworkForDomain(destinationDomain);
  const sourceContracts = source?.cctp?.contracts.v2;
  const destinationContracts = destination?.gateway?.contracts.v1;
  const sourceMessenger = sourceContracts?.tokenMessengerWithFees;
  const destinationExecutor = destinationContracts?.genericExecutor;
  const destinationWallet = destinationContracts?.wallet;
  if (
    !source ||
    !destination ||
    !sourceGatewayNetwork ||
    !destinationGatewayNetwork ||
    !sourceMessenger ||
    !destinationExecutor ||
    !destinationWallet ||
    !destinationContracts.depositForHandler ||
    source.gateway?.contracts.v1?.wallet?.toLowerCase() !== sourceGatewayNetwork.gatewayWallet.toLowerCase() ||
    destinationWallet.toLowerCase() !== destinationGatewayNetwork.gatewayWallet.toLowerCase() ||
    !source.cctp?.contracts.v2 ||
    !destination.cctp?.contracts.v2 ||
    !isAddress(sourceMessenger) ||
    !isAddress(destinationExecutor) ||
    !isAddress(destinationWallet)
  ) {
    return null;
  }
  return {
    sourceChain: 'Ethereum_Sepolia',
    destinationChain: 'Arc_Testnet',
    sourceTokenMessengerWithFees: sourceMessenger,
    destinationGenericExecutor: destinationExecutor,
    destinationGatewayWallet: destinationWallet,
  };
}

export async function estimateFastGatewayDeposit(input: {
  provider: EIP1193Provider;
  sourceDomain: number;
  destinationDomain: number;
  amount: string;
}): Promise<FastGatewayDepositEstimate> {
  const route = getFastGatewayDepositRoute(input.sourceDomain, input.destinationDomain);
  if (!route) throw new Error('Circle Fast Gateway Deposit is not supported for this network route');
  const adapter = await createViemAdapterFromProvider({ provider: input.provider });
  const estimate = await kit.estimateDeposit({
    from: { adapter: adapter as unknown as Parameters<typeof kit.estimateDeposit>[0]['from']['adapter'], chain: route.sourceChain },
    amount: input.amount,
    token: 'USDC',
    to: { chain: route.destinationChain },
    config: { transferSpeed: 'FAST' },
  });
  if (!estimate.quote || estimate.fees.length === 0 || estimate.fees.some((fee) => fee.amount === null)) {
    throw new Error('Circle did not return a complete Fast Gateway Deposit fee estimate');
  }
  return { estimate, route };
}

export async function executeFastGatewayDeposit(input: {
  provider: EIP1193Provider;
  prepared: FastGatewayDepositEstimate;
  onTransactionHash: (hash: `0x${string}`, to?: string) => void;
}) {
  const request = new Proxy(input.provider.request, {
    apply: async (target, thisArg, args: unknown[]) => {
      const result: unknown = await Reflect.apply(target, thisArg, args);
      const requestArgs = args[0];
      if (!requestArgs || typeof requestArgs !== 'object' || !('method' in requestArgs) || requestArgs.method !== 'eth_sendTransaction') return result;
      const params = 'params' in requestArgs ? requestArgs.params : undefined;
      const transaction = Array.isArray(params) ? params[0] : undefined;
      const to = transaction && typeof transaction === 'object' && 'to' in transaction && typeof transaction.to === 'string'
        ? transaction.to
        : undefined;
      if (typeof result === 'string' && /^0x[0-9a-fA-F]{64}$/.test(result)) input.onTransactionHash(result as `0x${string}`, to);
      return result;
    },
  });
  const provider = new Proxy(input.provider, {
    get(target, property, receiver) {
      return property === 'request' ? request : Reflect.get(target, property, receiver);
    },
  });
  const adapter = await createViemAdapterFromProvider({ provider });
  return kit.deposit({
    ...input.prepared.estimate,
    from: { adapter: adapter as unknown as Parameters<typeof kit.deposit>[0]['from']['adapter'], chain: input.prepared.route.sourceChain },
  });
}

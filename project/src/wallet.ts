import { coinbaseWallet, injected } from 'wagmi/connectors';
import { createConfig, fallback, http } from 'wagmi';
import { ARC_TESTNET, BASE_SEPOLIA, ETHEREUM_SEPOLIA, ARBITRUM_SEPOLIA, OP_SEPOLIA, AVALANCHE_FUJI, POLYGON_AMOY } from './data/networks';

const walletChains = [ARC_TESTNET, ETHEREUM_SEPOLIA, BASE_SEPOLIA, ARBITRUM_SEPOLIA, OP_SEPOLIA, AVALANCHE_FUJI, POLYGON_AMOY] as const;
export const supportedChains = walletChains;

export function getEthereumSepoliaRpcUrls() {
  return [...ETHEREUM_SEPOLIA.rpcUrls.default.http];
}

export function getRpcReadFailureMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const lower = message.toLowerCase();
  if (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('request took too long') ||
    lower.includes('fetch failed') ||
    lower.includes('network error') ||
    lower.includes('eth_call') ||
    lower.includes('execution reverted') && lower.includes('rpc')
  ) {
    return 'Ethereum Sepolia RPC is temporarily unavailable. Please try again.';
  }
  return message || 'Ethereum Sepolia RPC is temporarily unavailable. Please try again.';
}

export function getPreferredConnector<T extends readonly { id: string }[]>(
  connectors: T,
): T[number] | undefined {
  return (
    connectors.find(
      (connector) => connector.id !== 'injected' && connector.id !== 'coinbaseWallet',
    ) ??
    connectors.find((connector) => connector.id === 'injected') ??
    connectors[0]
  ) as T[number] | undefined;
}

export const walletConfig = createConfig({
  chains: walletChains,
  multiInjectedProviderDiscovery: true,
  connectors: [
    coinbaseWallet({ appName: 'ORBIT' }),
    injected({ shimDisconnect: true }),
  ],
  transports: {
    [ARC_TESTNET.id]: http(ARC_TESTNET.rpcUrls.default.http[0]),
    [ETHEREUM_SEPOLIA.id]: fallback(
      getEthereumSepoliaRpcUrls().map((rpcUrl) => http(rpcUrl, { timeout: 15_000, batch: { wait: 16 } })),
      { retryCount: 1, retryDelay: 250, rank: false },
    ),
    [BASE_SEPOLIA.id]: http(BASE_SEPOLIA.rpcUrls.default.http[0]),
    [ARBITRUM_SEPOLIA.id]: http(ARBITRUM_SEPOLIA.rpcUrls.default.http[0]),
    [OP_SEPOLIA.id]: http(OP_SEPOLIA.rpcUrls.default.http[0]),
    [AVALANCHE_FUJI.id]: http(AVALANCHE_FUJI.rpcUrls.default.http[0]),
    [POLYGON_AMOY.id]: http(POLYGON_AMOY.rpcUrls.default.http[0]),
  },
});

import { coinbaseWallet, injected } from 'wagmi/connectors';
import { createConfig, http } from 'wagmi';
import { ARC_TESTNET, BASE_SEPOLIA, ETHEREUM_SEPOLIA, ARBITRUM_SEPOLIA, OP_SEPOLIA, AVALANCHE_FUJI, POLYGON_AMOY } from './data/networks';

const walletChains = [ARC_TESTNET, ETHEREUM_SEPOLIA, BASE_SEPOLIA, ARBITRUM_SEPOLIA, OP_SEPOLIA, AVALANCHE_FUJI, POLYGON_AMOY] as const;
export const supportedChains = walletChains;

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
    [ETHEREUM_SEPOLIA.id]: http(ETHEREUM_SEPOLIA.rpcUrls.default.http[0]),
    [BASE_SEPOLIA.id]: http(BASE_SEPOLIA.rpcUrls.default.http[0]),
    [ARBITRUM_SEPOLIA.id]: http(ARBITRUM_SEPOLIA.rpcUrls.default.http[0]),
    [OP_SEPOLIA.id]: http(OP_SEPOLIA.rpcUrls.default.http[0]),
    [AVALANCHE_FUJI.id]: http(AVALANCHE_FUJI.rpcUrls.default.http[0]),
    [POLYGON_AMOY.id]: http(POLYGON_AMOY.rpcUrls.default.http[0]),
  },
});

import { coinbaseWallet, injected } from 'wagmi/connectors';
import { createConfig, http } from 'wagmi';
import { arbitrum, base, mainnet, optimism, polygon } from 'wagmi/chains';

export const supportedChains = [base, mainnet, arbitrum, optimism, polygon] as const;

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
  chains: supportedChains,
  multiInjectedProviderDiscovery: true,
  connectors: [
    coinbaseWallet({ appName: 'ORBIT' }),
    injected({ shimDisconnect: true }),
  ],
  transports: {
    [base.id]: http(),
    [mainnet.id]: http(),
    [arbitrum.id]: http(),
    [optimism.id]: http(),
    [polygon.id]: http(),
  },
});

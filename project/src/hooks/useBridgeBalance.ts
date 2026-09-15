import { useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import { formatUnits, type Address } from 'viem';
import type { BridgeToken } from '../types/bridge';
import { getOrbitNetwork } from '../data/networks';

function encodeBalanceOf(address: Address) {
  return `0x70a08231${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

export function useBridgeBalance(token: BridgeToken | undefined, address?: Address, enabled = true) {
  const { chainId, isConnected } = useAccount();
  const isWrongNetwork = Boolean(token && isConnected && address && chainId && chainId !== token.chainId);
  const isDisconnected = Boolean(token && !isConnected);

  const query = useQuery<bigint | null>({
    queryKey: ['bridge-balance-direct', token?.chainId, token?.address, address, token?.isNative, token?.decimals],
    queryFn: async () => {
      if (!token || !address || !enabled) return null;

      const source = getOrbitNetwork(token.chainId);
      if (!source) {
        const msg = `Bridge source network metadata unavailable for chain ${token.chainId}`;
        console.log('[BRIDGE BALANCE DEBUG]', {
          wallet: address,
          connectedChainId: chainId,
          selectedSourceChainId: token.chainId,
          sourceRpc: '',
          usdcContract: token.address,
          balanceOfRaw: 'unavailable',
          balanceFormatted: 'unavailable',
          readError: msg,
        });
        throw new Error(msg);
      }

      const balanceCallData = encodeBalanceOf(address);
      const payload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: token.address, data: balanceCallData }, 'latest'],
      };

      try {
        const response = await fetch(source.rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const msg = `HTTP ${response.status} ${response.statusText}`;
          console.log('[BRIDGE BALANCE DEBUG]', {
            wallet: address,
            connectedChainId: chainId,
            selectedSourceChainId: token.chainId,
            sourceRpc: source.rpcUrl,
            usdcContract: token.address,
            balanceOfRaw: 'unavailable',
            balanceFormatted: 'unavailable',
            readError: msg,
          });
          throw new Error(msg);
        }

        const json = await response.json() as { result?: string; error?: { message?: string } };
        if (json.error?.message) {
          console.log('[BRIDGE BALANCE DEBUG]', {
            wallet: address,
            connectedChainId: chainId,
            selectedSourceChainId: token.chainId,
            sourceRpc: source.rpcUrl,
            usdcContract: token.address,
            balanceOfRaw: 'unavailable',
            balanceFormatted: 'unavailable',
            readError: json.error.message,
          });
          throw new Error(json.error.message);
        }

        const rawHex = json.result;
        const raw = rawHex && rawHex !== '0x' ? BigInt(rawHex) : 0n;
        const formatted = formatUnits(raw, token.decimals);

        console.log('[BRIDGE BALANCE DEBUG]', {
          wallet: address,
          connectedChainId: chainId,
          selectedSourceChainId: token.chainId,
          sourceRpc: source.rpcUrl,
          usdcContract: token.address,
          balanceOfRaw: raw.toString(),
          balanceFormatted: formatted,
          readError: '',
        });

        return raw;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log('[BRIDGE BALANCE DEBUG]', {
          wallet: address,
          connectedChainId: chainId,
          selectedSourceChainId: token.chainId,
          sourceRpc: source?.rpcUrl ?? '',
          usdcContract: token?.address ?? '',
          balanceOfRaw: 'unavailable',
          balanceFormatted: 'unavailable',
          readError: message,
        });
        throw error;
      }
    },
    enabled: Boolean(token && address && enabled),
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: 0,
  });

  const raw = query.data ?? null;

  return {
    raw,
    isLoading: query.isLoading && !isWrongNetwork && !isDisconnected,
    isError: query.isError,
    isWrongNetwork,
    isDisconnected,
    refetch: query.refetch,
  };
}

import { describe, expect, it } from 'vitest';
import { arcTestnet, base, mainnet } from 'wagmi/chains';
import { supportedChains } from './wallet';

describe('bidirectional wallet network architecture', () => {
  it('exposes every supported CCTP testnet to the wallet switcher', () => {
    expect(supportedChains.map((chain) => chain.id)).toEqual([arcTestnet.id, 11155111, 84532, 421614, 11155420, 43113, 80002]);
    expect(supportedChains.map((chain) => chain.id)).not.toContain(base.id);
    expect(supportedChains.map((chain) => chain.id)).not.toContain(mainnet.id);
  });

  it('keeps the verified Arc Testnet identity', () => {
    expect(arcTestnet.id).toBe(5042002);
    expect(arcTestnet.rpcUrls.default.http[0]).toBe('https://rpc.testnet.arc.network');
  });
});
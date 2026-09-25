import { describe, expect, it } from 'vitest';
import { arcTestnet, base, mainnet } from 'wagmi/chains';
import { getEthereumSepoliaRpcUrls, getRpcReadFailureMessage, supportedChains } from './wallet';

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

  it('includes a reliable Ethereum Sepolia fallback RPC list', () => {
    const urls = getEthereumSepoliaRpcUrls();
    expect(urls.length).toBeGreaterThanOrEqual(2);
    expect(urls).toContain('https://ethereum-sepolia-rpc.publicnode.com');
    expect(urls).toContain('https://rpc.sepolia.org');
  });

  it('surfaces truthful RPC unavailability instead of allowance mismatch messaging', () => {
    expect(getRpcReadFailureMessage(new Error('Read contract failed: The request took too long to respond.'))).toBe('Ethereum Sepolia RPC is temporarily unavailable. Please try again.');
    expect(getRpcReadFailureMessage(new Error('network timeout'))).toBe('Ethereum Sepolia RPC is temporarily unavailable. Please try again.');
  });
});
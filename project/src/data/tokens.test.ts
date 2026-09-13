import { describe, expect, it } from 'vitest';
import { ARC_EURC, ARC_SWAP_ASSETS, ARC_USDC } from './tokens';

describe('Arc Swap assets', () => {
  it('uses the verified Arc Testnet USDC and EURC contracts', () => {
    expect(ARC_SWAP_ASSETS.map((asset) => asset.symbol)).toEqual(['USDC', 'EURC']);
    expect(ARC_USDC.address).toBe('0x3600000000000000000000000000000000000000');
    expect(ARC_EURC.address).toBe('0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a');
    expect(ARC_SWAP_ASSETS.every((asset) => asset.chainId === 5042002 && asset.decimals === 6)).toBe(true);
  });

  it('does not invent an address for the currently unverified cirBTC asset', () => {
    expect(ARC_SWAP_ASSETS.some((asset) => asset.symbol === 'cirBTC')).toBe(false);
  });
});

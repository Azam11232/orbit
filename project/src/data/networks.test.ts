import { describe, expect, it } from 'vitest';
import { CCTP_BRIDGE_NETWORKS, ORBIT_NETWORKS } from './networks';

describe('network logo registry', () => {
  it('has a distinct SVG logo for every active Arc/CCTP network', () => {
    expect(CCTP_BRIDGE_NETWORKS).toHaveLength(7);
    expect(CCTP_BRIDGE_NETWORKS.every((network) => network.logo.length > 0)).toBe(true);
    expect(new Set(CCTP_BRIDGE_NETWORKS.map((network) => network.logo)).size).toBe(7);
    expect(new Set(CCTP_BRIDGE_NETWORKS.map((network) => network.id)).size).toBe(7);
    expect(CCTP_BRIDGE_NETWORKS.every((network) => network.logo.endsWith('.svg'))).toBe(true);
    expect(ORBIT_NETWORKS).toHaveLength(7);
    expect(ORBIT_NETWORKS.every((network) => network.logo.length > 0)).toBe(true);
    expect(new Set(ORBIT_NETWORKS.map((network) => network.logo)).size).toBe(7);
    expect(new Set(ORBIT_NETWORKS.map((network) => network.id)).size).toBe(7);
    expect(ORBIT_NETWORKS.every((network) => network.logo.endsWith('.svg'))).toBe(true);
    // Arc is available in ORBIT_NETWORKS
    expect(ORBIT_NETWORKS.find((network) => network.shortName === 'Arc')?.cctpDomain).toBe(26);
    expect(ORBIT_NETWORKS.find((network) => network.shortName === 'Arc')?.usdc).toBe('0x3600000000000000000000000000000000000000');
  });

  it('keeps the official CCTP testnet domains and USDC addresses', () => {
    const expected = new Map<number, readonly [number, string]>([
      [5042002, [26, '0x3600000000000000000000000000000000000000']],
      [11155111, [0, '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238']],
      [84532, [6, '0x036CbD53842c5426634e7929541eC2318f3dCF7e']],
      [421614, [3, '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d']],
      [11155420, [2, '0x5fd84259d66Cd46123540766Be93DFE6D43130D7']],
      [43113, [1, '0x5425890298aed601595a70AB815c96711a31Bc65']],
      [80002, [7, '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582']],
    ] as const);
    for (const network of ORBIT_NETWORKS) {
      expect([network.cctpDomain, network.usdc]).toEqual(expected.get(network.id));
      expect(network.tokenMessengerV2).toBe('0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA');
      expect(network.messageTransmitterV2).toBe('0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275');
    }
  });
});

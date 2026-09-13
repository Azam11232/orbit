import { describe, expect, it } from 'vitest';
import { ARC_PRIMARY_NETWORK, ORBIT_NETWORKS, getOrbitNetwork } from '../data/networks';
import { createGatewayTransferSpec, gatewayNetworks, parseGatewayAmount, sumGatewayBalances } from './gateway';

describe('Circle Gateway registry and accounting', () => {
  it('marks the verified EVM testnets as Gateway-supported', () => {
    expect(gatewayNetworks).toHaveLength(7);
    expect(gatewayNetworks.every((network) => network.capabilities.gateway)).toBe(true);
    expect(ARC_PRIMARY_NETWORK.gatewayWallet).toBe('0x0077777d7EBA4688BDeF3E311b846F25870A19B9');
    expect(ARC_PRIMARY_NETWORK.gatewayMinter).toBe('0x0022222ABE238Cc2C7Bb1f21003F0a260052475B');
  });

  it('keeps USDC amounts exact at six decimals', () => {
    expect(parseGatewayAmount('1.000001')).toBe(1_000_001n);
    expect(parseGatewayAmount('9007199254.740993')).toBe(9_007_199_254_740_993n);
    expect(sumGatewayBalances([{ domain: 26, raw: 400_000_000n, formatted: '400' }, { domain: 6, raw: 300_000_000n, formatted: '300' }])).toBe(700_000_000n);
  });

  it('builds a verified source/destination transfer spec', () => {
    const base = getOrbitNetwork(84532)!;
    const spec = createGatewayTransferSpec(ARC_PRIMARY_NETWORK.id, base.id, '0x0000000000000000000000000000000000000001', 1_000_000n);
    expect(spec.sourceDomain).toBe(26);
    expect(spec.destinationDomain).toBe(6);
    expect(spec.sourceContract).toBe(`0x${ARC_PRIMARY_NETWORK.gatewayWallet.slice(2).padStart(64, '0')}`);
    expect(spec.destinationContract).toBe(`0x${base.gatewayMinter.slice(2).padStart(64, '0')}`);
    expect(spec.value).toBe(1_000_000n);
  });

  it('rejects same-network Gateway spends', () => {
    expect(() => createGatewayTransferSpec(ARC_PRIMARY_NETWORK.id, ARC_PRIMARY_NETWORK.id, '0x0000000000000000000000000000000000000001', 1n)).toThrow('must differ');
  });

  it('keeps Gateway capability separate from CCTP-only capability flags', () => {
    expect(ORBIT_NETWORKS.every((network) => network.capabilities.cctpSource && network.capabilities.cctpDestination)).toBe(true);
    expect(ORBIT_NETWORKS.find((network) => network.id === ARC_PRIMARY_NETWORK.id)?.capabilities.swap).toBe(true);
  });
});

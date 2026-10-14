import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARC_PRIMARY_NETWORK, ETHEREUM_SEPOLIA, ORBIT_NETWORKS, getOrbitNetwork } from '../data/networks';
import type { Address } from 'viem';
import { createGatewayTransferSpec, estimateGatewayTransfer, fetchGatewayBalances, gatewayNetworkForDomain, gatewayNetworks, isGatewayTransferRouteValid, parseGatewayAmount, sumGatewayBalances, sumGatewayPendingBatches } from './gateway';

afterEach(() => {
  vi.unstubAllGlobals();
});

const testDepositor = '0x0000000000000000000000000000000000000001' as Address;

function gatewayBalancesResponse(overrides: Record<number, string> = {}) {
  return {
    token: 'USDC',
    balances: gatewayNetworks.map((network) => ({
      domain: network.cctpDomain,
      depositor: testDepositor,
      balance: overrides[network.cctpDomain] ?? '0',
      pendingBatch: '0',
    })),
  };
}

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
    const balances = [
      { domain: 26, raw: 400_000_000n, formatted: '400', pendingBatchRaw: 60_000n, pendingBatchFormatted: '0.06' },
      { domain: 6, raw: 300_000_000n, formatted: '300', pendingBatchRaw: 0n, pendingBatchFormatted: '0' },
    ];
    expect(sumGatewayBalances(balances)).toBe(700_000_000n);
    expect(sumGatewayPendingBatches(balances)).toBe(60_000n);
  });

  it('accepts a successfully returned zero balance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => gatewayBalancesResponse(),
    }));
    const balances = await fetchGatewayBalances(testDepositor);
    expect(balances).toHaveLength(gatewayNetworks.length);
    expect(balances.find((balance) => balance.domain === 26)).toEqual({
      domain: 26,
      raw: 0n,
      formatted: '0',
      pendingBatchRaw: 0n,
      pendingBatchFormatted: '0',
    });
  });

  it('rejects malformed balance entries rather than returning a partial total', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        token: 'USDC',
        balances: [
          { domain: 26, depositor: testDepositor, balance: '1', pendingBatch: '0' },
          { domain: 0, depositor: testDepositor, balance: 'not-a-number', pendingBatch: '0' },
        ],
      }),
    }));
    await expect(fetchGatewayBalances(testDepositor))
      .rejects.toThrow('invalid balance amount');
  });

  it('maps the Circle Sepolia domain to Ethereum Sepolia and keeps confirmed Gateway funds separate', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        token: 'USDC',
        balances: gatewayNetworks.map((network) => ({
          domain: network.cctpDomain,
          depositor: testDepositor,
          balance: network.cctpDomain === 0 ? '8' : network.cctpDomain === 26 ? '1.25' : '0',
          pendingBatch: network.cctpDomain === 0 ? '0.5' : '0',
        })),
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const balances = await fetchGatewayBalances(testDepositor);
    const sepolia = balances.find((balance) => balance.domain === 0);
    expect(gatewayNetworkForDomain(sepolia!.domain)?.id).toBe(ETHEREUM_SEPOLIA.id);
    expect(sepolia).toEqual({
      domain: 0,
      raw: 8_000_000n,
      formatted: '8',
      pendingBatchRaw: 500_000n,
      pendingBatchFormatted: '0.5',
    });
    expect(balances.find((balance) => balance.domain === 26)?.raw).toBe(1_250_000n);
    const request = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { sources: Array<{ domain: number; depositor: string }> };
    expect(request.sources).toContainEqual({ domain: 0, depositor: testDepositor });
  });

  it('rejects a successful but incomplete response instead of treating missing networks as zero', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        token: 'USDC',
        balances: [{ domain: 26, depositor: testDepositor, balance: '0', pendingBatch: '0' }],
      }),
    }));
    await expect(fetchGatewayBalances(testDepositor)).rejects.toThrow('missing one or more requested source networks');
  });

  it('rejects balances returned for a different depositor or token', async () => {
    const wrongDepositor = gatewayBalancesResponse();
    wrongDepositor.balances[0].depositor = '0x0000000000000000000000000000000000000002';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => wrongDepositor }));
    await expect(fetchGatewayBalances(testDepositor)).rejects.toThrow('invalid balance entry');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...gatewayBalancesResponse(), token: 'EURC' }) }));
    await expect(fetchGatewayBalances(testDepositor)).rejects.toThrow('did not confirm the USDC token');
  });

  it('surfaces Gateway balance API failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(fetchGatewayBalances(testDepositor)).rejects.toThrow('Gateway balance request failed (503)');
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

  it('builds the supported Ethereum Sepolia to Arc Testnet Gateway route', () => {
    expect(isGatewayTransferRouteValid(ETHEREUM_SEPOLIA.id, ARC_PRIMARY_NETWORK.id)).toBe(true);
    const sepolia = getOrbitNetwork(ETHEREUM_SEPOLIA.id)!;
    const spec = createGatewayTransferSpec(ETHEREUM_SEPOLIA.id, ARC_PRIMARY_NETWORK.id, '0x0000000000000000000000000000000000000001', 2_000_000n);
    expect(spec.sourceDomain).toBe(0);
    expect(spec.destinationDomain).toBe(26);
    expect(spec.sourceContract).toBe(`0x${sepolia.gatewayWallet.slice(2).padStart(64, '0')}`);
    expect(spec.destinationContract).toBe(`0x${ARC_PRIMARY_NETWORK.gatewayMinter.slice(2).padStart(64, '0')}`);
    expect(spec.sourceToken).toBe(`0x${sepolia.usdc.slice(2).padStart(64, '0')}`);
    expect(spec.destinationToken).toBe(`0x${ARC_PRIMARY_NETWORK.usdc.slice(2).padStart(64, '0')}`);
    expect(spec.value).toBe(2_000_000n);
  });

  it('parses transfer limits from Circle’s top-level estimate response array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{
        burnIntent: {
          maxFee: '1100000',
          maxBlockHeight: '11948366',
          spec: {},
        },
      }],
    }));
    const spec = createGatewayTransferSpec(ETHEREUM_SEPOLIA.id, ARC_PRIMARY_NETWORK.id, '0x0000000000000000000000000000000000000001', 2_000_000n);
    await expect(estimateGatewayTransfer(spec)).resolves.toMatchObject({
      maxFee: 1_100_000n,
      maxBlockHeight: 11_948_366n,
      fee: null,
      feeToken: 'USDC',
    });
  });

  it.each([
    ['maxFee', [{ burnIntent: { maxBlockHeight: '11948366' } }]],
    ['maxBlockHeight', [{ burnIntent: { maxFee: '1100000' } }]],
    ['response shape', { body: [{ burnIntent: { maxFee: '1100000', maxBlockHeight: '11948366' } }] }],
  ])('fails closed when Circle omits valid estimate %s', async (_field, payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => payload }));
    const spec = createGatewayTransferSpec(ETHEREUM_SEPOLIA.id, ARC_PRIMARY_NETWORK.id, '0x0000000000000000000000000000000000000001', 2_000_000n);
    await expect(estimateGatewayTransfer(spec)).rejects.toThrow('missing valid burnIntent.maxFee or burnIntent.maxBlockHeight');
  });

  it('surfaces Gateway estimate API failures before any transfer can be authorized', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal('fetch', fetchMock);
    const spec = createGatewayTransferSpec(ETHEREUM_SEPOLIA.id, ARC_PRIMARY_NETWORK.id, '0x0000000000000000000000000000000000000001', 2_000_000n);
    await expect(estimateGatewayTransfer(spec)).rejects.toThrow('Gateway estimate failed (503)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects same-network Gateway spends', () => {
    expect(isGatewayTransferRouteValid(ARC_PRIMARY_NETWORK.id, ARC_PRIMARY_NETWORK.id)).toBe(false);
    expect(isGatewayTransferRouteValid(ARC_PRIMARY_NETWORK.id, 84532)).toBe(true);
    expect(() => createGatewayTransferSpec(ARC_PRIMARY_NETWORK.id, ARC_PRIMARY_NETWORK.id, '0x0000000000000000000000000000000000000001', 1n)).toThrow('must differ');
  });

  it('rejects routes outside the verified Gateway network set', () => {
    expect(isGatewayTransferRouteValid(1, 84532)).toBe(false);
    expect(isGatewayTransferRouteValid(5042002, 1)).toBe(false);
  });

  it('keeps Gateway capability separate from CCTP-only capability flags', () => {
    expect(ORBIT_NETWORKS.every((network) => network.capabilities.cctpSource && network.capabilities.cctpDestination)).toBe(true);
    expect(ORBIT_NETWORKS.find((network) => network.id === ARC_PRIMARY_NETWORK.id)?.capabilities.swap).toBe(true);
  });
});

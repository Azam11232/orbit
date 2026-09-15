import { decodeFunctionData } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCctpProvider } from './cctp';
import { CCTP_BRIDGE_NETWORKS, ARC_PRIMARY_NETWORK, isCctpRouteSupported } from '../../data/networks';
import type { BridgeQuote, BridgeToken } from '../../types/bridge';

const provider = createCctpProvider();
// Arc is the source network for CCTP bridges
const source = ARC_PRIMARY_NETWORK;
// Ethereum is the first CCTP destination
const destination = CCTP_BRIDGE_NETWORKS.find((network) => network.id !== source.id)!;
const token = (network: typeof source): BridgeToken => ({
  chainId: network.id,
  address: network.usdc,
  symbol: 'USDC',
  name: `${network.name} USDC`,
  decimals: 6,
  isNative: false,
});

describe('Circle CCTP provider', () => {
  it('exposes Arc as domain 26 with canonical USDC', () => {
    expect(source.id).toBe(5042002);
    expect(source.cctpDomain).toBe(26);
    expect(source.usdc).toBe('0x3600000000000000000000000000000000000000');
  });

  it('creates exact USDC depositForBurn calldata', async () => {
    const quote = await provider.getQuote({
      fromChain: { id: source.id, name: source.name },
      toChain: { id: destination.id, name: destination.name },
      fromToken: token(source),
      toToken: token(destination),
      fromAmount: 1_234_567n,
      fromAddress: '0x0000000000000000000000000000000000000001',
      toAddress: '0x0000000000000000000000000000000000000002',
      slippage: 0,
    });
    expect(quote.provider).toBe('Circle CCTP V2');
    expect(quote.fromAmount).toBe(1_234_567n);
    expect(quote.toAmount).toBe(1_234_567n);
    expect(quote.toAmountMin).toBe(1_234_567n);
    expect(quote.transactionTarget).toBe(source.tokenMessengerV2);
    expect(quote.transactionData).toMatch(/^0x/);
    const decoded = decodeFunctionData({ abi: (await import('./cctp')).cctpTokenMessengerAbi, data: quote.transactionData! });
    expect(decoded.functionName).toBe('depositForBurn');
    expect(decoded.args?.[0]).toBe(1_234_567n);
    expect(decoded.args?.[1]).toBe(destination.cctpDomain);
    expect(decoded.args?.[3]).toBe(source.usdc);
    expect(decoded.args?.[4]).toBe('0x0000000000000000000000000000000000000000000000000000000000000000');
    expect(decoded.args?.[5]).toBe(0n);
    expect(decoded.args?.[6]).toBe(2000);
  });

  it('encodes exactly 1 USDC as 1,000,000 source units', async () => {
    const quote = await provider.getQuote({
      fromChain: { id: source.id, name: source.name },
      toChain: { id: 421614, name: 'Arbitrum Sepolia' },
      fromToken: token(source),
      toToken: token(CCTP_BRIDGE_NETWORKS.find((network) => network.id === 421614)!),
      fromAmount: 1_000_000n,
      fromAddress: '0x0000000000000000000000000000000000000001',
      toAddress: '0x0000000000000000000000000000000000000002',
      slippage: 0,
    });
    const decoded = decodeFunctionData({ abi: (await import('./cctp')).cctpTokenMessengerAbi, data: quote.transactionData! });
    expect(decoded.args?.[0]).toBe(1_000_000n);
    expect(decoded.args?.[1]).toBe(3);
  });

  it.each(CCTP_BRIDGE_NETWORKS.filter((network) => network.id !== source.id))('resolves Arc to %s and back with the registry contracts', async (network) => {
    expect(isCctpRouteSupported(source.id, network.id)).toBe(true);
    expect(isCctpRouteSupported(network.id, source.id)).toBe(true);
    const forward = await provider.getQuote({ fromChain: { id: source.id, name: source.name }, toChain: { id: network.id, name: network.name }, fromToken: token(source), toToken: token(network), fromAmount: 1n, fromAddress: '0x0000000000000000000000000000000000000001', toAddress: '0x0000000000000000000000000000000000000002', slippage: 0 });
    const reverse = await provider.getQuote({ fromChain: { id: network.id, name: network.name }, toChain: { id: source.id, name: source.name }, fromToken: token(network), toToken: token(source), fromAmount: 1n, fromAddress: '0x0000000000000000000000000000000000000001', toAddress: '0x0000000000000000000000000000000000000002', slippage: 0 });
    expect(forward.transactionTarget).toBe(source.tokenMessengerV2);
    expect(reverse.transactionTarget).toBe(network.tokenMessengerV2);
  });

  it('resolves every ordered supported-network pair with source and destination domains', async () => {
    for (const from of CCTP_BRIDGE_NETWORKS) {
      for (const to of CCTP_BRIDGE_NETWORKS) {
        if (from.id === to.id) continue;
        const quote = await provider.getQuote({ fromChain: { id: from.id, name: from.name }, toChain: { id: to.id, name: to.name }, fromToken: token(from), toToken: token(to), fromAmount: 1n, fromAddress: '0x0000000000000000000000000000000000000001', toAddress: '0x0000000000000000000000000000000000000002', slippage: 0 });
        expect(quote.raw).toEqual({ sourceDomain: from.cctpDomain, destinationDomain: to.cctpDomain, destinationCaller: '0x0000000000000000000000000000000000000000000000000000000000000000', maxFee: 0n, minFinalityThreshold: 2000 });
        expect(quote.transactionTarget).toBe(from.tokenMessengerV2);
        expect(quote.toToken.address).toBe(to.usdc);
      }
    }
  });

  it('resolves the CCTP V2 route registry bidirectionally and stays source-chain aware', async () => {
    for (const from of CCTP_BRIDGE_NETWORKS) {
      for (const to of CCTP_BRIDGE_NETWORKS) {
        if (from.id === to.id) continue;
        expect(isCctpRouteSupported(from.id, to.id)).toBe(true);
        expect(isCctpRouteSupported(to.id, from.id)).toBe(true);
        const quote = await provider.getQuote({
          fromChain: { id: from.id, name: from.name },
          toChain: { id: to.id, name: to.name },
          fromToken: token(from),
          toToken: token(to),
          fromAmount: 1n,
          fromAddress: '0x0000000000000000000000000000000000000001',
          toAddress: '0x0000000000000000000000000000000000000002',
          slippage: 0,
        });
        expect(quote.transactionTarget).toBe(from.tokenMessengerV2);
        expect(quote.toToken.address).toBe(to.usdc);
        expect(quote.raw).toEqual({
          sourceDomain: from.cctpDomain,
          destinationDomain: to.cctpDomain,
          destinationCaller: '0x0000000000000000000000000000000000000000000000000000000000000000',
          maxFee: 0n,
          minFinalityThreshold: 2000,
        });
      }
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns pending instead of throwing when Circle reports a missing message for a burning transaction', async () => {
    const fakeQuote: BridgeQuote = {
      id: 'cctp-test-quote',
      provider: 'Circle CCTP V2',
      fromChain: { id: source.id, name: source.name },
      toChain: { id: destination.id, name: destination.name },
      fromToken: token(source),
      toToken: token(destination),
      fromAmount: 1n,
      toAmount: 1n,
      toAmountMin: 1n,
      feeAmount: 0n,
      gasAmount: null,
      gasCosts: [],
      executionDurationSeconds: null,
      transactionTarget: null,
      transactionData: null,
      transactionValue: 0n,
      bridge: 'CCTP V2',
      quotedAt: Date.now(),
      raw: {},
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ messages: [] }),
    } as Response);

    await expect(provider.getStatus(fakeQuote, '0x27a500415a7a6265978b1a070281088343c0736fac2e1f7e5c6da004ce964f8d')).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('rejects non-USDC routes', async () => {
    await expect(provider.getQuote({
      fromChain: { id: source.id, name: source.name },
      toChain: { id: destination.id, name: destination.name },
      fromToken: { ...token(source), symbol: 'ETH' },
      toToken: token(destination),
      fromAmount: 1n,
      fromAddress: '0x0000000000000000000000000000000000000001',
      toAddress: '0x0000000000000000000000000000000000000002',
      slippage: 0,
    })).rejects.toThrow('USDC only');
  });
});

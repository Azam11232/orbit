import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Blockchain, type BridgeEstimateResult } from '@circle-fin/bridge-kit';
import { ARC_PRIMARY_NETWORK, ARBITRUM_SEPOLIA, AVALANCHE_FUJI, BASE_SEPOLIA, ETHEREUM_SEPOLIA, OP_SEPOLIA, POLYGON_AMOY, getOrbitNetwork } from '../../data/networks';
import { isDestinationGasReady } from '../../hooks/useBridgeQuote';
import { calculateForwardedDestinationAmount, calculateForwardingQuoteAmounts, createCircleEstimatedBridgeQuote, createCircleForwardingParams, forwardingRouteLabel, getCircleEstimateFeeTotal, getCircleForwardingApprovalAmount, getCircleForwardingApprovalTarget, getCircleForwardingConfig, getForwardingFailureDetail, getForwardingPollRetryDelay, getForwardingStatusOutcome, getForwardingTerminalError, getWalletRequestDiagnostic, isAuthoritativeForwardingSuccess, isCircleForwardingMessageValid, isCircleForwardingSourceFeeSupported, isCircleForwardingSupported, isFastArcSepoliaForwarding, isForwardingDeliveryReady, isForwardingPendingResult, isForwardingRetryableResult, isStandardCctpSupported, pollCircleForwardingStatus, selectCircleBridgeRoute, selectCircleExecutionRoute, verifyCircleForwardingResult, withWalletRequestDiagnostics } from './circleForwarding';
import type { BridgeQuote } from '../../types/bridge';
import type { EIP1193Provider } from 'viem';

const { fetchAttestationMock } = vi.hoisted(() => ({ fetchAttestationMock: vi.fn() }));
vi.mock('@circle-fin/provider-cctp-v2', () => ({
  CCTPV2BridgingProvider: class {
    fetchAttestation = fetchAttestationMock;
  },
}));

const source = ARC_PRIMARY_NETWORK.id;
const recipient = '0x0000000000000000000000000000000000000002' as const;
const walletB = '0x0000000000000000000000000000000000000003' as const;
const sourceAddress = '0x0000000000000000000000000000000000000001' as const;
const circleBridgeAddress = '0xc5567a5e3370d4dbfb0540025078e283e36a363d';
const forwardingNonce = `0x${'0'.repeat(63)}1`;
const sourceHash = `0x${'a'.repeat(64)}` as const;
const supportedNetworks = [ARC_PRIMARY_NETWORK, ETHEREUM_SEPOLIA, BASE_SEPOLIA, ARBITRUM_SEPOLIA, OP_SEPOLIA, AVALANCHE_FUJI, POLYGON_AMOY];
const supportedRoutes = supportedNetworks.flatMap((from) => supportedNetworks
  .filter((to) => to.id !== from.id)
  .map((to) => [from, to] as const));
const sdkNames = new Map([
  [ARC_PRIMARY_NETWORK.id, 'Arc_Testnet'],
  [ETHEREUM_SEPOLIA.id, 'Ethereum_Sepolia'],
  [BASE_SEPOLIA.id, 'Base_Sepolia'],
  [ARBITRUM_SEPOLIA.id, 'Arbitrum_Sepolia'],
  [OP_SEPOLIA.id, 'Optimism_Sepolia'],
  [AVALANCHE_FUJI.id, 'Avalanche_Fuji'],
  [POLYGON_AMOY.id, 'Polygon_Amoy_Testnet'],
]);
const quote: BridgeQuote = {
  id: 'test-quote',
  provider: 'Circle',
  fromChain: { id: source, name: ARC_PRIMARY_NETWORK.name },
  toChain: { id: ETHEREUM_SEPOLIA.id, name: ETHEREUM_SEPOLIA.name },
  fromToken: { chainId: source, address: getOrbitNetwork(source)!.usdc, symbol: 'USDC', name: 'USDC', decimals: 6, isNative: false },
  toToken: { chainId: ETHEREUM_SEPOLIA.id, address: getOrbitNetwork(ETHEREUM_SEPOLIA.id)!.usdc, symbol: 'USDC', name: 'USDC', decimals: 6, isNative: false },
  fromAmount: 5_000_000n,
  toAmount: 5_000_000n,
  toAmountMin: 5_000_000n,
  feeAmount: 0n,
  gasAmount: null,
  gasCosts: [],
  executionDurationSeconds: null,
  transactionTarget: null,
  transactionData: null,
  transactionValue: 0n,
  bridge: 'CCTP',
  quotedAt: 1,
  raw: {},
};

beforeEach(() => {
  fetchAttestationMock.mockReset();
  vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
});

describe('Circle forwarding status polling', () => {
  it('persists an observed approval hash before a later BridgeKit request fails', async () => {
    const approvalHash = `0x${'c'.repeat(64)}`;
    const provider = {
      request: vi.fn(async (args: { method: string; params?: unknown[] }) => {
        const transaction = args.params?.[0] as { data?: string } | undefined;
        if (args.method === 'eth_sendTransaction' && transaction?.data === '0x095ea7b3') return approvalHash;
        throw new Error('partial BridgeKit execution failure');
      }),
    } as unknown as EIP1193Provider;
    const onHash = vi.fn();
    const instrumented = withWalletRequestDiagnostics(provider, undefined, undefined, onHash);

    await expect((async () => {
      await instrumented.request({
        method: 'eth_sendTransaction',
        params: [{ to: recipient, data: '0x095ea7b3' }],
      } as never);
      await instrumented.request({ method: 'eth_sendTransaction', params: [] } as never);
    })()).rejects.toThrow('partial BridgeKit execution failure');

    expect(onHash).toHaveBeenCalledWith(
      approvalHash,
      'eth_sendTransaction',
      [{ to: recipient, data: '0x095ea7b3' }],
    );
  });

  it.each([
    ['pending relay', { forwardState: 'PENDING', status: 'complete', message: '0x1234', eventNonce: forwardingNonce, attestation: '0x5678', decodedMessage: {} }],
    ['completed relay', { forwardState: 'COMPLETE', forwardTxHash: `0x${'b'.repeat(64)}`, status: 'complete', message: '0x1234', eventNonce: forwardingNonce, attestation: '0x5678', decodedMessage: {} }],
  ])('returns the Circle %s response with a read-only SDK context', async (_label, response) => {
    fetchAttestationMock.mockResolvedValueOnce(response);

    await expect(pollCircleForwardingStatus({ sourceChainId: source, sourceHash, recipient }))
      .resolves.toBe(response);

    const [context, requestedHash, pollingConfig] = fetchAttestationMock.mock.calls[0];
    expect(context).toMatchObject({
      address: recipient,
      chain: { chain: 'Arc_Testnet' },
      adapter: {
        prepare: expect.any(Function),
        waitForTransaction: expect.any(Function),
      },
    });
    expect(requestedHash).toBe(sourceHash);
    expect(pollingConfig).toEqual({ timeout: 8_000, maxRetries: 1, retryDelay: 1_000 });
    await expect(context.adapter.prepare()).rejects.toThrow('cannot prepare wallet transactions');
    await expect(context.adapter.waitForTransaction()).rejects.toThrow('cannot wait for wallet transactions');
  });

  it('surfaces Circle status RPC failures instead of returning a success-shaped response', async () => {
    fetchAttestationMock.mockRejectedValueOnce(new Error('Circle status RPC unavailable'));

    await expect(pollCircleForwardingStatus({ sourceChainId: source, sourceHash, recipient }))
      .rejects.toThrow('Circle status RPC unavailable');
  });
});

function forwardingStatus(
  sourceChainId: number,
  destinationChainId: number,
  mintRecipient: string = recipient,
  messageSender: string = circleBridgeAddress,
  amount = '1000000',
  feeExecuted = '1000',
) {
  const sourceNetwork = getOrbitNetwork(sourceChainId)!;
  const destinationNetwork = getOrbitNetwork(destinationChainId)!;
  return {
    forwardState: 'CONFIRMED' as const,
    forwardTxHash: '0x' + 'b'.repeat(64),
    eventNonce: forwardingNonce,
    decodedMessage: {
      sourceDomain: String(sourceNetwork.cctpDomain),
      destinationDomain: String(destinationNetwork.cctpDomain),
      nonce: forwardingNonce,
      sender: sourceNetwork.tokenMessengerV2,
      recipient: destinationNetwork.tokenMessengerV2,
      decodedMessageBody: {
        burnToken: sourceNetwork.usdc,
        mintRecipient,
        amount,
        feeExecuted,
        messageSender,
      },
    },
  };
}

function sdkEstimate(fees: BridgeEstimateResult['fees'] = [], amount = '5'): BridgeEstimateResult {
  return {
    token: 'USDC',
    amount,
    source: { address: recipient, chain: Blockchain.Arc_Testnet },
    destination: { address: recipient, chain: Blockchain.Ethereum_Sepolia, recipientAddress: recipient },
    fees,
    gasFees: [
      { name: 'approve', token: ARC_PRIMARY_NETWORK.nativeCurrency.symbol, blockchain: Blockchain.Arc_Testnet, fees: { gas: 1n, gasPrice: 1n, fee: '0.001' } },
      { name: 'burn', token: ARC_PRIMARY_NETWORK.nativeCurrency.symbol, blockchain: Blockchain.Arc_Testnet, fees: { gas: 1n, gasPrice: 1n, fee: '0.002' } },
      { name: 'mint', token: ETHEREUM_SEPOLIA.nativeCurrency.symbol, blockchain: Blockchain.Ethereum_Sepolia, fees: { gas: 1n, gasPrice: 1n, fee: '0.00000042000672' } },
    ],
  };
}

describe('BridgeKit forwarding parameters', () => {
  it('keeps Base Sepolia and Ethereum Sepolia on their distinct Circle domains and USDC contracts', () => {
    const ethereum = getOrbitNetwork(ETHEREUM_SEPOLIA.id)!;
    const base = getOrbitNetwork(BASE_SEPOLIA.id)!;

    expect(ethereum).toMatchObject({
      cctpDomain: 0,
      usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      messageTransmitterV2: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    });
    expect(base).toMatchObject({
      cctpDomain: 6,
      usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      messageTransmitterV2: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    });
    expect(ethereum.usdc).not.toBe(base.usdc);
  });

  it('redacts wallet diagnostics to safe request metadata', () => {
    const diagnostic = getWalletRequestDiagnostic({ method: 'eth_sendTransaction', params: [{ chainId: '0xaa36a7', from: recipient, to: recipient, value: '0x0', data: '0x12345678deadbeef', gas: '0x1' }, 'sensitive-signature'] });
    expect(diagnostic).toMatchObject({ method: 'eth_sendTransaction', chainId: '0xaa36a7', dataSelector: '0x12345678' });
    expect(JSON.stringify(diagnostic)).not.toContain('sensitive-signature');
    expect(JSON.stringify(diagnostic)).not.toContain('deadbeef');
  });

  it('keeps every ordered route directional and forwarder-only', () => {
    const adapter = {} as Parameters<typeof createCircleForwardingParams>[1];
    for (const from of supportedNetworks) {
      for (const to of supportedNetworks) {
        if (from.id === to.id) continue;
        const params = createCircleForwardingParams({ sourceChainId: from.id, destinationChainId: to.id, recipient, amount: 1_234_567n }, adapter);
        expect(params.from.chain).toBe(sdkNames.get(from.id));
        expect(params.to.chain).toBe(sdkNames.get(to.id));
        expect(params.to.recipientAddress).toBe(recipient);
        expect(params.to.useForwarder).toBe(true);
        expect(params.config).toEqual(getCircleForwardingConfig(from.id));
        expect(params.amount).toBe('1.234567');
        expect(isCircleForwardingSupported(from.id, to.id)).toBe(true);
      }
    }
  });

  it('covers every unique ordered pair across the seven supported networks', () => {
    const pairs = supportedNetworks.flatMap((from) => supportedNetworks
      .filter((to) => to.id !== from.id)
      .map((to) => `${from.id}->${to.id}`));

    expect(pairs).toHaveLength(42);
    expect(new Set(pairs)).toHaveLength(42);
    expect(supportedNetworks).toHaveLength(7);
    expect(new Set(supportedNetworks.map((network) => network.id))).toHaveLength(7);

    for (const from of supportedNetworks) {
      for (const to of supportedNetworks) {
        if (from.id === to.id) continue;
        expect(sdkNames.has(from.id)).toBe(true);
        expect(sdkNames.has(to.id)).toBe(true);
        expect(isCircleForwardingSupported(from.id, to.id)).toBe(true);
      }
    }
  });

  it('uses source-paid receive-exact fees only for installed source-fee routes', () => {
    expect(isCircleForwardingSourceFeeSupported(ETHEREUM_SEPOLIA.id)).toBe(true);
    expect(getCircleForwardingConfig(ETHEREUM_SEPOLIA.id)).toEqual({ feePayment: 'source', transferSpeed: 'FAST' });
    expect(isCircleForwardingSourceFeeSupported(ARC_PRIMARY_NETWORK.id)).toBe(false);
    expect(getCircleForwardingConfig(ARC_PRIMARY_NETWORK.id)).toEqual({ feePayment: 'destination', transferSpeed: 'FAST' });
    expect(getCircleForwardingApprovalTarget(ETHEREUM_SEPOLIA.id)).toBe('0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A');
    expect(getCircleForwardingApprovalTarget(ARC_PRIMARY_NETWORK.id)).toBe('0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA');
  });

  it('uses the authoritative source-paid total debit for allowance checks', () => {
    expect(getCircleForwardingApprovalAmount(ETHEREUM_SEPOLIA.id, 5_000_000n, 5_018_687n)).toBe(5_018_687n);
    expect(getCircleForwardingApprovalAmount(ETHEREUM_SEPOLIA.id, 5_000_000n)).toBe(5_000_000n);
    expect(getCircleForwardingApprovalAmount(ARC_PRIMARY_NETWORK.id, 5_000_000n, 5_018_687n)).toBe(5_000_000n);
  });

  it('keeps the exact destination amount and authoritative total debit for source-paid quotes', () => {
    expect(calculateForwardingQuoteAmounts({ amount: 1_000_000n, totalFee: 25_000n, feePayment: 'source', amountReceived: '1', totalDebit: '1.025' })).toEqual({ destinationAmount: 1_000_000n, totalSourceDebit: 1_025_000n });
  });

  it('keeps destination-paid fallback fees dynamic for unsupported source chains', () => {
    expect(calculateForwardingQuoteAmounts({ amount: 1_000_000n, totalFee: 1_100_000n, feePayment: 'destination' })).toEqual({ destinationAmount: 0n, totalSourceDebit: 1_000_000n });
  });
});

describe('Circle forwarding route capability', () => {
  it('uses a faster relay retry delay only for Arc to Ethereum Sepolia', () => {
    expect(getForwardingPollRetryDelay(ARC_PRIMARY_NETWORK.id, ETHEREUM_SEPOLIA.id)).toBe(1_000);
    expect(isFastArcSepoliaForwarding(ARC_PRIMARY_NETWORK.id, ETHEREUM_SEPOLIA.id)).toBe(true);
    expect(getForwardingPollRetryDelay(ARC_PRIMARY_NETWORK.id, BASE_SEPOLIA.id)).toBeUndefined();
    expect(isFastArcSepoliaForwarding(ARC_PRIMARY_NETWORK.id, BASE_SEPOLIA.id)).toBe(false);
  });

  describe('Circle estimate quote mapping', () => {
    it('reports SDK Standard CCTP fees, received amount and per-chain gas without inventing values', () => {
      const standardQuote = createCircleEstimatedBridgeQuote(quote, sdkEstimate([{ type: 'provider', token: 'USDC', amount: '0' }]), 'cctp', recipient);
      expect(standardQuote).toMatchObject({
        selectedRoute: 'cctp',
        feeAmount: 0n,
        forwardingFeeAmount: 0n,
        protocolFeeAmount: 0n,
        toAmount: 5_000_000n,
        transferSpeed: 'Standard CCTP; slower attestation, user-submitted destination mint',
      });
      expect(standardQuote.gasEstimates?.map(({ step, chainId, amount }) => ({ step, chainId, amount }))).toEqual([
        { step: 'approve', chainId: source, amount: 1_000_000_000_000_000n },
        { step: 'burn', chainId: source, amount: 2_000_000_000_000_000n },
        { step: 'mint', chainId: ETHEREUM_SEPOLIA.id, amount: 420_006_720_000n },
      ]);
    });

    it('rejects a Standard estimate that omits destination mint gas', () => {
      const estimate = sdkEstimate().gasFees.filter((fee) => fee.name !== 'mint');
      expect(() => createCircleEstimatedBridgeQuote(quote, { ...sdkEstimate(), gasFees: estimate }, 'cctp', recipient))
        .toThrow('Circle did not return the destination mint gas estimate for Standard CCTP');
    });

    it('rejects a forwarding fee reported on a Standard CCTP estimate', () => {
      expect(() => createCircleEstimatedBridgeQuote(quote, sdkEstimate([{ type: 'forwarder', token: 'USDC', amount: '0.25' }]), 'cctp', recipient))
        .toThrow('Circle returned a forwarding fee for the selected Standard CCTP route');
    });

    it('preserves Circle forwarding fee types and amounts from the fresh SDK estimate', () => {
      const estimate = sdkEstimate([
        { type: 'forwarder', token: 'USDC', amount: '0.125' },
        { type: 'provider', token: 'USDC', amount: '0.025' },
      ]);
      expect(getCircleEstimateFeeTotal(estimate)).toBe(150_000n);
      expect(createCircleEstimatedBridgeQuote(quote, estimate, 'forwarding', recipient)).toMatchObject({
        forwardingFeeAmount: 125_000n,
        protocolFeeAmount: 25_000n,
        feeAmount: 150_000n,
      });
    });

    it('uses the fee returned for each Arc to Ethereum Sepolia amount-specific estimate', () => {
      const fiveUsdcQuote = createCircleEstimatedBridgeQuote(
        quote,
        sdkEstimate([{ type: 'forwarder', token: 'USDC', amount: '1.646653' }]),
        'forwarding',
        recipient,
      );
      const tenUsdcQuote = createCircleEstimatedBridgeQuote(
        { ...quote, fromAmount: 10_000_000n },
        sdkEstimate([{ type: 'forwarder', token: 'USDC', amount: '1.25' }], '10'),
        'forwarding',
        recipient,
      );

      expect(fiveUsdcQuote.feeAmount).toBe(1_646_653n);
      expect(tenUsdcQuote.feeAmount).toBe(1_250_000n);
      expect(fiveUsdcQuote.toAmount).toBe(3_353_347n);
      expect(tenUsdcQuote.toAmount).toBe(8_750_000n);
      expect(() => createCircleEstimatedBridgeQuote(
        { ...quote, fromAmount: 10_000_000n },
        sdkEstimate([{ type: 'forwarder', token: 'USDC', amount: '1.25' }]),
        'forwarding',
        recipient,
      )).toThrow('Circle estimate amount does not match');
    });
  });

  it('selects only supported routes and chooses the lower fresh Circle fee, preferring forwarding on a tie', () => {
    expect(isStandardCctpSupported(source, ETHEREUM_SEPOLIA.id)).toBe(true);
    expect(isStandardCctpSupported(source, source)).toBe(false);
    expect(selectCircleBridgeRoute({ forwardingSupported: true, standardCctpSupported: true, forwardingFeeAmount: 50_000n, standardCctpFeeAmount: 40_000n })).toBe('cctp');
    expect(selectCircleBridgeRoute({ forwardingSupported: true, standardCctpSupported: true, forwardingFeeAmount: 40_000n, standardCctpFeeAmount: 50_000n })).toBe('forwarding');
    expect(selectCircleBridgeRoute({ forwardingSupported: true, standardCctpSupported: true, forwardingFeeAmount: 40_000n, standardCctpFeeAmount: 40_000n })).toBe('forwarding');
    expect(selectCircleBridgeRoute({ forwardingSupported: true, standardCctpSupported: true, standardCctpFeeAmount: 40_000n })).toBe('cctp');
    expect(selectCircleBridgeRoute({ forwardingSupported: true, standardCctpSupported: true, forwardingFeeAmount: 40_000n })).toBe('forwarding');
    expect(selectCircleBridgeRoute({ forwardingSupported: false, standardCctpSupported: true, standardCctpFeeAmount: 0n })).toBe('cctp');
    expect(() => selectCircleBridgeRoute({ forwardingSupported: false, standardCctpSupported: false })).toThrow('no supported route');
    expect(() => selectCircleBridgeRoute({ forwardingSupported: true, standardCctpSupported: true })).toThrow('fresh estimate');
  });

  it.each([ETHEREUM_SEPOLIA, BASE_SEPOLIA])('uses relayed destination execution by default for Arc to %s when Circle forwarding is available', (destination) => {
    expect(isCircleForwardingSupported(source, destination.id)).toBe(true);
    expect(selectCircleExecutionRoute({
      preferredRoute: 'auto',
      recommendedRoute: 'cctp',
      forwardingSupported: true,
    })).toBe('forwarding');
    const adapter = {} as Parameters<typeof createCircleForwardingParams>[1];
    expect(createCircleForwardingParams({
      sourceChainId: source,
      destinationChainId: destination.id,
      recipient,
      amount: 1_000_000n,
    }, adapter).to.useForwarder).toBe(true);
  });

  it('keeps Standard CCTP only when explicitly selected or forwarding is unavailable', () => {
    expect(selectCircleExecutionRoute({
      preferredRoute: 'cctp',
      recommendedRoute: 'forwarding',
      forwardingSupported: true,
    })).toBe('cctp');
    expect(selectCircleExecutionRoute({
      preferredRoute: 'auto',
      recommendedRoute: 'cctp',
      forwardingSupported: false,
    })).toBe('cctp');
  });

  it.each(supportedRoutes)('selects the supported Circle delivery model for %s → %s', (from, to) => {
    const forwardingSupported = isCircleForwardingSupported(from.id, to.id);
    expect(isStandardCctpSupported(from.id, to.id)).toBe(true);
    expect(selectCircleExecutionRoute({
      preferredRoute: 'auto',
      recommendedRoute: 'cctp',
      forwardingSupported,
    })).toBe(forwardingSupported ? 'forwarding' : 'cctp');
    if (forwardingSupported) {
      const adapter = {} as Parameters<typeof createCircleForwardingParams>[1];
      expect(createCircleForwardingParams({
        sourceChainId: from.id,
        destinationChainId: to.id,
        recipient,
        amount: 1_000_000n,
      }, adapter).to).toMatchObject({ useForwarder: true });
    }
  });

  it.each([ETHEREUM_SEPOLIA, BASE_SEPOLIA, ARBITRUM_SEPOLIA])('enables forwarding to %s', (destination) => {
    expect(isCircleForwardingSupported(source, destination.id)).toBe(true);
    expect(forwardingRouteLabel(source, destination.id)).toBe('Circle forwarding destination');
  });

  it('uses the installed SDK forwarding capability for Polygon Amoy', () => {
    expect(isCircleForwardingSupported(source, POLYGON_AMOY.id)).toBe(true);
    expect(forwardingRouteLabel(source, POLYGON_AMOY.id)).toBe('Circle forwarding destination');
  });

  it('uses the installed SDK capability matrix for Polygon and Optimism', () => {
    expect(isCircleForwardingSupported(source, POLYGON_AMOY.id)).toBe(true);
    expect(isCircleForwardingSupported(source, OP_SEPOLIA.id)).toBe(true);
  });

  it('does not block zero destination gas when forwarding is enabled', () => {
    expect(isDestinationGasReady({ applicable: !isCircleForwardingSupported(source, ETHEREUM_SEPOLIA.id), loading: false, balance: 0n })).toBe(true);
  });

  it('blocks zero destination gas for the manual fallback', () => {
    expect(isDestinationGasReady({ applicable: !isCircleForwardingSupported(source, POLYGON_AMOY.id), loading: false, balance: 0n })).toBe(true);
  });

  it('does not claim forwarding when the source is outside the installed route registry', () => {
    expect(isCircleForwardingSupported(1, ETHEREUM_SEPOLIA.id)).toBe(false);
  });

  it('subtracts forwarding and provider fees from the verified destination amount', () => {
    expect(calculateForwardedDestinationAmount(10_000_000n, ['0.250000', null, '0.500000'])).toBe(9_250_000n);
    expect(calculateForwardedDestinationAmount(1n, ['0.000002'])).toBe(0n);
  });

  it('keeps a confirmed burn with a pending mint in destination processing', () => {
    expect(isForwardingPendingResult({ state: 'pending', steps: [{ name: 'burn', state: 'success', txHash: '0xsource' }, { name: 'mint', state: 'pending' }] })).toBe(true);
    expect(isForwardingPendingResult({ state: 'pending', steps: [{ name: 'burn', state: 'success', txHash: '0xsource' }] })).toBe(true);
    for (let seconds = 0; seconds < 30; seconds += 1) {
      expect(isForwardingPendingResult({ state: 'pending', steps: [{ name: 'burn', state: 'success', txHash: '0xsource' }, { name: 'fetchAttestation', state: 'success', data: { forwardState: 'PENDING' } }] })).toBe(true);
    }
    expect(isForwardingPendingResult({ state: 'pending', steps: [{ name: 'burn', state: 'success', txHash: '0xsource' }, { name: 'mint', state: 'pending', data: { forwardState: 'CONFIRMED' } }] })).toBe(true);
  });

  it('does not classify explicit forwarding failure or burn-only success as pending completion', () => {
    expect(isForwardingPendingResult({ state: 'error', steps: [{ name: 'burn', state: 'success' }, { name: 'mint', state: 'error', errorMessage: 'Circle relayer failed' }] })).toBe(false);
    expect(isForwardingPendingResult({ state: 'success', steps: [{ name: 'burn', state: 'success' }] })).toBe(false);
  });

  it('accepts a later forwarded mint result for the same source burn', () => {
    expect(isForwardingPendingResult({ state: 'success', steps: [{ name: 'burn', state: 'success', txHash: '0xsource' }, { name: 'mint', state: 'success', forwarded: true, txHash: '0xdestination' }] })).toBe(false);
  });

  it('recognizes SDK-marked recoverable mint results for retry without reburning', () => {
    const result = { state: 'error' as const, steps: [{ name: 'burn', state: 'success' as const, txHash: '0xsource' }, { name: 'mint', state: 'error' as const, error: { recoverability: 'RETRYABLE' } }] };
    expect(isForwardingRetryableResult(result)).toBe(true);
    expect(result.steps[0].txHash).toBe('0xsource');
  });

  it('does not retry hard forwarding failures', () => {
    expect(isForwardingRetryableResult({ state: 'error', steps: [{ name: 'burn', state: 'success' }, { name: 'mint', state: 'error', error: { recoverability: 'FATAL' } }] })).toBe(false);
  });

  it('surfaces the underlying step error instead of hiding it', () => {
    expect(getForwardingFailureDetail({ steps: [{ name: 'fetchAttestation', state: 'error', errorMessage: 'IRIS returned 503' }] })).toBe('IRIS returned 503');
    expect(getForwardingFailureDetail({ steps: [{ name: 'mint', state: 'error', error: { code: 'FORWARD_FAILED' } }] })).toContain('FORWARD_FAILED');
  });

  it.each([
    ['PENDING', undefined, false],
    ['PROCESSING', undefined, false],
    ['SENT', undefined, false],
    ['UNKNOWN', undefined, false],
    ['CONFIRMED', undefined, false],
    ['CONFIRMED', '0xdestination', true],
    ['COMPLETE', undefined, false],
    ['COMPLETE', '0xdestination', true],
  ])('classifies %s forwarding state with hash %s correctly', (forwardState, forwardTxHash, expected) => {
    expect(isForwardingDeliveryReady({ forwardState, forwardTxHash })).toBe(expected);
  });

  it('requires a confirmed Circle state and destination hash before attempting receipt verification', () => {
    expect(isAuthoritativeForwardingSuccess({ forwardState: 'CONFIRMED' })).toBe(false);
    expect(isAuthoritativeForwardingSuccess({ forwardState: 'COMPLETE' })).toBe(false);
    expect(isAuthoritativeForwardingSuccess({ forwardState: 'PENDING' })).toBe(false);
    expect(isAuthoritativeForwardingSuccess({ forwardState: 'FAILED' })).toBe(false);
    expect(isAuthoritativeForwardingSuccess({ forwardState: 'PENDING', forwardTxHash: '0xdestination' })).toBe(false);
    expect(isAuthoritativeForwardingSuccess({ forwardState: 'CONFIRMED', forwardTxHash: '0xdestination' })).toBe(true);
  });

  it.each([
    ['PENDING', 'pending'],
    ['PROCESSING', 'pending'],
    ['UNKNOWN', 'pending'],
    ['CONFIRMED', 'pending'],
    ['COMPLETE', 'pending'],
    ['FAILED', 'failed'],
  ] as const)('maps %s to %s without destination metadata', (state, outcome) => {
    expect(getForwardingStatusOutcome(state)).toBe(outcome);
  });

  it('requires Circle confirmation together with the destination hash', () => {
    expect(getForwardingStatusOutcome(undefined, '0xdestination')).toBe('pending');
    expect(getForwardingStatusOutcome('COMPLETE', '0xdestination')).toBe('completed');
    expect(isAuthoritativeForwardingSuccess({ forwardState: undefined, forwardTxHash: '0xdestination' })).toBe(false);
  });

  it('surfaces forwarder failure metadata', () => {
    expect(getForwardingTerminalError({ forwardState: 'FAILED', forwardErrorCode: 'RELAYER_REVERT', forwardErrorDetails: 'mint reverted' })).toBe('RELAYER_REVERT: mint reverted');
    expect(getForwardingTerminalError({ forwardState: 'PENDING' })).toBeUndefined();
  });

  it('validates the configured Circle bridge sender, domains, USDC token, amount and encoded recipient', () => {
    const forwarding = forwardingStatus(source, BASE_SEPOLIA.id);
    const input = {
      sourceChainId: source,
      destinationChainId: BASE_SEPOLIA.id,
      sourceAddress,
      recipient,
      expectedNetAmount: 999_000n,
    };
    expect(isCircleForwardingMessageValid({ ...input, forwarding })).toBe(true);
    expect(isCircleForwardingMessageValid({
      ...input,
      forwarding: forwardingStatus(source, BASE_SEPOLIA.id, recipient, sourceAddress),
    })).toBe(false);
    expect(isCircleForwardingMessageValid({
      ...input,
      forwarding: forwardingStatus(source, BASE_SEPOLIA.id, walletB),
    })).toBe(false);
    expect(isCircleForwardingMessageValid({
      ...input,
      forwarding: forwardingStatus(source, ETHEREUM_SEPOLIA.id),
    })).toBe(false);
    expect(isCircleForwardingMessageValid({
      ...input,
      forwarding: forwardingStatus(source, BASE_SEPOLIA.id, recipient, circleBridgeAddress, '1000000', '2000'),
    })).toBe(false);
  });

  it('accepts the completed Arc-to-Base transfer using Circle Bridge Kit message structure', () => {
    const sourceWallet = '0xbccb7750de26b1a1ac3a18ce08be01ecd4094c6c' as const;
    const sourceTxHash = '0x73f974fca9ed3f9a96db7da90f4b01915c4aa7e347d933be8df7902f99adfdef';
    const destinationTxHash = '0x9f5e102c713cfb86b7a4f0d8a8ecbcdbe5f2283904400959f1227a028187e341';
    const nonce = '0xa26c0e25d7311d0019ed6fccedff2e2039d853cb881ae2184ab7e06b0a4eb9ba';
    const forwarding = {
      forwardState: 'COMPLETE',
      forwardTxHash: destinationTxHash,
      eventNonce: nonce,
      decodedMessage: {
        sourceDomain: '26',
        destinationDomain: '6',
        nonce,
        sender: '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',
        recipient: '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',
        decodedMessageBody: {
          burnToken: '0x3600000000000000000000000000000000000000',
          mintRecipient: sourceWallet,
          amount: '3000000',
          feeExecuted: '53929',
          messageSender: circleBridgeAddress,
        },
      },
    } as const;
    const input = {
      sourceChainId: source,
      destinationChainId: BASE_SEPOLIA.id,
      sourceAddress: sourceWallet,
      recipient: sourceWallet,
      expectedNetAmount: 2_946_071n,
    };
    const result = {
      state: 'pending' as const,
      source: { address: sourceWallet, chain: { chain: 'Arc_Testnet' } },
      destination: { address: sourceWallet, chain: { chain: 'Base_Sepolia' } },
      steps: [{ name: 'burn', state: 'success' as const, txHash: sourceTxHash }],
    } as never;

    expect(isCircleForwardingMessageValid({ ...input, forwarding })).toBe(true);
    expect(verifyCircleForwardingResult({ ...input, result, forwarding })).toBe(true);
    expect(isCircleForwardingMessageValid({
      ...input,
      forwarding: { ...forwarding, decodedMessage: { ...forwarding.decodedMessage, decodedMessageBody: { ...forwarding.decodedMessage.decodedMessageBody, messageSender: sourceWallet } } },
    })).toBe(false);
  });

  it('accepts authoritative forwarder completion without a destination tx hash', () => {
    const result = {
      state: 'success' as const,
      source: { address: sourceAddress, chain: { chain: 'Arc_Testnet' } },
      destination: { address: recipient, chain: { chain: 'Avalanche_Fuji' } },
      steps: [{ name: 'burn', state: 'success' as const, txHash: '0xsource' }, { name: 'mint', state: 'success' as const, forwarded: true }],
    } as never;
    expect(verifyCircleForwardingResult({
      result,
      sourceChainId: source,
      destinationChainId: 43113,
      sourceAddress,
      recipient,
      expectedNetAmount: 999_000n,
      forwarding: forwardingStatus(source, 43113),
    })).toBe(true);
  });

  it('accepts authoritative IRIS completion without requiring mint step data', () => {
    const result = {
      state: 'error' as const,
      source: { address: sourceAddress, chain: { chain: 'Ethereum_Sepolia' } },
      destination: { address: recipient, chain: { chain: 'Arc_Testnet' } },
      steps: [{ name: 'burn', state: 'success' as const, txHash: '0xsource' }, { name: 'fetchAttestation', state: 'error' as const, errorMessage: 'incomplete while polling' }],
    } as never;
    expect(verifyCircleForwardingResult({
      result,
      sourceChainId: ETHEREUM_SEPOLIA.id,
      destinationChainId: source,
      sourceAddress,
      recipient,
      expectedNetAmount: 999_000n,
      forwarding: forwardingStatus(ETHEREUM_SEPOLIA.id, source),
    })).toBe(true);
  });

  it('accepts CONFIRMED forwarding with a destination transaction hash', () => {
    const result = {
      state: 'pending' as const,
      source: { address: sourceAddress, chain: { chain: 'Arc_Testnet' } },
      destination: { address: recipient, chain: { chain: 'Ethereum_Sepolia' } },
      steps: [{ name: 'burn', state: 'success' as const, txHash: '0xsource' }],
    } as never;
    expect(verifyCircleForwardingResult({
      result,
      sourceChainId: source,
      destinationChainId: ETHEREUM_SEPOLIA.id,
      sourceAddress,
      recipient,
      expectedNetAmount: 999_000n,
      forwarding: forwardingStatus(source, ETHEREUM_SEPOLIA.id),
    })).toBe(true);
  });

  it('treats CONFIRMED forwarding as complete even when Bridge Kit result remains pending and has no hash', () => {
    const result = {
      state: 'pending' as const,
      source: { address: sourceAddress, chain: { chain: 'Arc_Testnet' } },
      destination: { address: recipient, chain: { chain: 'Ethereum_Sepolia' } },
      steps: [{ name: 'burn', state: 'success' as const, txHash: '0xsource' }],
    } as never;
    expect(verifyCircleForwardingResult({
      result,
      sourceChainId: source,
      destinationChainId: ETHEREUM_SEPOLIA.id,
      sourceAddress,
      recipient,
      expectedNetAmount: 999_000n,
      forwarding: forwardingStatus(source, ETHEREUM_SEPOLIA.id),
    })).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { ARC_PRIMARY_NETWORK, ARBITRUM_SEPOLIA, AVALANCHE_FUJI, BASE_SEPOLIA, ETHEREUM_SEPOLIA, OP_SEPOLIA, POLYGON_AMOY } from '../../data/networks';
import { FORWARDING_RECONCILIATION_INTERVAL_MS } from '../../hooks/useBridgeExecution';
import { isDestinationGasReady } from '../../hooks/useBridgeQuote';
import { calculateForwardedDestinationAmount, calculateForwardingQuoteAmounts, createCircleForwardingParams, forwardingRouteLabel, getCircleForwardingApprovalAmount, getCircleForwardingApprovalTarget, getCircleForwardingConfig, getForwardingFailureDetail, getForwardingStatusOutcome, getForwardingTerminalError, getWalletRequestDiagnostic, isAuthoritativeForwardingSuccess, isCircleForwardingSourceFeeSupported, isCircleForwardingSupported, isForwardingDeliveryReady, isForwardingPendingResult, isForwardingRetryableResult, verifyCircleForwardingResult } from './circleForwarding';

const source = ARC_PRIMARY_NETWORK.id;
const recipient = '0x0000000000000000000000000000000000000002' as const;
const supportedNetworks = [ARC_PRIMARY_NETWORK, ETHEREUM_SEPOLIA, BASE_SEPOLIA, ARBITRUM_SEPOLIA, OP_SEPOLIA, AVALANCHE_FUJI, POLYGON_AMOY];
const sdkNames = new Map([
  [ARC_PRIMARY_NETWORK.id, 'Arc_Testnet'],
  [ETHEREUM_SEPOLIA.id, 'Ethereum_Sepolia'],
  [BASE_SEPOLIA.id, 'Base_Sepolia'],
  [ARBITRUM_SEPOLIA.id, 'Arbitrum_Sepolia'],
  [OP_SEPOLIA.id, 'Optimism_Sepolia'],
  [AVALANCHE_FUJI.id, 'Avalanche_Fuji'],
  [POLYGON_AMOY.id, 'Polygon_Amoy_Testnet'],
]);

describe('BridgeKit forwarding parameters', () => {
  it('uses a 1 second forwarding reconciliation interval', () => {
    expect(FORWARDING_RECONCILIATION_INTERVAL_MS).toBe(1_000);
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
    ['CONFIRMED', undefined, true],
    ['CONFIRMED', '0xdestination', true],
    ['COMPLETE', undefined, true],
    ['COMPLETE', '0xdestination', true],
  ])('classifies %s forwarding state with hash %s correctly', (forwardState, forwardTxHash, expected) => {
    expect(isForwardingDeliveryReady({ forwardState, forwardTxHash })).toBe(expected);
  });

  it('uses Circle state or a destination tx hash as the authoritative forwarding result without a receipt', () => {
    expect(isAuthoritativeForwardingSuccess({ forwardState: 'CONFIRMED' })).toBe(true);
    expect(isAuthoritativeForwardingSuccess({ forwardState: 'COMPLETE' })).toBe(true);
    expect(isAuthoritativeForwardingSuccess({ forwardState: 'PENDING' })).toBe(false);
    expect(isAuthoritativeForwardingSuccess({ forwardState: 'FAILED' })).toBe(false);
    expect(isAuthoritativeForwardingSuccess({ forwardState: 'PENDING', forwardTxHash: '0xdestination' })).toBe(true);
  });

  it.each([
    ['PENDING', 'pending'],
    ['PROCESSING', 'pending'],
    ['UNKNOWN', 'pending'],
    ['CONFIRMED', 'completed'],
    ['COMPLETE', 'completed'],
    ['FAILED', 'failed'],
  ] as const)('maps %s to %s without destination metadata', (state, outcome) => {
    expect(getForwardingStatusOutcome(state)).toBe(outcome);
  });

  it('treats a destination tx hash as completed even when Circle omits the final forward state', () => {
    expect(getForwardingStatusOutcome(undefined, '0xdestination')).toBe('completed');
    expect(isAuthoritativeForwardingSuccess({ forwardState: undefined, forwardTxHash: '0xdestination' })).toBe(true);
  });

  it('surfaces forwarder failure metadata', () => {
    expect(getForwardingTerminalError({ forwardState: 'FAILED', forwardErrorCode: 'RELAYER_REVERT', forwardErrorDetails: 'mint reverted' })).toBe('RELAYER_REVERT: mint reverted');
    expect(getForwardingTerminalError({ forwardState: 'PENDING' })).toBeUndefined();
  });

  it('accepts authoritative forwarder completion without a destination tx hash', () => {
    const recipient = '0x0000000000000000000000000000000000000002' as const;
    const result = {
      state: 'success' as const,
      source: { address: '0x0000000000000000000000000000000000000001', chain: { chain: 'Arc_Testnet' } },
      destination: { address: recipient, chain: { chain: 'Avalanche_Fuji' } },
      steps: [{ name: 'burn', state: 'success' as const, txHash: '0xsource' }, { name: 'mint', state: 'success' as const, forwarded: true }],
    } as never;
    expect(verifyCircleForwardingResult({ result, sourceChainId: source, destinationChainId: 43113, recipient, expectedNetAmount: 999_000n })).toBe(true);
  });

  it('accepts authoritative IRIS completion without requiring mint step data', () => {
    const result = {
      state: 'error' as const,
      source: { address: '0x0000000000000000000000000000000000000001', chain: { chain: 'Ethereum_Sepolia' } },
      destination: { address: recipient, chain: { chain: 'Arc_Testnet' } },
      steps: [{ name: 'burn', state: 'success' as const, txHash: '0xsource' }, { name: 'fetchAttestation', state: 'error' as const, errorMessage: 'incomplete while polling' }],
    } as never;
    expect(verifyCircleForwardingResult({ result, sourceChainId: ETHEREUM_SEPOLIA.id, destinationChainId: source, recipient, expectedNetAmount: 999_000n, forwarding: { forwardState: 'COMPLETE' } })).toBe(true);
  });

  it('accepts CONFIRMED forwarding with a destination transaction hash', () => {
    const result = {
      state: 'pending' as const,
      source: { address: '0x0000000000000000000000000000000000000001', chain: { chain: 'Arc_Testnet' } },
      destination: { address: recipient, chain: { chain: 'Ethereum_Sepolia' } },
      steps: [{ name: 'burn', state: 'success' as const, txHash: '0xsource' }],
    } as never;
    expect(verifyCircleForwardingResult({ result, sourceChainId: source, destinationChainId: ETHEREUM_SEPOLIA.id, recipient, expectedNetAmount: 99_000n, forwarding: { forwardState: 'CONFIRMED', forwardTxHash: '0xdestination' } })).toBe(true);
  });

  it('treats CONFIRMED forwarding as complete even when Bridge Kit result remains pending and has no hash', () => {
    const result = {
      state: 'pending' as const,
      source: { address: '0x0000000000000000000000000000000000000001', chain: { chain: 'Arc_Testnet' } },
      destination: { address: recipient, chain: { chain: 'Ethereum_Sepolia' } },
      steps: [{ name: 'burn', state: 'success' as const, txHash: '0xsource' }],
    } as never;
    expect(verifyCircleForwardingResult({ result, sourceChainId: source, destinationChainId: ETHEREUM_SEPOLIA.id, recipient, expectedNetAmount: 99_000n, forwarding: { forwardState: 'CONFIRMED' } })).toBe(true);
  });
});

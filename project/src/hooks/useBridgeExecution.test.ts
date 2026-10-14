import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { bridgeExplorerUrl, getBridgeRouteLabel, getBridgeSuccessDestinationHash, shouldShowBridgeApprovalAction, shouldShowBridgeReviewAction } from '../App';
import { canApplyForwardingPending, canRetryDestinationMint, canRetryForwardingReconciliation, canShowBridgeSuccess, createBridgeExecutionOneShotGuard, getBridgeLifecycleStatus, getBridgeProgressSteps, getCompactBridgeProgressSteps, getCompactBridgeStatus, getRequiredBridgeChainId, getRequiredSourceDebit, isBridgeExecutionStarted, isExplicitWalletRejection, shouldAutoCompleteBridge, shouldReadAppSourceBalance, shouldReportForwardingReconciliationTimeout, shouldResetBridgeAmount, shouldResetBridgeExecution, shouldShowBridgeWrongNetwork, shouldSkipInitialForwardingStatusPoll, verifyDestinationReceipt } from './useBridgeExecution';
import { isBridgeQuoteCurrent } from './useBridgeQuote';
import { isBridgeStatusPollingEnabled } from './useBridgeStatus';
import { verifyCircleForwardingResult } from '../services/bridge/circleForwarding';
import { ARC_PRIMARY_NETWORK, ETHEREUM_SEPOLIA } from '../data/networks';

const transmitter = '0x1111111111111111111111111111111111111111' as Address;
const token = '0x2222222222222222222222222222222222222222' as Address;
const recipient = '0x3333333333333333333333333333333333333333' as Address;
const source = '0x4444444444444444444444444444444444444444' as Address;
const sourceHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex;
const destinationHash = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex;
const amount = 1_000_000n;

function transferLog(value = amount, transferToken = token, transferRecipient = recipient) {
  return {
    address: transferToken,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: source, to: transferRecipient } }) as readonly Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  };
}

function forwardingReceipt(value = amount, transferRecipient = recipient, expectedAmount = amount) {
  return {
    receiptStatus: 'success' as const,
    receiptTo: transmitter,
    expectedMessageTransmitter: transmitter,
    expectedToken: token,
    recipient,
    expectedAmount,
    requireExactAmount: false,
    logs: [transferLog(value, token, transferRecipient)],
  };
}

describe('Bridge destination verification', () => {
  it('accepts only a successful receiveMessage receipt with the expected USDC transfer', () => {
    expect(verifyDestinationReceipt({
      receiptStatus: 'success',
      receiptTo: transmitter,
      expectedMessageTransmitter: transmitter,
      expectedToken: token,
      recipient,
      expectedAmount: amount,
      logs: [transferLog()],
    })).toBe(true);
  });

  it.each([amount, 1_100_000n])('accepts forwarding receipts at or above the expected amount (%s)', (value) => {
    expect(verifyDestinationReceipt(forwardingReceipt(value))).toBe(true);
  });

  it('accepts the actual Arc to Sepolia forwarding amount above the quoted minimum', () => {
    expect(verifyDestinationReceipt(forwardingReceipt(977_818n, recipient, 927_493n))).toBe(true);
  });

  it('rejects an Arc to Sepolia forwarding amount below the quoted minimum', () => {
    expect(verifyDestinationReceipt(forwardingReceipt(900_000n, recipient, 927_493n))).toBe(false);
  });

  it.each([
    ['zero amount', transferLog(0n)],
    ['wrong recipient', transferLog(amount, token, source)],
  ])('rejects forwarding receipts with %s', (_label, log) => {
    expect(verifyDestinationReceipt({ ...forwardingReceipt(), logs: [log] })).toBe(false);
  });

  it.each([
    ['reverted receipt', { receiptStatus: 'reverted' as const }],
    ['wrong destination contract', { receiptTo: token }],
    ['wrong token', { logs: [transferLog(amount, transmitter)] }],
    ['wrong recipient', { logs: [transferLog(amount, token, source)] }],
    ['wrong amount', { logs: [transferLog(999_999n)] }],
  ])('rejects %s', (_label, override) => {
    expect(verifyDestinationReceipt({
      receiptStatus: 'success',
      receiptTo: transmitter,
      expectedMessageTransmitter: transmitter,
      expectedToken: token,
      recipient,
      expectedAmount: amount,
      logs: [transferLog()],
      ...override,
    })).toBe(false);
  });
});

describe('Bridge success gating', () => {
  it('allows retrying a Standard CCTP mint only after a source burn and before any destination submission', () => {
    expect(canRetryDestinationMint({ status: 'error', selectedRoute: 'cctp', sourceHash, destinationVerified: false })).toBe(true);
    expect(canRetryDestinationMint({ status: 'error', selectedRoute: 'cctp', sourceHash, destinationVerified: false, destinationSubmissionAttempted: true })).toBe(false);
    expect(canRetryDestinationMint({ status: 'error', selectedRoute: 'cctp', sourceHash, destinationHash, destinationVerified: false, destinationSubmissionAttempted: true, destinationSubmissionReverted: true })).toBe(true);
    expect(canRetryDestinationMint({ status: 'error', selectedRoute: 'forwarding', sourceHash, destinationVerified: false })).toBe(false);
    expect(canRetryDestinationMint({ status: 'error', selectedRoute: 'cctp', destinationVerified: false })).toBe(false);
    expect(canRetryDestinationMint({ status: 'error', selectedRoute: 'cctp', sourceHash, destinationHash, destinationVerified: false })).toBe(false);
    expect(canRetryDestinationMint({ status: 'completed', selectedRoute: 'cctp', sourceHash, destinationVerified: false })).toBe(false);
  });

  it('recognizes explicit wallet rejection but treats unknown errors as possibly broadcast', () => {
    expect(isExplicitWalletRejection({ code: 4001 })).toBe(true);
    expect(isExplicitWalletRejection({ cause: { name: 'UserRejectedRequestError' } })).toBe(true);
    expect(isExplicitWalletRejection(new Error('request failed'))).toBe(false);
  });

  it('skips the app source balance read for Arc to Sepolia forwarding with equal debit and amount', () => {
    expect(shouldReadAppSourceBalance({
      forwardingEnabled: true,
      sourceChainId: ARC_PRIMARY_NETWORK.id,
      destinationChainId: ETHEREUM_SEPOLIA.id,
      fromAmount: 4_200_000n,
      totalSourceDebit: 4_200_000n,
    })).toBe(false);
  });

  it('keeps the app source balance read when the source debit differs from the amount', () => {
    expect(shouldReadAppSourceBalance({
      forwardingEnabled: true,
      sourceChainId: ARC_PRIMARY_NETWORK.id,
      destinationChainId: ETHEREUM_SEPOLIA.id,
      fromAmount: 4_200_000n,
      totalSourceDebit: 4_250_000n,
    })).toBe(true);
  });

  it('uses total source debit when source-paid fees are quoted', () => {
    expect(getRequiredSourceDebit({ fromAmount: 1_000_000n, totalSourceDebit: 1_025_000n })).toBe(1_025_000n);
    expect(getRequiredSourceDebit({ fromAmount: 1_000_000n, totalSourceDebit: null })).toBe(1_000_000n);
  });

  it('never treats source confirmation or attestation as success', () => {
    expect(canShowBridgeSuccess({ status: 'source-confirmed', sourceHash, destinationHash, destinationVerified: true })).toBe(false);
    expect(canShowBridgeSuccess({ status: 'attestation-ready', sourceHash, destinationHash, destinationVerified: true })).toBe(false);
    expect(canShowBridgeSuccess({ status: 'destination-confirmed', sourceHash, destinationHash, destinationVerified: false })).toBe(false);
    expect(canShowBridgeSuccess({ status: 'completed', sourceHash, destinationVerified: true })).toBe(true);
  });

  it('auto starts destination mint once the Circle attestation is ready after source confirmation', () => {
    expect(shouldAutoCompleteBridge({
      status: 'source-confirmed',
      attestationReady: true,
      message: '0x1234' as Hex,
      attestation: '0x5678' as Hex,
      destinationHash: undefined,
    })).toBe(true);
    expect(shouldAutoCompleteBridge({
      status: 'destination-pending',
      attestationReady: true,
      message: '0x1234' as Hex,
      attestation: '0x5678' as Hex,
      destinationHash: undefined,
    })).toBe(false);
    expect(shouldAutoCompleteBridge({
      status: 'source-confirmed',
      attestationReady: false,
      message: undefined,
      attestation: undefined,
      destinationHash: undefined,
    })).toBe(false);
  });

  it('allows verified forwarder-only success without a destination hash', () => {
    expect(canShowBridgeSuccess({ status: 'completed', sourceHash, destinationVerified: true })).toBe(true);
  });

  it('does not show success for an unverified destination hash', () => {
    expect(canShowBridgeSuccess({ status: 'completed', sourceHash, destinationHash, destinationVerified: false })).toBe(false);
  });

  it('shows success for a completed CCTP bridge after its destination receipt is verified', () => {
    expect(canShowBridgeSuccess({ status: 'completed', sourceHash, destinationHash, destinationVerified: true })).toBe(true);
  });

  it('treats a successful destination mint tx as authoritative even when the forwarder result lacks a final state', () => {
    const result = {
      state: 'success',
      source: { chain: { chain: 'Ethereum_Sepolia' } },
      destination: { chain: { chain: 'Arc_Testnet' }, address: recipient },
      steps: [
        { name: 'burn', state: 'success', txHash: sourceHash },
        { name: 'mint', state: 'success', txHash: destinationHash, forwarded: false },
      ],
    } as any;

    expect(verifyCircleForwardingResult({
      result,
      sourceChainId: 11155111,
      destinationChainId: 5042002,
      recipient,
      expectedNetAmount: amount,
    })).toBe(true);
  });

  it('does not allow a source hash to stand in for a destination hash', () => {
    expect(canShowBridgeSuccess({ status: 'completed', sourceHash, destinationHash: sourceHash, destinationVerified: false })).toBe(false);
  });

  it('uses the forwarding execution destination hash before status-query data', () => {
    expect(getBridgeSuccessDestinationHash(destinationHash, '0xstatus-hash')).toBe(destinationHash);
  });

  it('keeps completion independent from explorer URL availability', () => {
    expect(bridgeExplorerUrl(999999, destinationHash)).toBeNull();
    expect(canShowBridgeSuccess({ status: 'completed', sourceHash, destinationHash, destinationVerified: true })).toBe(true);
  });
});

describe('Bridge network requirement gating', () => {
  it('requires the source chain only while the source wallet action is still pending', () => {
    expect(getRequiredBridgeChainId({ status: 'idle', sourceChainId: 1, destinationChainId: 2 })).toBeUndefined();
    expect(getRequiredBridgeChainId({ status: 'idle', sourceChainId: 1, destinationChainId: 2, sourceActionReady: true })).toBe(1);
    expect(getRequiredBridgeChainId({ status: 'preflight', sourceChainId: 1, destinationChainId: 2 })).toBe(1);
    expect(getRequiredBridgeChainId({ status: 'source-pending', sourceChainId: 1, destinationChainId: 2 })).toBe(1);
    expect(getRequiredBridgeChainId({ status: 'source-pending', sourceChainId: 1, destinationChainId: 2, sourceHash })).toBeUndefined();
  });

  it('does not require a wallet chain during settlement or after completion', () => {
    for (const status of ['source-confirmed', 'attestation-pending', 'attestation-ready', 'destination-pending', 'destination-confirmed', 'verification-pending', 'completed'] as const) {
      expect(getRequiredBridgeChainId({ status, sourceChainId: 1, destinationChainId: 2, forwarding: true })).toBeUndefined();
      expect(getRequiredBridgeChainId({ status, sourceChainId: 1, destinationChainId: 2, forwarding: false })).toBeUndefined();
    }
    expect(getRequiredBridgeChainId({ status: 'error', sourceChainId: 1, destinationChainId: 2, sourceHash })).toBeUndefined();
    expect(getRequiredBridgeChainId({ status: 'completed', sourceChainId: 1, destinationChainId: 2, verifiedComplete: true })).toBeUndefined();
  });

  it('never shows a stale source warning after verified completion, even if the tracked source hash is missing', () => {
    expect(getRequiredBridgeChainId({
      status: 'completed',
      sourceChainId: 5042002,
      destinationChainId: 11155111,
      verifiedComplete: true,
    })).toBeUndefined();
    expect(shouldShowBridgeWrongNetwork({
      isConnected: true,
      walletChainId: 11155111,
      requiredChainId: getRequiredBridgeChainId({
        status: 'completed',
        sourceChainId: 5042002,
        destinationChainId: 11155111,
        verifiedComplete: true,
      }),
    })).toBe(false);
  });

  it('shows wrong-network only for a connected wallet while an action requires another chain', () => {
    expect(shouldShowBridgeWrongNetwork({ isConnected: true, walletChainId: 11155111, requiredChainId: 5042002 })).toBe(true);
    expect(shouldShowBridgeWrongNetwork({ isConnected: true, walletChainId: 5042002, requiredChainId: 5042002 })).toBe(false);
    expect(shouldShowBridgeWrongNetwork({ isConnected: false, walletChainId: 11155111, requiredChainId: 5042002 })).toBe(false);
    expect(shouldShowBridgeWrongNetwork({ isConnected: true, walletChainId: 11155111, requiredChainId: undefined })).toBe(false);
    expect(shouldShowBridgeWrongNetwork({ isConnected: true, requiredChainId: 5042002 })).toBe(true);
  });

  it('reacts to a wallet network switch without masking a still-wrong chain', () => {
    const requiredChainId = getRequiredBridgeChainId({ status: 'idle', sourceChainId: 5042002, destinationChainId: 11155111, sourceActionReady: true });
    expect(shouldShowBridgeWrongNetwork({ isConnected: true, walletChainId: 11155111, requiredChainId })).toBe(true);
    expect(shouldShowBridgeWrongNetwork({ isConnected: true, walletChainId: 5042002, requiredChainId })).toBe(false);
  });

  it('requires the selected source chain again only when a failed source action is retryable', () => {
    expect(getRequiredBridgeChainId({ status: 'error', sourceChainId: 5042002, destinationChainId: 11155111 })).toBeUndefined();
    expect(getRequiredBridgeChainId({ status: 'error', sourceChainId: 5042002, destinationChainId: 11155111, sourceActionReady: true })).toBe(5042002);
    expect(getRequiredBridgeChainId({ status: 'error', sourceChainId: 5042002, destinationChainId: 11155111, sourceHash })).toBeUndefined();
  });
});

describe('Bridge quote readiness', () => {
  const sourceToken = { chainId: 5042002, address: '0x1111111111111111111111111111111111111111' as Address, symbol: 'USDC', name: 'Arc USDC', decimals: 6, isNative: false };
  const destinationToken = { chainId: 11155111, address: '0x2222222222222222222222222222222222222222' as Address, symbol: 'USDC', name: 'Sepolia USDC', decimals: 6, isNative: false };
  const quote = {
    id: 'quote',
    provider: 'Circle',
    fromChain: { id: sourceToken.chainId, name: 'Arc Testnet' },
    toChain: { id: destinationToken.chainId, name: 'Ethereum Sepolia' },
    fromToken: sourceToken,
    toToken: destinationToken,
    recipientAddress: recipient,
    fromAmount: amount,
    toAmount: amount,
    toAmountMin: amount,
    feeAmount: 0n,
    gasAmount: null,
    gasCosts: [],
    executionDurationSeconds: null,
    transactionTarget: transmitter,
    transactionData: '0x1234' as Hex,
    transactionValue: 0n,
    bridge: 'CCTP',
    selectedRoute: 'cctp' as const,
    quotedAt: 10_000,
    raw: {},
  };

  it('accepts only a quote matching the current token pair, amount, and age', () => {
    const currentInput = { quote, sourceChainId: sourceToken.chainId, destinationChainId: destinationToken.chainId, sourceToken, destinationToken, recipientAddress: recipient, amount, now: 10_100 };
    expect(isBridgeQuoteCurrent(currentInput)).toBe(true);
    expect(isBridgeQuoteCurrent({ ...currentInput, amount: amount + 1n })).toBe(false);
    expect(isBridgeQuoteCurrent({ ...currentInput, destinationChainId: sourceToken.chainId })).toBe(false);
    expect(isBridgeQuoteCurrent({ ...currentInput, selectedRoute: 'cctp' })).toBe(true);
    expect(isBridgeQuoteCurrent({ ...currentInput, selectedRoute: 'forwarding' })).toBe(false);
    expect(isBridgeQuoteCurrent({ ...currentInput, recipientAddress: source })).toBe(false);
    expect(isBridgeQuoteCurrent({ ...currentInput, now: 40_001 })).toBe(false);
    expect(isBridgeQuoteCurrent({ ...currentInput, now: 9_999 })).toBe(false);
  });
});

describe('Forwarding completion coordination', () => {
  it('reports forwarding reconciliation timeout unless cancellation or destination completion won the race', () => {
    expect(shouldReportForwardingReconciliationTimeout({ cancelled: false, completed: false })).toBe(true);
    expect(shouldReportForwardingReconciliationTimeout({ cancelled: true, completed: false })).toBe(false);
    expect(shouldReportForwardingReconciliationTimeout({ cancelled: false, completed: true })).toBe(false);
  });

  it('allows retrying only the forwarding status check after timeout, never a second source transaction', () => {
    const retry = { status: 'error' as const, selectedRoute: 'forwarding' as const, sourceHash, destinationVerified: false, timedOut: true };
    expect(canRetryForwardingReconciliation(retry)).toBe(true);
    expect(canRetryForwardingReconciliation({ ...retry, timedOut: false })).toBe(false);
    expect(canRetryForwardingReconciliation({ ...retry, destinationVerified: true })).toBe(false);
    expect(canRetryForwardingReconciliation({ ...retry, selectedRoute: 'cctp' })).toBe(false);
  });

  it('skips the duplicate first reconciliation request after the initial forwarding result', () => {
    expect(shouldSkipInitialForwardingStatusPoll(true)).toBe(true);
    expect(shouldSkipInitialForwardingStatusPoll(false)).toBe(false);
  });

  it('does not apply a stale pending result after forwarding completes', () => {
    expect(canApplyForwardingPending(false)).toBe(true);
    expect(canApplyForwardingPending(true)).toBe(false);
    expect(canShowBridgeSuccess({ status: 'completed', sourceHash, destinationHash, destinationVerified: true })).toBe(true);
  });

  it('disables generic CCTP polling only for forwarding routes', () => {
    expect(isBridgeStatusPollingEnabled('forwarding')).toBe(false);
    expect(isBridgeStatusPollingEnabled('cctp')).toBe(true);
    expect(isBridgeStatusPollingEnabled(undefined)).toBe(true);
    expect(isBridgeStatusPollingEnabled('cctp', false)).toBe(false);
  });
});

describe('Bridge explorer links', () => {
  it.each([
    [5042002, 'https://testnet.arcscan.app/tx/'],
    [11155111, 'https://sepolia.etherscan.io/tx/'],
    [84532, 'https://sepolia.basescan.org/tx/'],
    [421614, 'https://sepolia.arbiscan.io/tx/'],
    [11155420, 'https://sepolia-optimism.etherscan.io/tx/'],
    [43113, 'https://testnet.snowtrace.io/tx/'],
    [80002, 'https://amoy.polygonscan.com/tx/'],
  ])('resolves supported testnet %s destination transactions', (chainId, explorer) => {
    expect(bridgeExplorerUrl(chainId, destinationHash)).toBe(`${explorer}${destinationHash}`);
  });
});

describe('Bridge route labels', () => {
  it('reflects the selected route without changing execution behavior', () => {
    expect(getBridgeRouteLabel('forwarding')).toBe('Circle Forwarding');
    expect(getBridgeRouteLabel('cctp')).toBe('Standard CCTP V2');
    expect(getBridgeRouteLabel()).toBe('Standard CCTP V2');
  });
});

describe('Bridge lifecycle status', () => {
  it('shows Circle forwarding after the source burn is confirmed', () => {
    expect(getBridgeLifecycleStatus('source-pending', true)).toBe('Confirm the source USDC transfer in your wallet.');
    expect(getBridgeLifecycleStatus('source-pending', true, { source: true })).toContain('Waiting for source confirmation');
    expect(getBridgeLifecycleStatus('source-confirmed', true)).toBe('Source confirmed · Circle forwarding');
    expect(getBridgeLifecycleStatus('destination-pending', true)).toBe('Circle forwarding in progress.');
    expect(getBridgeLifecycleStatus('destination-pending', true, { destination: true })).toContain('Verifying destination');
  });

  describe('Bridge progress tracker', () => {
    it('shows forwarding settlement as background work without a destination wallet step', () => {
      const steps = getBridgeProgressSteps('source-confirmed', 'forwarding');
      expect(steps.map((step) => step.label)).toEqual([
        'Preparing transaction',
        'Waiting for source wallet confirmation',
        'Source transaction submitted',
        'Source confirmed · destination processing',
        'Destination transaction submitted · verifying',
        'Destination completed',
      ]);
      expect(steps[3].state).toBe('active');
    });

    it('shows Standard CCTP destination confirmation only after attestation is ready', () => {
      const steps = getBridgeProgressSteps('attestation-ready', 'cctp');
      expect(steps.map((step) => step.label)).toContain('Waiting for destination mint confirmation');
      expect(steps.find((step) => step.label === 'Waiting for destination mint confirmation')?.state).toBe('active');
      expect(steps.map((step) => step.label)).not.toContain('Destination transaction submitted · verifying');
    });

    it('marks all route-specific steps complete only after destination verification sets completed', () => {
      const destinationConfirmedSteps = getBridgeProgressSteps('destination-confirmed', 'cctp');
      expect(destinationConfirmedSteps[destinationConfirmedSteps.length - 1]?.state).toBe('upcoming');
      expect(getBridgeProgressSteps('completed', 'cctp').every((step) => step.state === 'complete')).toBe(true);
      expect(getBridgeProgressSteps('preflight', 'forwarding')[0].state).toBe('active');
      expect(isBridgeExecutionStarted('preflight')).toBe(true);
    });

    it('warns of an ambiguous destination submission rather than suggesting another wallet confirmation', () => {
      const steps = getBridgeProgressSteps('error', 'cctp', { source: true, destinationSubmissionAttempted: true });
      expect(steps.find((step) => step.state === 'active')?.label).toBe('Destination submission uncertain · verify Sepolia activity');
    });
  });

  describe('compact Bridge progress presentation', () => {
    it('shows concise forwarding steps without a destination wallet confirmation', () => {
      const steps = getCompactBridgeProgressSteps('source-confirmed', 'forwarding', { sourceHash: true });
      expect(steps.map((step) => step.label)).toEqual([
        'Preparing',
        'Confirm in wallet',
        'Source confirmed',
        'Processing transfer',
        'Complete',
      ]);
      expect(steps[3].state).toBe('active');
    });

    it('shows a separate destination mint confirmation for Standard CCTP', () => {
      const steps = getCompactBridgeProgressSteps('attestation-ready', 'cctp', { sourceHash: true });
      expect(steps.map((step) => step.label)).toContain('Confirm destination mint');
      expect(steps.find((step) => step.label === 'Confirm destination mint')?.state).toBe('active');
    });

    it('does not mark completion until destination verification succeeds', () => {
      const unverified = getCompactBridgeProgressSteps('completed', 'forwarding', { sourceHash: true });
      expect(unverified[3]?.state).toBe('active');
      expect(unverified[4]?.state).toBe('upcoming');
      expect(getCompactBridgeProgressSteps('completed', 'forwarding', { sourceHash: true, destinationVerified: true }).every((step) => step.state === 'complete')).toBe(true);
      expect(getCompactBridgeStatus('completed', true, { destinationVerified: false })).toBe('Verifying destination receipt.');
      expect(getCompactBridgeStatus('completed', true, { destinationVerified: true })).toBe('Transfer complete; destination receipt verified.');
    });

    it('keeps errors from implying successful completion', () => {
      const steps = getCompactBridgeProgressSteps('error', 'cctp', { sourceHash: true });
      expect(steps[steps.length - 1]?.state).toBe('upcoming');
    });

    it('does not invite another mint confirmation after an ambiguous submission', () => {
      const steps = getCompactBridgeProgressSteps('error', 'cctp', { sourceHash: true, destinationSubmissionAttempted: true });
      expect(steps.map((step) => step.label)).toContain('Verify destination transaction');
      expect(steps.map((step) => step.label)).not.toContain('Confirm destination mint');
    });
  });

  it('keeps the existing CCTP lifecycle labels', () => {
    expect(getBridgeLifecycleStatus('source-confirmed', false)).toBe('Source confirmed · Waiting for Circle attestation.');
    expect(getBridgeLifecycleStatus('destination-pending', false)).toBe('Confirm the destination mint in your wallet.');
    expect(getBridgeLifecycleStatus('destination-pending', false, { destination: true })).toContain('Waiting for confirmation');
  });

  it('distinguishes forwarding approval, source burn, and Circle settlement stages', () => {
    expect(getBridgeLifecycleStatus('approval-pending', true)).toContain('approval');
    expect(getBridgeLifecycleStatus('approval-confirmed', true)).toContain('confirmed');
    expect(getBridgeLifecycleStatus('attestation-pending', false)).toContain('Circle attestation');
    expect(getBridgeLifecycleStatus('attestation-ready', false)).toContain('destination confirmation');
  });
});

describe('Bridge success reset gating', () => {
  it('clears the amount only after the destination receipt is verified', () => {
    expect(shouldResetBridgeAmount({ status: 'source-pending', sourceHash, destinationVerified: false })).toBe(false);
    expect(shouldResetBridgeAmount({ status: 'source-confirmed', sourceHash, destinationVerified: false })).toBe(false);
    expect(shouldResetBridgeAmount({ status: 'completed', sourceHash, destinationHash, destinationVerified: false })).toBe(false);
    expect(shouldResetBridgeAmount({ status: 'completed', sourceHash, destinationHash, destinationVerified: true })).toBe(true);
  });
});

describe('Bridge execution reset gating', () => {
  it.each(['route', 'amount', 'account', 'source network'])('resets stale state when %s changes before a burn', (change) => {
    expect(shouldResetBridgeExecution({ routeChanged: change === 'route', amountChanged: change === 'amount', accountChanged: change === 'account', sourceNetworkChanged: change === 'source network' })).toBe(true);
  });

  it('preserves an active source lifecycle across unrelated changes', () => {
    expect(shouldResetBridgeExecution({ status: 'source-confirmed', sourceHash, routeChanged: true, amountChanged: true, accountChanged: true, sourceNetworkChanged: true })).toBe(false);
    expect(shouldResetBridgeExecution({ status: 'source-pending', routeChanged: false, amountChanged: false, accountChanged: true, sourceNetworkChanged: false })).toBe(false);
    expect(shouldResetBridgeExecution({ status: 'preflight', routeChanged: false, amountChanged: false, accountChanged: true, sourceNetworkChanged: false })).toBe(false);
    expect(shouldResetBridgeExecution({ status: 'idle', routeChanged: false, amountChanged: false, accountChanged: true, sourceNetworkChanged: false })).toBe(true);
  });
});

describe('Bridge execution one-shot guards', () => {
  it('only allows a single source bridge submission for the same lock key', () => {
    const guard = createBridgeExecutionOneShotGuard();
    const key = 'source:5042002:11155111:0xabc:1000000:0xdeadbeef:route';
    expect(guard.claim(key)).toBe(true);
    expect(guard.claim(key)).toBe(false);
    guard.release(key);
    expect(guard.claim(key)).toBe(true);
  });

  it('only allows a single destination completion for the same sourceHash + attestation', () => {
    const guard = createBridgeExecutionOneShotGuard();
    const key = `${sourceHash}:0x4444:0x5555`;
    expect(guard.claim(key)).toBe(true);
    expect(guard.claim(key)).toBe(false);
  });

  it('marks source execution as started after the burn is submitted', () => {
    expect(isBridgeExecutionStarted('idle', undefined)).toBe(false);
    expect(isBridgeExecutionStarted('source-pending', undefined)).toBe(true);
    expect(isBridgeExecutionStarted('source-confirmed', sourceHash)).toBe(true);
    expect(isBridgeExecutionStarted('completed', sourceHash)).toBe(true);
  });

  it('keeps the initial approval and review actions available before execution starts', () => {
    expect(shouldShowBridgeApprovalAction({ status: 'idle', approvalRequired: true })).toBe(true);
    expect(shouldShowBridgeReviewAction({ status: 'idle', approvalRequired: false, bridgeReady: true })).toBe(true);
  });

  it('hides approval and review actions once source bridge execution has started', () => {
    expect(shouldShowBridgeApprovalAction({ status: 'source-pending', sourceHash, approvalRequired: true })).toBe(false);
    expect(shouldShowBridgeApprovalAction({ status: 'source-confirmed', sourceHash, approvalRequired: true })).toBe(false);
    expect(shouldShowBridgeReviewAction({ status: 'source-pending', sourceHash, approvalRequired: false, bridgeReady: true })).toBe(false);
  });
});

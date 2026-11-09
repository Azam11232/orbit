import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldShowBridgeReviewAction } from '../App';
import { canShowBridgeSuccess, createBridgeCompletionGate, getCompactBridgeProgressSteps, getCompactBridgeStatus, getRequiredBridgeChainId, isBridgeExecutionStarted, preserveCompletedBridgeStatus, shouldResetBridgeExecution, shouldShowBridgeWrongNetwork, shouldShowCctpDestinationMintAction, useBridgeExecution } from './useBridgeExecution';

vi.mock('wagmi', async (importOriginal) => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useAccount: () => ({ address: undefined, chainId: undefined, connector: undefined }),
  usePublicClient: () => undefined,
  useSendTransaction: () => ({ sendTransactionAsync: vi.fn() }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fresh Bridge initialization', () => {
  it('keeps idle progress inactive and exposes success only after destination verification', () => {
    const idleSteps = getCompactBridgeProgressSteps('idle');
    expect(idleSteps).toHaveLength(5);
    expect(idleSteps.every((step) => step.state === 'pending')).toBe(true);
    expect(isBridgeExecutionStarted('idle')).toBe(false);
    expect(canShowBridgeSuccess({ status: 'completed', destinationVerified: false })).toBe(false);
    expect(canShowBridgeSuccess({
      status: 'completed',
      sourceHash: `0x${'a'.repeat(64)}` as `0x${string}`,
      destinationHash: `0x${'b'.repeat(64)}` as `0x${string}`,
      destinationVerified: true,
    })).toBe(true);
  });

  it('does not restore a saved recovery record during server rendering', () => {
    const savedRecovery = JSON.stringify({ status: 'pending', sourceHash: `0x${'a'.repeat(64)}` });
    const getItem = vi.fn(() => savedRecovery);
    const setItem = vi.fn();
    const removeItem = vi.fn();
    const savedBridgeKey = `orbit:bridge-recovery:v2:0x1111111111111111111111111111111111111111:0x${'a'.repeat(64)}`;
    vi.stubGlobal('window', {
      localStorage: {
        getItem,
        setItem,
        removeItem,
        length: 1,
        key: () => savedBridgeKey,
      },
    });

    function StateProbe() {
      const execution = useBridgeExecution(undefined);
      return createElement('output', {
        'data-status': execution.status,
        'data-source-hash': execution.sourceHash ?? '',
        'data-destination-hash': execution.destinationHash ?? '',
        'data-submitting': String(execution.isSubmitting),
      });
    }

    const firstVisitMarkup = renderToString(createElement(StateProbe));
    const refreshedMarkup = renderToString(createElement(StateProbe));

    for (const markup of [firstVisitMarkup, refreshedMarkup]) {
      expect(markup).toContain('data-status="idle"');
      expect(markup).toContain('data-source-hash=""');
      expect(markup).toContain('data-destination-hash=""');
      expect(markup).toContain('data-submitting="false"');
    }
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(isBridgeExecutionStarted('idle')).toBe(false);
    expect(getCompactBridgeProgressSteps('idle').every((step) => step.state === 'pending')).toBe(true);
    expect(shouldShowBridgeReviewAction({
      status: 'idle',
      approvalRequired: false,
      bridgeReady: true,
    })).toBe(true);
  });

  it('does not expose a new submission action after a source submission was attempted', () => {
    expect(shouldShowBridgeReviewAction({
      status: 'error',
      approvalRequired: false,
      bridgeReady: true,
      sourceSubmissionAttempted: true,
    })).toBe(false);
  });

  it('does not clear an ambiguous source submission when the wallet account changes', () => {
    expect(shouldResetBridgeExecution({
      status: 'error',
      sourceSubmissionAttempted: true,
      routeChanged: false,
      amountChanged: false,
      accountChanged: true,
      sourceNetworkChanged: false,
    })).toBe(false);
  });
});

describe('forwarding route network requirements', () => {
  it('does not request a destination wallet switch during automatic forwarding processing', () => {
    const requiredChainId = getRequiredBridgeChainId({
      status: 'attestation-ready',
      sourceChainId: 5042002,
      destinationChainId: 11155111,
      selectedRoute: 'forwarding',
      sourceHash: `0x${'a'.repeat(64)}` as `0x${string}`,
    });

    expect(requiredChainId).toBeUndefined();
    expect(shouldShowBridgeWrongNetwork({
      isConnected: true,
      walletChainId: 5042002,
      requiredChainId,
    })).toBe(false);
  });

  it('still requests the destination chain when a CCTP mint needs a wallet signature', () => {
    expect(getRequiredBridgeChainId({
      status: 'attestation-ready',
      sourceChainId: 5042002,
      destinationChainId: 11155111,
      selectedRoute: 'cctp',
      sourceHash: `0x${'a'.repeat(64)}` as `0x${string}`,
    })).toBe(11155111);
  });

  it('requires the destination chain when verifying a previously submitted CCTP mint', () => {
    expect(getRequiredBridgeChainId({
      status: 'error',
      sourceChainId: 5042002,
      destinationChainId: 11155111,
      selectedRoute: 'cctp',
      sourceHash: `0x${'a'.repeat(64)}` as `0x${string}`,
      destinationHash: `0x${'b'.repeat(64)}` as `0x${string}`,
    })).toBe(11155111);
  });

  it('keeps automatic forwarding in processing and never offers destination wallet confirmation', () => {
    expect(getCompactBridgeStatus('attestation-ready', true)).toBe('Circle is processing the transfer.');
    expect(shouldShowCctpDestinationMintAction({
      selectedRoute: 'cctp',
      status: 'DONE',
      message: '0x1234',
      attestation: '0xabcd',
    })).toBe(true);
    expect(shouldShowCctpDestinationMintAction({
      selectedRoute: 'forwarding',
      status: 'DONE',
      message: '0x1234',
      attestation: '0xabcd',
    })).toBe(false);
    expect(getCompactBridgeStatus('attestation-ready', false)).toBe('Circle attestation received. Confirm the destination mint.');
  });
});

describe('idempotent verified completion', () => {
  it('shows success only after verified completion and only accepts completion once', () => {
    const completionGate = createBridgeCompletionGate();
    const sourceHash = `0x${'a'.repeat(64)}` as `0x${string}`;
    const destinationHash = `0x${'b'.repeat(64)}` as `0x${string}`;
    let popupTransitions = 0;

    expect(canShowBridgeSuccess({ status: 'destination-pending', sourceHash, destinationHash, destinationVerified: false })).toBe(false);
    if (completionGate.markComplete(sourceHash)) popupTransitions += 1;
    expect(canShowBridgeSuccess({ status: 'completed', sourceHash, destinationHash, destinationVerified: true })).toBe(true);
    if (completionGate.markComplete(sourceHash)) popupTransitions += 1;

    expect(popupTransitions).toBe(1);
  });

  it('does not let a late status response regress a completed bridge', () => {
    expect(preserveCompletedBridgeStatus('completed', 'source-confirmed')).toBe('completed');
    expect(preserveCompletedBridgeStatus('completed', 'attestation-ready')).toBe('completed');
    expect(preserveCompletedBridgeStatus('destination-pending', 'completed')).toBe('completed');
  });
});

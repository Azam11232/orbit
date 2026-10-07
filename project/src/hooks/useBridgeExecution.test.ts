import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { bridgeExplorerUrl, getBridgeRouteLabel, getBridgeSuccessDestinationHash, shouldShowBridgeApprovalAction, shouldShowBridgeReviewAction } from '../App';
import { canApplyForwardingPending, canShowBridgeSuccess, createBridgeExecutionOneShotGuard, getRequiredBridgeChainId, getRequiredSourceDebit, isBridgeExecutionStarted, shouldAutoCompleteBridge, shouldReadAppSourceBalance, shouldResetBridgeExecution, shouldSkipInitialForwardingStatusPoll, verifyDestinationReceipt } from './useBridgeExecution';
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
  it('uses the source chain during the source lifecycle and the destination chain during the destination lifecycle', () => {
    expect(getRequiredBridgeChainId({ status: 'source-pending', sourceChainId: 1, destinationChainId: 2 })).toBe(1);
    expect(getRequiredBridgeChainId({ status: 'source-confirmed', sourceChainId: 1, destinationChainId: 2 })).toBe(1);
    expect(getRequiredBridgeChainId({ status: 'attestation-ready', sourceChainId: 1, destinationChainId: 2 })).toBe(1);
    expect(getRequiredBridgeChainId({ status: 'destination-pending', sourceChainId: 1, destinationChainId: 2 })).toBe(2);
    expect(getRequiredBridgeChainId({ status: 'destination-confirmed', sourceChainId: 1, destinationChainId: 2 })).toBe(2);
    expect(getRequiredBridgeChainId({ status: 'verification-pending', sourceChainId: 1, destinationChainId: 2 })).toBe(2);
    expect(getRequiredBridgeChainId({ status: 'completed', sourceChainId: 1, destinationChainId: 2 })).toBe(1);
  });

  it('keeps the source chain required throughout forwarding settlement', () => {
    for (const status of ['destination-pending', 'destination-confirmed', 'verification-pending'] as const) {
      expect(getRequiredBridgeChainId({ status, sourceChainId: 1, destinationChainId: 2, forwarding: true })).toBe(1);
    }
  });

  it('continues requiring the destination chain for standard CCTP settlement', () => {
    expect(getRequiredBridgeChainId({ status: 'destination-pending', sourceChainId: 1, destinationChainId: 2, forwarding: false })).toBe(2);
  });
});

describe('Forwarding completion coordination', () => {
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
    expect(getBridgeRouteLabel('cctp')).toBe('CCTP V2');
    expect(getBridgeRouteLabel()).toBe('CCTP V2');
  });
});

describe('Bridge execution reset gating', () => {
  it.each(['route', 'amount', 'account', 'source network'])('resets stale state when %s changes before a burn', (change) => {
    expect(shouldResetBridgeExecution({ routeChanged: change === 'route', amountChanged: change === 'amount', accountChanged: change === 'account', sourceNetworkChanged: change === 'source network' })).toBe(true);
  });

  it('preserves an active source lifecycle across unrelated changes', () => {
    expect(shouldResetBridgeExecution({ sourceHash, routeChanged: true, amountChanged: true, accountChanged: true, sourceNetworkChanged: true })).toBe(false);
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

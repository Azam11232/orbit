import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Address, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import {
  claimGatewayDepositNotification,
  refetchGatewayBalanceSources,
  isGatewayDepositAvailabilityVerified,
  verifyFastGatewayDestinationReceipt,
  verifyFastGatewaySourceReceipt,
  verifyGatewayMintReceipt,
  verifyGatewayTransactionReceipt,
} from './useGateway';
import { getFastGatewayDepositRoute } from '../services/gatewayFastDeposit';

const minter = '0x1111111111111111111111111111111111111111' as Address;
const token = '0x2222222222222222222222222222222222222222' as Address;
const recipient = '0x3333333333333333333333333333333333333333' as Address;
const source = '0x4444444444444444444444444444444444444444' as Address;

function mintTransferLog(to = recipient, amount = 2_000_000n) {
  return {
    address: token,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: source, to } }) as readonly Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
  };
}

function burnTransferLog(
  to = '0x0000000000000000000000000000000000000000' as Address,
  amount = 2_000_000n,
  from = source,
) {
  return {
    address: token,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }) as readonly Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
  };
}

describe('Gateway transaction receipt verification', () => {
  it('accepts a successful deposit receipt sent to the Gateway wallet', () => {
    expect(verifyGatewayTransactionReceipt({ status: 'success', to: minter, expectedTo: minter })).toBe(true);
  });

  it.each([
    ['reverted receipt', { status: 'reverted' as const, to: minter }],
    ['wrong contract', { status: 'success' as const, to: token }],
    ['missing recipient', { status: 'success' as const, to: null }],
  ])('rejects a %s', (_description, receipt) => {
    expect(verifyGatewayTransactionReceipt({ ...receipt, expectedTo: minter })).toBe(false);
  });

  it('accepts only a confirmed destination Gateway mint with a USDC transfer to the wallet', () => {
    expect(verifyGatewayMintReceipt({
      status: 'success',
      to: minter,
      expectedMinter: minter,
      expectedToken: token,
      recipient,
      logs: [mintTransferLog()],
    })).toBe(true);
  });

  it.each([
    ['reverted receipt', { status: 'reverted' as const }],
    ['wrong minter', { to: token }],
    ['wrong token', { logs: [{ ...mintTransferLog(), address: minter }] }],
    ['wrong recipient', { logs: [mintTransferLog(source)] }],
    ['zero transfer', { logs: [mintTransferLog(recipient, 0n)] }],
  ])('rejects destination mint with %s', (_description, override) => {
    expect(verifyGatewayMintReceipt({
      status: 'success',
      to: minter,
      expectedMinter: minter,
      expectedToken: token,
      recipient,
      logs: [mintTransferLog()],
      ...override,
    })).toBe(false);
  });
});

describe('Circle Fast Gateway Deposit', () => {
  it('claims a source-confirmation notification at most once per transaction hash', () => {
    const notifiedHashes = new Set<string>();
    expect(claimGatewayDepositNotification('0xabc' as Hex, notifiedHashes)).toBe(true);
    expect(claimGatewayDepositNotification('0xabc' as Hex, notifiedHashes)).toBe(false);
    expect(claimGatewayDepositNotification('0xdef' as Hex, notifiedHashes)).toBe(true);
  });

  it('does not consider a fast deposit available before verified destination execution', () => {
    expect(isGatewayDepositAvailabilityVerified('FAST', false)).toBe(false);
    expect(isGatewayDepositAvailabilityVerified('FAST', true)).toBe(true);
    expect(isGatewayDepositAvailabilityVerified('STANDARD', false)).toBe(true);
  });

  it('accepts the installed SDK route from Ethereum Sepolia to Arc Testnet', () => {
    expect(getFastGatewayDepositRoute(0, 26)).toMatchObject({
      sourceChain: 'Ethereum_Sepolia',
      destinationChain: 'Arc_Testnet',
      sourceTokenMessengerWithFees: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
      destinationGenericExecutor: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
      destinationGatewayWallet: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
    });
  });

  it.each([[0, 0], [26, 0], [0, 6]])('rejects unsupported Fast route %i → %i', (sourceDomain, destinationDomain) => {
    expect(getFastGatewayDepositRoute(sourceDomain, destinationDomain)).toBeNull();
  });

  it('verifies a successful source burn by its USDC burn event', () => {
    expect(verifyFastGatewaySourceReceipt({
      status: 'success',
      to: minter,
      expectedMessenger: minter,
      expectedToken: token,
      depositor: source,
      minimumAmount: 2_000_000n,
      logs: [burnTransferLog()],
    })).toBe(true);
  });

  it.each([
    ['wrong burn recipient', { logs: [burnTransferLog(minter)] }],
    ['wrong depositor', { logs: [burnTransferLog('0x0000000000000000000000000000000000000000' as Address, 2_000_000n, recipient)] }],
    ['insufficient burned amount', { logs: [burnTransferLog('0x0000000000000000000000000000000000000000' as Address, 1_000_000n)] }],
    ['wrong messenger', { to: token }],
    ['reverted source transaction', { status: 'reverted' as const }],
  ])('rejects an unverified source burn: %s', (_description, override) => {
    expect(verifyFastGatewaySourceReceipt({
      status: 'success',
      to: minter,
      expectedMessenger: minter,
      expectedToken: token,
      depositor: source,
      minimumAmount: 2_000_000n,
      logs: [burnTransferLog()],
      ...override,
    })).toBe(false);
  });

  it('requires a successful destination receipt from Arc Generic Executor', () => {
    expect(verifyFastGatewayDestinationReceipt({ status: 'success', to: minter, expectedExecutor: minter })).toBe(true);
    expect(verifyFastGatewayDestinationReceipt({ status: 'success', to: token, expectedExecutor: minter })).toBe(false);
    expect(verifyFastGatewayDestinationReceipt({ status: 'reverted', to: minter, expectedExecutor: minter })).toBe(false);
  });
});

describe('Unified Balance refresh', () => {
  it('refetches wallet, Gateway, selected wallet balance, and allowance sources together', async () => {
    const wallet = vi.fn().mockResolvedValue(undefined);
    const circle = vi.fn().mockResolvedValue(undefined);
    const selectedWallet = vi.fn().mockResolvedValue(undefined);
    const allowance = vi.fn().mockResolvedValue(undefined);
    await refetchGatewayBalanceSources(wallet, circle, selectedWallet, allowance);
    expect(wallet).toHaveBeenCalledOnce();
    expect(circle).toHaveBeenCalledOnce();
    expect(selectedWallet).toHaveBeenCalledOnce();
    expect(allowance).toHaveBeenCalledOnce();
  });

  it('rejects a refresh when a balance source fails so the UI can report and retry it', async () => {
    const wallet = vi.fn().mockResolvedValue(undefined);
    const circle = vi.fn().mockRejectedValue(new Error('Gateway API unavailable'));
    await expect(refetchGatewayBalanceSources(wallet, circle, vi.fn(), vi.fn())).rejects.toThrow('Gateway API unavailable');
    expect(wallet).toHaveBeenCalledOnce();
    expect(circle).toHaveBeenCalledOnce();
  });
});

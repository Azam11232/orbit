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
import { gatewayWalletAbi } from '../services/gateway';

const minter = '0x1111111111111111111111111111111111111111' as Address;
const token = '0x2222222222222222222222222222222222222222' as Address;
const recipient = '0x3333333333333333333333333333333333333333' as Address;
const source = '0x4444444444444444444444444444444444444444' as Address;
const handler = '0x5555555555555555555555555555555555555555' as Address;
const executor = '0x7777777777777777777777777777777777777777' as Address;
const wallet = '0x6666666666666666666666666666666666666666' as Address;
const zeroAddress = '0x0000000000000000000000000000000000000000' as Address;

function transferLog(from: Address, to: Address, amount: bigint) {
  return {
    address: token,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }) as readonly Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
  };
}

function mintTransferLog(to = recipient, amount = 2_000_000n, from = zeroAddress) {
  return transferLog(from, to, amount);
}

function burnTransferLog(
  to = zeroAddress,
  amount = 2_000_000n,
  from = source,
) {
  return transferLog(from, to, amount);
}

function depositedLog(
  depositor = recipient,
  amount = 2_000_000n,
  depositToken = token,
  sender = handler,
) {
  return {
    address: wallet,
    topics: encodeEventTopics({
      abi: gatewayWalletAbi,
      eventName: 'Deposited',
      args: { token: depositToken, depositor, sender },
    }) as readonly Hex[],
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
      expectedAmount: 2_000_000n,
      logs: [mintTransferLog()],
    })).toBe(true);
  });

  it.each([
    ['reverted receipt', { status: 'reverted' as const }],
    ['wrong minter', { to: token }],
    ['wrong token', { logs: [{ ...mintTransferLog(), address: minter }] }],
    ['wrong recipient', { logs: [mintTransferLog(source)] }],
    ['wrong mint source', { logs: [mintTransferLog(recipient, 2_000_000n, source)] }],
    ['underpayment', { logs: [mintTransferLog(recipient, 1_999_999n)] }],
    ['overpayment', { logs: [mintTransferLog(recipient, 2_000_001n)] }],
    ['duplicate matching transfers', { logs: [mintTransferLog(), mintTransferLog()] }],
    ['unrelated transfer only', { logs: [mintTransferLog(source)] }],
    ['malformed matching transfer', { logs: [{ ...mintTransferLog(), data: '0x' as Hex }] }],
  ])('rejects destination mint with %s', (_description, override) => {
    expect(verifyGatewayMintReceipt({
      status: 'success',
      to: minter,
      expectedMinter: minter,
      expectedToken: token,
      recipient,
      expectedAmount: 2_000_000n,
      logs: [mintTransferLog()],
      ...override,
    })).toBe(false);
  });

  it('compares exact mint amounts without losing bigint precision', () => {
    const expectedAmount = (1n << 128n) + 71n;
    expect(verifyGatewayMintReceipt({
      status: 'success',
      to: minter,
      expectedMinter: minter,
      expectedToken: token,
      recipient,
      expectedAmount,
      logs: [mintTransferLog(recipient, expectedAmount)],
    })).toBe(true);
    expect(verifyGatewayMintReceipt({
      status: 'success',
      to: minter,
      expectedMinter: minter,
      expectedToken: token,
      recipient,
      expectedAmount,
      logs: [mintTransferLog(recipient, expectedAmount + 1n)],
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
    ['underpaid burned amount', { logs: [burnTransferLog(zeroAddress, 1_999_999n)] }],
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

  it('verifies the exact USDC transfer and Gateway account credit in the destination receipt', () => {
    const input = {
      status: 'success' as const,
      to: executor,
      expectedExecutor: executor,
      expectedWallet: wallet,
      expectedToken: token,
      recipient,
      expectedAmount: 2_000_000n,
      logs: [transferLog(handler, wallet, 2_000_000n), depositedLog()],
    };
    expect(verifyFastGatewayDestinationReceipt(input)).toBe(true);
    expect(verifyFastGatewayDestinationReceipt({ ...input, to: token })).toBe(false);
    expect(verifyFastGatewayDestinationReceipt({ ...input, status: 'reverted' })).toBe(false);
  });

  it.each([
    ['underpayment', { logs: [transferLog(handler, wallet, 1_999_999n), depositedLog(recipient, 1_999_999n)] }],
    ['overpayment', { logs: [transferLog(handler, wallet, 2_000_001n), depositedLog(recipient, 2_000_001n)] }],
    ['wrong credited account', { logs: [transferLog(handler, wallet, 2_000_000n), depositedLog(source)] }],
    ['wrong token', { logs: [{ ...transferLog(handler, wallet, 2_000_000n), address: minter }, depositedLog()] }],
    ['sender mismatch', { logs: [transferLog(source, wallet, 2_000_000n), depositedLog()] }],
    ['unrelated transfer only', { logs: [transferLog(handler, recipient, 2_000_000n)] }],
    ['missing Gateway deposit event', { logs: [transferLog(handler, wallet, 2_000_000n)] }],
    ['missing token transfer', { logs: [depositedLog()] }],
    ['duplicate token transfers', { logs: [transferLog(handler, wallet, 2_000_000n), transferLog(handler, wallet, 2_000_000n), depositedLog()] }],
    ['duplicate Gateway deposit events', { logs: [transferLog(handler, wallet, 2_000_000n), depositedLog(), depositedLog()] }],
    ['malformed token transfer', { logs: [{ ...transferLog(handler, wallet, 2_000_000n), data: '0x' as Hex }, depositedLog()] }],
    ['malformed Gateway deposit event', { logs: [transferLog(handler, wallet, 2_000_000n), { ...depositedLog(), data: '0x' as Hex }] }],
  ])('rejects destination receipt with %s', (_description, override) => {
    const input = {
      ...{
        status: 'success' as const,
        to: executor,
        expectedExecutor: executor,
        expectedWallet: wallet,
        expectedToken: token,
        recipient,
        expectedAmount: 2_000_000n,
        logs: [transferLog(handler, wallet, 2_000_000n), depositedLog()],
      },
      ...override,
    };
    expect(verifyFastGatewayDestinationReceipt(input)).toBe(false);
  });

  it('uses bigint precision for the exact fast destination credit', () => {
    const expectedAmount = (1n << 128n) + 73n;
    expect(verifyFastGatewayDestinationReceipt({
      status: 'success',
      to: executor,
      expectedExecutor: executor,
      expectedWallet: wallet,
      expectedToken: token,
      recipient,
      expectedAmount,
      logs: [transferLog(handler, wallet, expectedAmount), depositedLog(recipient, expectedAmount)],
    })).toBe(true);
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

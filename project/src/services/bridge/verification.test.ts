import { encodeAbiParameters, encodeEventTopics, erc20Abi, keccak256, pad, parseAbiItem, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { verifyDestinationReceipt, verifyForwardingDestinationReceipt } from './verification';

const source = '0x1111111111111111111111111111111111111111' as Address;
const recipient = '0x2222222222222222222222222222222222222222' as Address;
const transmitter = '0x3333333333333333333333333333333333333333' as Address;
const token = '0x4444444444444444444444444444444444444444' as Address;
const amount = 5_000_000n;
const nonce = `0x${'0'.repeat(63)}1` as Hex;
const messageBody = '0x1234' as Hex;
const identity = {
  sourceDomain: 3,
  nonce,
  sender: pad(source, { size: 32 }),
  messageBodyHash: keccak256(messageBody),
};
const messageReceivedAbi = [parseAbiItem('event MessageReceived(address indexed caller,uint32 sourceDomain,bytes32 indexed nonce,bytes32 sender,uint32 indexed finalityThresholdExecuted,bytes messageBody)')];

function messageReceivedLog(body = messageBody) {
  return {
    address: transmitter,
    topics: encodeEventTopics({
      abi: messageReceivedAbi,
      eventName: 'MessageReceived',
      args: { caller: source, nonce, finalityThresholdExecuted: 1000 },
    }) as readonly Hex[],
    data: encodeAbiParameters([{ type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes' }], [identity.sourceDomain, identity.sender, body]),
    logIndex: 0,
  };
}

function transferLog(to = recipient, value = amount) {
  return {
    address: token,
    topics: encodeEventTopics({
      abi: erc20Abi,
      eventName: 'Transfer',
      args: { from: source, to },
    }) as readonly Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    logIndex: 1,
  };
}

describe('CCTP destination receipt verification', () => {
  it('accepts a successful receipt with the matching message identity and USDC transfer', () => {
    expect(verifyDestinationReceipt({
      receiptStatus: 'success',
      receiptTo: transmitter,
      expectedMessageTransmitter: transmitter,
      expectedToken: token,
      recipient,
      expectedAmount: amount,
      expectedMessageIdentity: identity,
      logs: [messageReceivedLog(), transferLog()],
    })).toBe(true);
  });

  it('rejects a failed receipt, mismatched message body, wrong recipient, or wrong amount', () => {
    const input = {
      receiptStatus: 'success' as const,
      receiptTo: transmitter,
      expectedMessageTransmitter: transmitter,
      expectedToken: token,
      recipient,
      expectedAmount: amount,
      expectedMessageIdentity: identity,
      logs: [messageReceivedLog(), transferLog()],
    };

    expect(verifyDestinationReceipt({ ...input, receiptStatus: 'reverted' })).toBe(false);
    expect(verifyDestinationReceipt({ ...input, logs: [messageReceivedLog('0xabcd'), transferLog()] })).toBe(false);
    expect(verifyDestinationReceipt({ ...input, logs: [messageReceivedLog(), transferLog(source)] })).toBe(false);
    expect(verifyDestinationReceipt({ ...input, logs: [messageReceivedLog(), transferLog(recipient, amount - 1n)] })).toBe(false);
  });

  it('verifies a Circle forwarding destination USDC transfer from the real receipt', () => {
    const input = {
      receiptStatus: 'success' as const,
      expectedToken: token,
      recipient,
      expectedAmount: amount,
      logs: [transferLog(recipient, amount + 1n)],
    };

    expect(verifyForwardingDestinationReceipt(input)).toBe(true);
    expect(verifyForwardingDestinationReceipt({ ...input, receiptStatus: 'reverted' })).toBe(false);
    expect(verifyForwardingDestinationReceipt({ ...input, logs: [transferLog(source, amount)] })).toBe(false);
    expect(verifyForwardingDestinationReceipt({ ...input, logs: [transferLog(recipient, amount - 1n)] })).toBe(false);
  });
});

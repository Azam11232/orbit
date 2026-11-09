import { decodeEventLog, erc20Abi, keccak256, parseAbiItem, type Address, type Hash, type Hex } from 'viem';

const messageReceivedAbi = [parseAbiItem('event MessageReceived(address indexed caller,uint32 sourceDomain,bytes32 indexed nonce,bytes32 sender,uint32 indexed finalityThresholdExecuted,bytes messageBody)')];

export interface DestinationReceiptVerificationInput {
  receiptStatus: 'success' | 'reverted';
  receiptTo: Address | null;
  expectedMessageTransmitter: Address;
  expectedToken: Address;
  recipient: Address;
  expectedAmount: bigint;
  requireExactAmount?: boolean;
  expectedMessageIdentity: {
    sourceDomain: number;
    nonce: Hex;
    sender: Hex;
    messageBodyHash: Hash;
  };
  logs: readonly {
    address: Address;
    data: Hex;
    topics: readonly Hex[];
    logIndex: number;
  }[];
}

export function verifyDestinationReceipt(input: DestinationReceiptVerificationInput) {
  if (input.receiptStatus !== 'success' || input.expectedAmount <= 0n) return false;
  const expectedMessage = input.logs.some((log) => {
    if (log.address.toLowerCase() !== input.expectedMessageTransmitter.toLowerCase()) return false;
    try {
      const decoded = decodeEventLog({
        abi: messageReceivedAbi,
        data: log.data,
        topics: [...log.topics] as [] | [Hex, ...Hex[]],
      });
      return decoded.eventName === 'MessageReceived' &&
        decoded.args.sourceDomain === input.expectedMessageIdentity.sourceDomain &&
        decoded.args.nonce.toLowerCase() === input.expectedMessageIdentity.nonce.toLowerCase() &&
        decoded.args.sender.toLowerCase() === input.expectedMessageIdentity.sender.toLowerCase() &&
        keccak256(decoded.args.messageBody).toLowerCase() === input.expectedMessageIdentity.messageBodyHash.toLowerCase();
    } catch {
      return false;
    }
  });
  if (!expectedMessage) return false;

  const seenLogIndexes = new Set<number>();
  let receivedAmount = 0n;
  for (const log of input.logs) {
    if (log.address.toLowerCase() !== input.expectedToken.toLowerCase() || seenLogIndexes.has(log.logIndex)) continue;
    seenLogIndexes.add(log.logIndex);
    try {
      const decoded = decodeEventLog({
        abi: erc20Abi,
        data: log.data,
        topics: [...log.topics] as [] | [Hex, ...Hex[]],
      });
      if (decoded.eventName === 'Transfer' && decoded.args.to.toLowerCase() === input.recipient.toLowerCase()) {
        receivedAmount += decoded.args.value;
      }
    } catch {
      continue;
    }
  }
  return input.requireExactAmount === false
    ? receivedAmount >= input.expectedAmount
    : receivedAmount === input.expectedAmount;
}

export interface ForwardingDestinationReceiptInput {
  receiptStatus: 'success' | 'reverted';
  expectedToken: Address;
  recipient: Address;
  expectedAmount: bigint;
  logs: DestinationReceiptVerificationInput['logs'];
}

export function verifyForwardingDestinationReceipt(input: ForwardingDestinationReceiptInput) {
  if (input.receiptStatus !== 'success' || input.expectedAmount <= 0n) return false;
  const seenLogIndexes = new Set<number>();
  let receivedAmount = 0n;

  for (const log of input.logs) {
    if (log.address.toLowerCase() !== input.expectedToken.toLowerCase() || seenLogIndexes.has(log.logIndex)) continue;
    seenLogIndexes.add(log.logIndex);
    try {
      const decoded = decodeEventLog({
        abi: erc20Abi,
        data: log.data,
        topics: [...log.topics] as [] | [Hex, ...Hex[]],
      });
      if (decoded.eventName === 'Transfer' && decoded.args.to.toLowerCase() === input.recipient.toLowerCase()) {
        receivedAmount += decoded.args.value;
      }
    } catch {
      continue;
    }
  }

  return receivedAmount >= input.expectedAmount;
}

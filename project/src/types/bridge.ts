import type { Address, Hex } from 'viem';

export interface BridgeChain {
  id: number;
  name: string;
}

export interface BridgeToken {
  chainId: number;
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  isNative: boolean;
}

export interface BridgeQuoteRequest {
  fromChain: BridgeChain;
  toChain: BridgeChain;
  fromToken: BridgeToken;
  toToken: BridgeToken;
  fromAmount: bigint;
  fromAddress: Address;
  toAddress: Address;
  slippage: number;
}

export interface BridgeQuote {
  id: string;
  provider: string;
  fromChain: BridgeChain;
  toChain: BridgeChain;
  fromToken: BridgeToken;
  toToken: BridgeToken;
  fromAmount: bigint;
  toAmount: bigint | null;
  toAmountMin: bigint | null;
  feeAmount: bigint | null;
  forwardingFeeAmount?: bigint | null;
  protocolFeeAmount?: bigint | null;
  totalSourceDebit?: bigint | null;
  feePayment?: 'source' | 'destination';
  transferSpeed?: string;
  minimumTransferAmount?: bigint | null;
  feeError?: string;
  selectedRoute?: 'forwarding' | 'cctp';
  gasAmount: bigint | null;
  gasCosts: string[];
  executionDurationSeconds: number | null;
  transactionTarget: Address | null;
  transactionData: Hex | null;
  transactionValue: bigint;
  bridge: string;
  quotedAt: number;
  raw: unknown;
}

export interface BridgeStatus {
  status: 'NOT_FOUND' | 'PENDING' | 'DONE' | 'FAILED';
  substatus?: string;
  message?: Hex;
  attestation?: Hex;
  receiving?: { txHash?: string; chainId?: number };
  sending?: { txHash?: string; chainId?: number };
}

export interface BridgeProvider {
  getTokens(chainIds: number[]): Promise<BridgeToken[]>;
  getQuote(request: BridgeQuoteRequest): Promise<BridgeQuote>;
  getStatus(quote: BridgeQuote, sourceTxHash: string): Promise<BridgeStatus>;
}

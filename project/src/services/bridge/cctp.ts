import { encodeFunctionData, pad, type Address, type Hex } from 'viem';
import { getOrbitNetwork, isCctpRouteSupported } from '../../data/networks';
import type { BridgeProvider, BridgeQuoteRequest, BridgeStatus, BridgeToken } from '../../types/bridge';

const tokenMessengerAbi = [{
  type: 'function',
  name: 'depositForBurn',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'amount', type: 'uint256' },
    { name: 'destinationDomain', type: 'uint32' },
    { name: 'mintRecipient', type: 'bytes32' },
    { name: 'burnToken', type: 'address' },
    { name: 'destinationCaller', type: 'bytes32' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'minFinalityThreshold', type: 'uint32' },
  ],
  outputs: [],
}] as const;

interface AttestationResponse {
  messages?: Array<{ message?: string; attestation?: string; status?: string }>;
}

async function getAttestation(sourceDomain: number, transactionHash: string): Promise<BridgeStatus> {
  const response = await fetch(`https://iris-api-sandbox.circle.com/v2/messages/${sourceDomain}?transactionHash=${transactionHash}`);
  if (!response.ok) {
    if (response.status === 404 || response.status === 400) {
      return { status: 'PENDING', substatus: 'Message not found for provided parameters' };
    }
    throw new Error(`Circle attestation request failed (${response.status})`);
  }
  const json = await response.json() as AttestationResponse;
  const message = json.messages?.[0];
  if (!message) return { status: 'PENDING', substatus: 'Message not found for provided parameters' };
  if (message.attestation === 'PENDING' || !message.attestation) return { status: 'PENDING', substatus: message.status ?? 'PENDING' };
  return {
    status: 'DONE',
    substatus: 'Attested',
    message: message.message as Hex,
    attestation: message.attestation as Hex,
    sending: { txHash: transactionHash },
  };
}

function toBytes32(address: Address): Hex {
  return pad(address, { size: 32 });
}

function assertCanonicalUsdc(request: BridgeQuoteRequest) {
  const source = getOrbitNetwork(request.fromChain.id);
  const destination = getOrbitNetwork(request.toChain.id);
  if (!source || !destination || !isCctpRouteSupported(source.id, destination.id)) throw new Error('CCTP route is not officially supported');
  if (request.fromToken.symbol !== 'USDC' || request.toToken.symbol !== 'USDC') throw new Error('CCTP supports USDC only');
  if (request.fromToken.address.toLowerCase() !== source.usdc.toLowerCase() || request.toToken.address.toLowerCase() !== destination.usdc.toLowerCase()) {
    throw new Error('Only canonical USDC is supported for CCTP');
  }
  if (request.fromChain.id === request.toChain.id) throw new Error('Source and destination networks must differ');
}

export function createCctpProvider(): BridgeProvider {
  return {
    async getTokens(chainIds) {
      // Return USDC token data for all supported chains (including Arc source)
      return chainIds
        .map((chainId) => getOrbitNetwork(chainId))
        .filter((network): network is Exclude<typeof network, undefined> => network !== undefined)
        .map((network): BridgeToken => ({
          chainId: network.id,
          address: network.usdc,
          symbol: 'USDC',
          name: `${network.name} USDC`,
          decimals: 6,
          logoURI: network.logo,
          isNative: false,
        }));
    },
    async getQuote(request) {
      assertCanonicalUsdc(request);
      if (request.fromAmount <= 0n) throw new Error('Bridge amount must be greater than zero');
      const source = getOrbitNetwork(request.fromChain.id);
      const destination = getOrbitNetwork(request.toChain.id);
      if (!source || !destination) throw new Error('CCTP route metadata is unavailable');
      const transactionData = encodeFunctionData({
        abi: tokenMessengerAbi,
        functionName: 'depositForBurn',
        args: [request.fromAmount, destination.cctpDomain, toBytes32(request.toAddress), source.usdc, '0x0000000000000000000000000000000000000000000000000000000000000000', 0n, 2000],
      });
      return {
        id: `cctp-v2-${source.id}-${destination.id}-${request.fromAmount.toString()}`,
        provider: 'Circle CCTP V2',
        fromChain: request.fromChain,
        toChain: request.toChain,
        fromToken: request.fromToken,
        toToken: request.toToken,
        fromAmount: request.fromAmount,
        toAmount: request.fromAmount,
        toAmountMin: request.fromAmount,
        feeAmount: 0n,
        gasAmount: null,
        gasCosts: [],
        executionDurationSeconds: null,
        transactionTarget: source.tokenMessengerV2,
        transactionData,
        transactionValue: 0n,
        bridge: 'CCTP V2',
        quotedAt: Date.now(),
        raw: { sourceDomain: source.cctpDomain, destinationDomain: destination.cctpDomain, destinationCaller: '0x0000000000000000000000000000000000000000000000000000000000000000', maxFee: 0n, minFinalityThreshold: 2000 },
      };
    },
    async getStatus(quote, sourceTxHash) {
      const source = getOrbitNetwork(quote.fromChain.id);
      if (!source) return { status: 'FAILED', substatus: 'Source network metadata unavailable' };
      return getAttestation(source.cctpDomain, sourceTxHash);
    },
  };
}

export const cctpTokenMessengerAbi = tokenMessengerAbi;
export const cctpMessageTransmitterAbi = [{
  type: 'function',
  name: 'receiveMessage',
  stateMutability: 'nonpayable',
  inputs: [{ name: 'message', type: 'bytes' }, { name: 'attestation', type: 'bytes' }],
  outputs: [{ name: 'success', type: 'bool' }],
}] as const;

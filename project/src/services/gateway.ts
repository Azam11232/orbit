import { maxUint256, pad, parseUnits, type Address, type Hex } from 'viem';
import { getOrbitNetwork, ORBIT_NETWORKS } from '../data/networks';

export const GATEWAY_API_BASE = 'https://gateway-api-testnet.circle.com';
export const GATEWAY_DECIMALS = 6;

export const gatewayWalletAbi = [{
  type: 'function',
  name: 'deposit',
  stateMutability: 'nonpayable',
  inputs: [{ name: 'token', type: 'address' }, { name: 'value', type: 'uint256' }],
  outputs: [],
}] as const;

export const gatewayMinterAbi = [{
  type: 'function',
  name: 'gatewayMint',
  stateMutability: 'nonpayable',
  inputs: [{ name: 'attestationPayload', type: 'bytes' }, { name: 'signature', type: 'bytes' }],
  outputs: [],
}] as const;

export const gatewayEip712Types = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
  ],
  TransferSpec: [
    { name: 'version', type: 'uint32' },
    { name: 'sourceDomain', type: 'uint32' },
    { name: 'destinationDomain', type: 'uint32' },
    { name: 'sourceContract', type: 'bytes32' },
    { name: 'destinationContract', type: 'bytes32' },
    { name: 'sourceToken', type: 'bytes32' },
    { name: 'destinationToken', type: 'bytes32' },
    { name: 'sourceDepositor', type: 'bytes32' },
    { name: 'destinationRecipient', type: 'bytes32' },
    { name: 'sourceSigner', type: 'bytes32' },
    { name: 'destinationCaller', type: 'bytes32' },
    { name: 'value', type: 'uint256' },
    { name: 'salt', type: 'bytes32' },
    { name: 'hookData', type: 'bytes' },
  ],
  BurnIntent: [
    { name: 'maxBlockHeight', type: 'uint256' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'spec', type: 'TransferSpec' },
  ],
} as const;

export interface GatewayBalance {
  domain: number;
  raw: bigint;
  formatted: string;
  pendingBatchRaw: bigint;
  pendingBatchFormatted: string;
}

interface GatewayBalanceEntry {
  domain?: unknown;
  depositor?: unknown;
  balance?: unknown;
  pendingBatch?: unknown;
}

interface GatewayBalanceResponse {
  token?: unknown;
  balances?: unknown;
}

interface GatewayEstimateBurnIntent {
  maxFee?: unknown;
  maxBlockHeight?: unknown;
}

interface GatewayTransferResponse {
  attestation?: string;
  signature?: string;
}

export const gatewayNetworks = ORBIT_NETWORKS.filter((network) => network.capabilities.gateway);

export function parseGatewayAmount(value: string): bigint {
  return parseUnits(value || '0', GATEWAY_DECIMALS);
}

export function gatewayNetworkForDomain(domain: number) {
  return gatewayNetworks.find((network) => network.cctpDomain === domain);
}

export function isGatewayTransferRouteValid(sourceId: number, destinationId: number) {
  return sourceId !== destinationId &&
    gatewayNetworks.some((network) => network.id === sourceId) &&
    gatewayNetworks.some((network) => network.id === destinationId);
}

export async function fetchGatewayBalances(address: Address, signal?: AbortSignal): Promise<GatewayBalance[]> {
  const response = await fetch(`${GATEWAY_API_BASE}/v1/balances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      token: 'USDC',
      sources: gatewayNetworks.map((network) => ({ domain: network.cctpDomain, depositor: address })),
    }),
    signal,
  });
  if (!response.ok) throw new Error(`Gateway balance request failed (${response.status})`);
  const json: unknown = await response.json();
  if (!json || typeof json !== 'object' || !('balances' in json) || !Array.isArray((json as GatewayBalanceResponse).balances)) {
    throw new Error('Gateway balance response did not include a balances array');
  }
  const responseBody = json as GatewayBalanceResponse;
  if (responseBody.token !== 'USDC') throw new Error('Gateway balance response did not confirm the USDC token');
  const seenDomains = new Set<number>();
  const parsedBalances = (responseBody.balances as GatewayBalanceEntry[]).map((balance) => {
    if (
      !balance ||
      typeof balance.domain !== 'number' ||
      !gatewayNetworkForDomain(balance.domain) ||
      typeof balance.depositor !== 'string' ||
      balance.depositor.toLowerCase() !== address.toLowerCase() ||
      typeof balance.balance !== 'string' ||
      typeof balance.pendingBatch !== 'string' ||
      seenDomains.has(balance.domain)
    ) {
      throw new Error('Gateway balance response contains an invalid balance entry');
    }
    seenDomains.add(balance.domain);
    try {
      return {
        domain: balance.domain,
        raw: parseGatewayAmount(balance.balance),
        formatted: balance.balance,
        pendingBatchRaw: parseGatewayAmount(balance.pendingBatch),
        pendingBatchFormatted: balance.pendingBatch,
      };
    } catch {
      throw new Error('Gateway balance response contains an invalid balance amount');
    }
  });
  if (seenDomains.size !== gatewayNetworks.length) {
    throw new Error('Gateway balance response is missing one or more requested source networks');
  }
  return parsedBalances;
}

function addressToBytes32(address: Address): Hex {
  return pad(address, { size: 32 });
}

function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}` as Hex;
}

export function createGatewayTransferSpec(sourceId: number, destinationId: number, depositor: Address, amount: bigint) {
  const source = getOrbitNetwork(sourceId);
  const destination = getOrbitNetwork(destinationId);
  if (sourceId === destinationId) throw new Error('Gateway source and destination must differ');
  if (!source?.capabilities.gateway || !destination?.capabilities.gateway) throw new Error('Gateway does not support this network route');
  return {
    version: 1,
    sourceDomain: source.cctpDomain,
    destinationDomain: destination.cctpDomain,
    sourceContract: addressToBytes32(source.gatewayWallet),
    destinationContract: addressToBytes32(destination.gatewayMinter),
    sourceToken: addressToBytes32(source.usdc),
    destinationToken: addressToBytes32(destination.usdc),
    sourceDepositor: addressToBytes32(depositor),
    destinationRecipient: addressToBytes32(depositor),
    sourceSigner: addressToBytes32(depositor),
    destinationCaller: addressToBytes32('0x0000000000000000000000000000000000000000'),
    value: amount,
    salt: randomSalt(),
    hookData: '0x' as Hex,
  };
}

export async function estimateGatewayTransfer(spec: ReturnType<typeof createGatewayTransferSpec>) {
  const response = await fetch(`${GATEWAY_API_BASE}/v1/estimate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify([{ spec, }], (_, value) => typeof value === 'bigint' ? value.toString() : value),
  });
  if (!response.ok) throw new Error(`Gateway estimate failed (${response.status})`);
  const json: unknown = await response.json();
  const estimate = parseGatewayEstimateResponse(json);
  return { ...estimate, fee: null, feeToken: 'USDC' };
}

export function parseGatewayEstimateResponse(response: unknown) {
  const first = Array.isArray(response) && typeof response[0] === 'object' && response[0] !== null
    ? response[0] as { burnIntent?: GatewayEstimateBurnIntent }
    : undefined;
  const burnIntent = first?.burnIntent;
  const maxFee = burnIntent?.maxFee;
  const maxBlockHeight = burnIntent?.maxBlockHeight;
  if (
    typeof maxFee !== 'string' ||
    !/^\d+$/.test(maxFee) ||
    typeof maxBlockHeight !== 'string' ||
    !/^[1-9]\d*$/.test(maxBlockHeight)
  ) {
    throw new Error('Circle Gateway estimate response is missing valid burnIntent.maxFee or burnIntent.maxBlockHeight. No transfer was submitted; retry later or contact Circle Gateway support.');
  }
  return { maxFee: BigInt(maxFee), maxBlockHeight: BigInt(maxBlockHeight) };
}

export function createGatewayTypedData(spec: ReturnType<typeof createGatewayTransferSpec>, maxFee: bigint, maxBlockHeight: bigint) {
  return {
    types: gatewayEip712Types,
    primaryType: 'BurnIntent' as const,
    domain: { name: 'GatewayWallet', version: '1' },
    message: { maxBlockHeight, maxFee, spec },
  };
}

export async function submitGatewayTransfer(spec: ReturnType<typeof createGatewayTransferSpec>, maxFee: bigint, maxBlockHeight: bigint, signature: Hex) {
  const typedData = createGatewayTypedData(spec, maxFee, maxBlockHeight);
  const response = await fetch(`${GATEWAY_API_BASE}/v1/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify([{ burnIntent: typedData.message, signature }], (_, value) => typeof value === 'bigint' ? value.toString() : value),
  });
  if (!response.ok) throw new Error(`Gateway transfer request failed (${response.status})`);
  const json = await response.json() as GatewayTransferResponse;
  if (!json.attestation || !json.signature) throw new Error('Gateway did not return an attestation');
  return { attestation: json.attestation as Hex, operatorSignature: json.signature as Hex };
}

export function sumGatewayBalances(balances: GatewayBalance[]): bigint {
  return balances.reduce((total, balance) => total + balance.raw, 0n);
}

export function sumGatewayPendingBatches(balances: GatewayBalance[]): bigint {
  return balances.reduce((total, balance) => total + balance.pendingBatchRaw, 0n);
}

export { maxUint256 };

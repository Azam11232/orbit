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
}

interface GatewayBalanceResponse {
  balances?: Array<{ domain?: number; balance?: string }>;
}

interface GatewayEstimateResponse {
  body?: Array<{ burnIntent?: { maxFee?: string; maxBlockHeight?: string } }>;
  fees?: { forwardingFee?: string; token?: string };
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

export async function fetchGatewayBalances(address: Address): Promise<GatewayBalance[]> {
  const response = await fetch(`${GATEWAY_API_BASE}/v1/balances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      token: 'USDC',
      sources: gatewayNetworks.map((network) => ({ domain: network.cctpDomain, depositor: address })),
    }),
  });
  if (!response.ok) throw new Error(`Gateway balance request failed (${response.status})`);
  const json = await response.json() as GatewayBalanceResponse;
  if (!Array.isArray(json.balances)) {
    throw new Error('Gateway balance response did not include a balances array');
  }
  return json.balances.map((balance) => {
    if (!balance || typeof balance.domain !== 'number' || typeof balance.balance !== 'string') {
      throw new Error('Gateway balance response contains an invalid balance entry');
    }
    try {
      return { domain: balance.domain, raw: parseGatewayAmount(balance.balance), formatted: balance.balance };
    } catch {
      throw new Error('Gateway balance response contains an invalid balance amount');
    }
  });
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
  if (!source?.capabilities.gateway || !destination?.capabilities.gateway) throw new Error('Gateway does not support this network route');
  if (sourceId === destinationId) throw new Error('Gateway source and destination must differ');
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
  const json = await response.json() as GatewayEstimateResponse;
  const estimate = json.body?.[0]?.burnIntent;
  if (!estimate?.maxFee || !estimate.maxBlockHeight) throw new Error('Gateway did not return transfer limits');
  return { maxFee: BigInt(estimate.maxFee), maxBlockHeight: BigInt(estimate.maxBlockHeight), fee: json.fees?.forwardingFee ?? null, feeToken: json.fees?.token ?? 'USDC' };
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

export { maxUint256 };

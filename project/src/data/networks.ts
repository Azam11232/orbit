import type { Address } from 'viem';
import { defineChain } from 'viem';
import arcLogo from '../assets/networks/arc.svg';
import ethereumLogo from '../assets/networks/ethereum.svg';
import baseLogo from '../assets/networks/base.svg';
import arbitrumLogo from '../assets/networks/arbitrum.svg';
import optimismLogo from '../assets/networks/optimism.svg';
import polygonLogo from '../assets/networks/polygon.svg';
import avalancheLogo from '../assets/networks/avalanche.svg';

export interface OrbitNetwork {
  id: number;
  name: string;
  shortName: string;
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  cctpDomain: number;
  usdc: Address;
  tokenMessengerV2: Address;
  messageTransmitterV2: Address;
  logo: string;
  capabilities: { wallet: boolean; cctpSource: boolean; cctpDestination: boolean; gateway: boolean; swap: boolean };
  gatewayChainName: string;
  gatewayWallet: Address;
  gatewayMinter: Address;
  supported: boolean;
  supportNote?: string;
  arcCircleSupported: boolean;
  walletPrimary?: boolean;
}

const TOKEN_MESSENGER_V2 = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as Address;
const MESSAGE_TRANSMITTER_V2 = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275' as Address;
const GATEWAY_WALLET_V1 = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9' as Address;
const GATEWAY_MINTER_V1 = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B' as Address;

export const ARC_TESTNET = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } },
  blockExplorers: { default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' } },
  testnet: true,
});

export const ETHEREUM_SEPOLIA = defineChain({
  id: 11155111,
  name: 'Ethereum Sepolia',
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://rpc.sepolia.org'] } },
  blockExplorers: { default: { name: 'Etherscan', url: 'https://sepolia.etherscan.io' } },
  testnet: true,
});

export const BASE_SEPOLIA = defineChain({
  id: 84532,
  name: 'Base Sepolia',
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://sepolia.base.org'] } },
  blockExplorers: { default: { name: 'Basescan', url: 'https://sepolia.basescan.org' } },
  testnet: true,
});

export const ARBITRUM_SEPOLIA = defineChain({
  id: 421614,
  name: 'Arbitrum Sepolia',
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://sepolia-rollup.arbitrum.io/rpc'] } },
  blockExplorers: { default: { name: 'Arbiscan', url: 'https://sepolia.arbiscan.io' } },
  testnet: true,
});

export const OP_SEPOLIA = defineChain({
  id: 11155420,
  name: 'OP Sepolia',
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://sepolia.optimism.io'] } },
  blockExplorers: { default: { name: 'Optimism Explorer', url: 'https://sepolia-optimism.etherscan.io' } },
  testnet: true,
});

export const AVALANCHE_FUJI = defineChain({
  id: 43113,
  name: 'Avalanche Fuji',
  nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
  rpcUrls: { default: { http: ['https://api.avax-test.network/ext/bc/C/rpc'] } },
  blockExplorers: { default: { name: 'Snowtrace', url: 'https://testnet.snowtrace.io' } },
  testnet: true,
});

export const POLYGON_AMOY = defineChain({
  id: 80002,
  name: 'Polygon Amoy',
  nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc-amoy.polygon.technology'] } },
  blockExplorers: { default: { name: 'PolygonScan', url: 'https://amoy.polygonscan.com' } },
  testnet: true,
});

function explorerTx(explorerUrl: string, hash: string) { return `${explorerUrl}/tx/${hash}`; }
function explorerAddress(explorerUrl: string, address: string) { return `${explorerUrl}/address/${address}`; }

export const ORBIT_NETWORKS: readonly OrbitNetwork[] = [
  {
    id: ARC_TESTNET.id,
    name: ARC_TESTNET.name,
    shortName: 'Arc',
    rpcUrl: ARC_TESTNET.rpcUrls.default.http[0],
    explorerUrl: ARC_TESTNET.blockExplorers.default.url,
    nativeCurrency: ARC_TESTNET.nativeCurrency,
    cctpDomain: 26,
    usdc: '0x3600000000000000000000000000000000000000',
    tokenMessengerV2: TOKEN_MESSENGER_V2,
    messageTransmitterV2: MESSAGE_TRANSMITTER_V2,
    logo: arcLogo,
    capabilities: { wallet: true, cctpSource: true, cctpDestination: true, gateway: true, swap: true },
    gatewayChainName: 'arcTestnet',
    gatewayWallet: GATEWAY_WALLET_V1,
    gatewayMinter: GATEWAY_MINTER_V1,
    supported: true,
    arcCircleSupported: true,
    walletPrimary: true,
  },
  {
    id: ETHEREUM_SEPOLIA.id,
    name: ETHEREUM_SEPOLIA.name,
    shortName: 'Ethereum',
    rpcUrl: ETHEREUM_SEPOLIA.rpcUrls.default.http[0],
    explorerUrl: ETHEREUM_SEPOLIA.blockExplorers.default.url,
    nativeCurrency: ETHEREUM_SEPOLIA.nativeCurrency,
    cctpDomain: 0,
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    tokenMessengerV2: TOKEN_MESSENGER_V2,
    messageTransmitterV2: MESSAGE_TRANSMITTER_V2,
    logo: ethereumLogo,
    supported: true,
    capabilities: { wallet: true, cctpSource: true, cctpDestination: true, gateway: true, swap: false },
    gatewayChainName: 'sepolia',
    gatewayWallet: GATEWAY_WALLET_V1,
    gatewayMinter: GATEWAY_MINTER_V1,
    arcCircleSupported: true,
  },
  {
    id: BASE_SEPOLIA.id,
    name: BASE_SEPOLIA.name,
    shortName: 'Base',
    rpcUrl: BASE_SEPOLIA.rpcUrls.default.http[0],
    explorerUrl: BASE_SEPOLIA.blockExplorers.default.url,
    nativeCurrency: BASE_SEPOLIA.nativeCurrency,
    cctpDomain: 6,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    tokenMessengerV2: TOKEN_MESSENGER_V2,
    messageTransmitterV2: MESSAGE_TRANSMITTER_V2,
    logo: baseLogo,
    supported: true,
    capabilities: { wallet: true, cctpSource: true, cctpDestination: true, gateway: true, swap: false },
    gatewayChainName: 'baseSepolia',
    gatewayWallet: GATEWAY_WALLET_V1,
    gatewayMinter: GATEWAY_MINTER_V1,
    arcCircleSupported: true,
  },
  {
    id: ARBITRUM_SEPOLIA.id,
    name: ARBITRUM_SEPOLIA.name,
    shortName: 'Arbitrum',
    rpcUrl: ARBITRUM_SEPOLIA.rpcUrls.default.http[0],
    explorerUrl: ARBITRUM_SEPOLIA.blockExplorers.default.url,
    nativeCurrency: ARBITRUM_SEPOLIA.nativeCurrency,
    cctpDomain: 3,
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    tokenMessengerV2: TOKEN_MESSENGER_V2,
    messageTransmitterV2: MESSAGE_TRANSMITTER_V2,
    logo: arbitrumLogo,
    capabilities: { wallet: true, cctpSource: true, cctpDestination: true, gateway: true, swap: false },
    gatewayChainName: 'arbitrumSepolia',
    gatewayWallet: GATEWAY_WALLET_V1,
    gatewayMinter: GATEWAY_MINTER_V1,
    supported: true,
    arcCircleSupported: true,
  },
  {
    id: OP_SEPOLIA.id,
    name: OP_SEPOLIA.name,
    shortName: 'Optimism',
    rpcUrl: OP_SEPOLIA.rpcUrls.default.http[0],
    explorerUrl: OP_SEPOLIA.blockExplorers.default.url,
    nativeCurrency: OP_SEPOLIA.nativeCurrency,
    cctpDomain: 2,
    usdc: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
    tokenMessengerV2: TOKEN_MESSENGER_V2,
    messageTransmitterV2: MESSAGE_TRANSMITTER_V2,
    logo: optimismLogo,
    capabilities: { wallet: true, cctpSource: true, cctpDestination: true, gateway: true, swap: false },
    gatewayChainName: 'optimismSepolia',
    gatewayWallet: GATEWAY_WALLET_V1,
    gatewayMinter: GATEWAY_MINTER_V1,
    supported: true,
    arcCircleSupported: true,
  },
  {
    id: AVALANCHE_FUJI.id,
    name: AVALANCHE_FUJI.name,
    shortName: 'Avalanche',
    rpcUrl: AVALANCHE_FUJI.rpcUrls.default.http[0],
    explorerUrl: AVALANCHE_FUJI.blockExplorers.default.url,
    nativeCurrency: AVALANCHE_FUJI.nativeCurrency,
    cctpDomain: 1,
    usdc: '0x5425890298aed601595a70AB815c96711a31Bc65',
    tokenMessengerV2: TOKEN_MESSENGER_V2,
    messageTransmitterV2: MESSAGE_TRANSMITTER_V2,
    logo: avalancheLogo,
    capabilities: { wallet: true, cctpSource: true, cctpDestination: true, gateway: true, swap: false },
    gatewayChainName: 'avalancheFuji',
    gatewayWallet: GATEWAY_WALLET_V1,
    gatewayMinter: GATEWAY_MINTER_V1,
    supported: true,
    arcCircleSupported: true,
  },
  {
    id: POLYGON_AMOY.id,
    name: POLYGON_AMOY.name,
    shortName: 'Polygon',
    rpcUrl: POLYGON_AMOY.rpcUrls.default.http[0],
    explorerUrl: POLYGON_AMOY.blockExplorers.default.url,
    nativeCurrency: POLYGON_AMOY.nativeCurrency,
    cctpDomain: 7,
    usdc: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
    tokenMessengerV2: TOKEN_MESSENGER_V2,
    messageTransmitterV2: MESSAGE_TRANSMITTER_V2,
    logo: polygonLogo,
    capabilities: { wallet: true, cctpSource: true, cctpDestination: true, gateway: true, swap: false },
    gatewayChainName: 'polygonAmoy',
    gatewayWallet: GATEWAY_WALLET_V1,
    gatewayMinter: GATEWAY_MINTER_V1,
    supported: true,
    arcCircleSupported: true,
  },
];

export const explorerTransactionUrl = (chainId: number, hash: string) => {
  const network = getOrbitNetwork(chainId);
  return network ? explorerTx(network.explorerUrl, hash) : undefined;
};

export const explorerAddressUrl = (chainId: number, address: string) => {
  const network = getOrbitNetwork(chainId);
  return network ? explorerAddress(network.explorerUrl, address) : undefined;
};

export const ARC_PRIMARY_NETWORK = ORBIT_NETWORKS[0];
export const getOrbitNetwork = (chainId: number | undefined) => ORBIT_NETWORKS.find((network) => network.id === chainId);
export const CCTP_BRIDGE_NETWORKS: readonly OrbitNetwork[] = ORBIT_NETWORKS.filter((network) => network.supported);
export const isCctpRouteSupported = (fromChainId: number, toChainId: number) => {
  const source = getOrbitNetwork(fromChainId);
  const destination = getOrbitNetwork(toChainId);
  return Boolean(source?.supported && destination?.supported && fromChainId !== toChainId);
};

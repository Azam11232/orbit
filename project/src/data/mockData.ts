export const chains = [
  { name: 'Ethereum', symbol: 'ETH', color: '#627EEA', value: '$15,902', percent: 64 },
  { name: 'Base', symbol: 'BASE', color: '#4B8BFF', value: '$4,721', percent: 19 },
  { name: 'Arbitrum', symbol: 'ARB', color: '#28A0F0', value: '$2,956', percent: 12 },
  { name: 'Optimism', symbol: 'OP', color: '#FF4A4A', value: '$1,268', percent: 5 },
];

export const assets = [
  { symbol: 'ETH', name: 'Ethereum', amount: '6.842', value: '$15,902.28', change: '+5.42%', color: '#627EEA' },
  { symbol: 'USDC', name: 'USD Coin', amount: '5,420.00', value: '$5,420.00', change: '+0.01%', color: '#2775CA' },
  { symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', amount: '0.038', value: '$2,956.44', change: '+3.18%', color: '#F7931A' },
  { symbol: 'DEGEN', name: 'Degen', amount: '48,200', value: '$568.60', change: '-2.41%', color: '#A855F7' },
];

export const activities = [
  { type: 'Swap', detail: 'ETH → USDC', amount: '+2,400 USDC', time: '12 min ago', positive: true },
  { type: 'Bridge', detail: 'Base → Ethereum', amount: '1.2 ETH', time: '2 hours ago', positive: false },
  { type: 'Receive', detail: 'From 0x8a...42f1', amount: '+0.84 ETH', time: 'Yesterday', positive: true },
  { type: 'Swap', detail: 'USDC → DEGEN', amount: '48,200 DEGEN', time: 'Yesterday', positive: false },
];

export const opportunities = [
  { name: 'Aerodrome', type: 'Yield opportunity', apy: '18.42%', risk: 'Moderate', network: 'Base', color: '#2D5BFF' },
  { name: 'Morpho Blue', type: 'Lending market', apy: '9.84%', risk: 'Low', network: 'Ethereum', color: '#4B8BFF' },
  { name: 'Pendle', type: 'Fixed yield', apy: '12.18%', risk: 'Moderate', network: 'Arbitrum', color: '#31D5A7' },
  { name: 'Moonwell', type: 'Lending market', apy: '7.62%', risk: 'Low', network: 'Base', color: '#8B5CF6' },
];

export const chartData = [28, 34, 31, 42, 39, 54, 48, 58, 52, 67, 64, 78, 72, 86, 82, 94, 89, 105, 101, 118, 110, 126, 120, 138];

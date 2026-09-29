# ORBIT

**Web3 Onchain Command Center**

ORBIT is a browser-based wallet dashboard for viewing portfolio and transaction activity, reviewing approval and security signals, and using USDC features across configured EVM testnets.

## Project Status

ORBIT is a testnet-focused project. The configured wallet networks are testnets only; do not use it with production funds.

## Features

- Wallet portfolio, balances, transaction activity, and watchlist
- Wallet security overview and token approval review and revocation
- USDC cross-network transfers using Circle CCTP V2 and Gateway routes
- Arc Testnet USDC payment requests with shareable links and QR codes
- Arc Testnet USDC/EURC swaps

Feature and route availability varies by network. Swap and Arc Pay flows are configured for Arc Testnet.

## Supported Networks

The wallet configuration includes Arc Testnet, Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia, OP Sepolia, Avalanche Fuji, and Polygon Amoy. Network support does not mean every feature is available on every network.

## Technology

Vite, React, TypeScript, Tailwind CSS, wagmi, viem, TanStack Query, and Circle tooling.

## Local Development

The app and its npm scripts are in `project/`:

```sh
cd project
npm ci
npm run dev
```

No app-specific environment variables are referenced by the current source or configuration.

## Checks

Run from `project/`:

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

## Deployment

The repository homepage points to the [ORBIT Vercel deployment](https://orbit-azam-1723.vercel.app). The app includes a Vercel-style ArcScan API function and a Vite proxy for local development and preview.

## Testnet Notice

This software interacts with test networks and third-party services. Testnet assets have no intended monetary value, and network or service availability may change. Review each wallet transaction before signing.
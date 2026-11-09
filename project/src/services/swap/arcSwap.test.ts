import { describe, expect, it } from 'vitest';
import { Blockchain, type SwapEstimate } from '@circle-fin/swap-kit';
import { parseUnits, type Address } from 'viem';
import { ARC_EURC, ARC_USDC } from '../../data/tokens';
import type { ArcSwapSymbol } from '../../types/swap';
import { verifyArcSwapEstimate, type ArcSwapQuoteValidationRequest } from './arcSwap';

const wallet = '0x1111111111111111111111111111111111111111' as Address;

function createEstimate(
  tokenIn: ArcSwapSymbol,
  tokenOut: ArcSwapSymbol,
  outputAmount: string,
  minimumAmount: string,
): { quote: SwapEstimate; request: ArcSwapQuoteValidationRequest } {
  const inputAsset = tokenIn === 'USDC' ? ARC_USDC : ARC_EURC;
  const outputAsset = tokenOut === 'USDC' ? ARC_USDC : ARC_EURC;
  const request = {
    walletAddress: wallet,
    tokenIn,
    tokenOut,
    amountIn: '1',
    slippageBps: 50,
  } satisfies ArcSwapQuoteValidationRequest;
  const quote = {
    tokenIn,
    tokenOut,
    amountIn: request.amountIn,
    chainIn: Blockchain.Arc_Testnet,
    chainOut: Blockchain.Arc_Testnet,
    chain: Blockchain.Arc_Testnet,
    fromAddress: wallet,
    toAddress: wallet,
    estimatedOutput: { amount: outputAmount, token: tokenOut },
    stopLimit: { amount: minimumAmount, token: tokenOut },
    fees: [{ type: 'provider', amount: '0.0002', token: tokenIn }],
    route: {
      provider: 'lifi',
      steps: [{
        type: 'swap',
        tool: 'fly',
        toolName: 'Fly',
        fromToken: { address: inputAsset.address, symbol: tokenIn, decimals: inputAsset.decimals },
        toToken: { address: outputAsset.address, symbol: tokenOut, decimals: outputAsset.decimals },
        estimate: { fromAmount: '999800', toAmount: parseUnits(outputAmount, outputAsset.decimals).toString() },
      }],
    },
  } satisfies SwapEstimate;
  return { quote, request };
}

describe('Circle Swap Kit Arc Testnet quotes', () => {
  it.each([
    ['USDC', 'EURC', '1.915674', '1.906096'],
    ['EURC', 'USDC', '1.214244', '1.208173'],
  ] as const)('accepts a matching executable %s → %s quote', (tokenIn, tokenOut, output, minimum) => {
    const { quote, request } = createEstimate(tokenIn, tokenOut, output, minimum);

    expect(() => verifyArcSwapEstimate(quote, request)).not.toThrow();
  });

  it('allows normal route-versus-display rounding within the selected slippage', () => {
    const { quote, request } = createEstimate('USDC', 'EURC', '1.915674', '1.906096');
    const route = quote.route!;
    const quoteWithRoundedRoute = {
      ...quote,
      route: {
        ...route,
        steps: [{
          ...route.steps[0]!,
          estimate: { fromAmount: '999800', toAmount: '1915500' },
        }],
      },
    } satisfies SwapEstimate;

    expect(() => verifyArcSwapEstimate(quoteWithRoundedRoute, request)).not.toThrow();
  });

  it('rejects a reviewed minimum below the exact configured slippage floor', () => {
    const { quote, request } = createEstimate('USDC', 'EURC', '1.915674', '1.906095');

    expect(() => verifyArcSwapEstimate(quote, request))
      .toThrow('does not match the requested Arc Testnet tokens');
  });

  it('rejects quotes for a different wallet, amount, chain, or output minimum', () => {
    const { quote, request } = createEstimate('EURC', 'USDC', '1.214244', '1.208173');

    expect(() => verifyArcSwapEstimate({ ...quote, toAddress: '0x2222222222222222222222222222222222222222' }, request))
      .toThrow('does not match the requested Arc Testnet tokens');
    expect(() => verifyArcSwapEstimate({ ...quote, amountIn: '2' }, request))
      .toThrow('does not match the requested Arc Testnet tokens');
    expect(() => verifyArcSwapEstimate({ ...quote, chainOut: Blockchain.Ethereum }, request))
      .toThrow('does not match the requested Arc Testnet tokens');
    expect(() => verifyArcSwapEstimate({
      ...quote,
      stopLimit: { amount: '1.3', token: 'USDC' },
    }, request)).toThrow('does not match the requested Arc Testnet tokens');
  });
});

import { describe, expect, it } from 'vitest';
import { Blockchain, type SwapEstimate } from '@circle-fin/swap-kit';
import { formatUnits, parseUnits } from 'viem';
import { ARC_EURC, ARC_USDC } from '../../data/tokens';
import type { ArcSwapSymbol } from '../../types/swap';
import {
  isArcSwapExecutionPayload,
  isArcSwapPoolPriceWithinTolerance,
  isArcSwapRouteQuote,
  isArcSwapRouteUnavailableError,
  verifyArcSwapEstimate,
  verifyArcSwapExecutionPayload,
  type ArcSwapExecutionPayload,
  type ArcSwapPoolEvidence,
  type ArcSwapQuoteVerificationRequest,
  type ArcSwapRouteQuote,
} from './quoteVerification';

const now = 1_800_000_000_000;
const rates = {
  [ARC_USDC.address.toLowerCase()]: {
    priceUSD: '0.9999666056',
    fetchedAt: now,
    decimals: 6,
  },
  [ARC_EURC.address.toLowerCase()]: {
    priceUSD: '1.1208079749',
    fetchedAt: now,
    decimals: 6,
  },
};

function createQuote(
  tokenIn: ArcSwapSymbol,
  tokenOut: ArcSwapSymbol,
  estimatedAmount: string,
  minAmount: string,
): { estimate: SwapEstimate; route: ArcSwapRouteQuote; request: ArcSwapQuoteVerificationRequest } {
  const inputAsset = tokenIn === 'USDC' ? ARC_USDC : ARC_EURC;
  const outputAsset = tokenOut === 'USDC' ? ARC_USDC : ARC_EURC;
  const estimatedOutput = formatUnits(BigInt(estimatedAmount), outputAsset.decimals);
  const stopLimit = formatUnits(BigInt(minAmount), outputAsset.decimals);
  const request = { tokenIn, tokenOut, amountIn: '1', slippageBps: 50 };
  const estimate = {
    tokenIn,
    tokenOut,
    amountIn: request.amountIn,
    chainIn: Blockchain.Arc_Testnet,
    chainOut: Blockchain.Arc_Testnet,
    chain: Blockchain.Arc_Testnet,
    fromAddress: '0x0000000000000000000000000000000000000042',
    toAddress: '0x0000000000000000000000000000000000000042',
    estimatedOutput: { amount: estimatedOutput, token: tokenOut },
    stopLimit: { amount: stopLimit, token: tokenOut },
    fees: [{ type: 'provider', amount: '0.0002', token: tokenIn }],
  } satisfies SwapEstimate;
  const route: ArcSwapRouteQuote = {
    quote: {
      estimatedAmount,
      minAmount,
      route: {
        provider: 'lifi',
        steps: [{
          type: 'swap',
          tool: 'fly',
          toolName: 'Fly',
          fromToken: { address: inputAsset.address, symbol: tokenIn, decimals: inputAsset.decimals },
          toToken: { address: outputAsset.address, symbol: tokenOut, decimals: outputAsset.decimals },
          estimate: { fromAmount: '999800', toAmount: estimatedAmount },
        }],
      },
    },
    fees: [{
      token: inputAsset.address,
      amount: '200',
      decimals: 6,
      symbol: tokenIn,
      chain: 'Arc_Testnet',
    }],
  };
  return { estimate, route, request };
}

describe('Arc Swap quote verification', () => {
  it.each([
    ['USDC', 'EURC'],
    ['EURC', 'USDC'],
  ] as const)('does not trust Circle USD references without independent pricing evidence for %s → %s', (tokenIn, tokenOut) => {
    const { estimate, route, request } = createQuote(tokenIn, tokenOut, '900000', '895500');

    expect(() => verifyArcSwapEstimate(estimate, request, route, {}))
      .toThrow('No independent Arc Testnet USDC/EURC pricing evidence is available');
  });

  it.each([
    ['provider error code', { code: 1003 }],
    ['nested unsupported route', { cause: { name: 'INPUT_UNSUPPORTED_ROUTE' } }],
    ['insufficient-liquidity response', { response: { data: { message: 'Insufficient liquidity for this pair' } } }],
    ['verified pool depth failure', new Error('Insufficient USDC liquidity in the verified Arc Testnet pool.')],
    ['empty route response', 'No route available for the selected token pair'],
  ])('recognizes %s as an unavailable route', (_label, error) => {
    expect(isArcSwapRouteUnavailableError(error)).toBe(true);
  });

  it('does not classify a pricing mismatch as a missing route', () => {
    expect(isArcSwapRouteUnavailableError(new Error('The route output cannot be reconciled with current market values'))).toBe(false);
  });

  it.each([
    ['USDC', 'EURC', '0.02455', '0.019364298975'] as const,
    ['EURC', 'USDC', '0.0261', '0.020316091425'] as const,
  ])('accounts for provider, gas, and slippage allowances for %s → %s', (tokenIn, tokenOut, usdLoss, gasAmount) => {
    const inputAsset = tokenIn === 'USDC' ? ARC_USDC : ARC_EURC;
    const outputAsset = tokenOut === 'USDC' ? ARC_USDC : ARC_EURC;
    const inputRate = parseUnits(rates[inputAsset.address.toLowerCase()]!.priceUSD, 18);
    const outputRate = parseUnits(rates[outputAsset.address.toLowerCase()]!.priceUSD, 18);
    const inputUsdValue = 1_000_000n * inputRate / 10n ** BigInt(inputAsset.decimals);
    const outputUsdValue = inputUsdValue - parseUnits(usdLoss, 18);
    const outputAmount = outputUsdValue * 10n ** BigInt(outputAsset.decimals) / outputRate;
    const minimumAmount = (outputAmount * 9_950n + 9_999n) / 10_000n;
    const { estimate, route, request } = createQuote(
      tokenIn,
      tokenOut,
      outputAmount.toString(),
      minimumAmount.toString(),
    );
    const estimateWithGasFee = {
      ...estimate,
      fees: [
        { type: 'provider', amount: '0.0002', token: tokenIn },
        { type: 'gas', amount: gasAmount, token: 'USDC' },
      ],
    } satisfies SwapEstimate;

    expect(() => verifyArcSwapEstimate(estimateWithGasFee, request, route, rates, now)).not.toThrow();
  });

  it('rejects route and SDK minimums below the exact configured slippage floor', () => {
    const routeMinimumBelowFloor = createQuote('USDC', 'EURC', '1000000', '995000');
    routeMinimumBelowFloor.route.quote.minAmount = '994999';
    expect(() => verifyArcSwapEstimate(
      routeMinimumBelowFloor.estimate,
      routeMinimumBelowFloor.request,
      routeMinimumBelowFloor.route,
      rates,
      now,
    )).toThrow('estimate and selected route disagree');

    const sdkMinimumBelowFloor = createQuote('USDC', 'EURC', '1000000', '994999');
    sdkMinimumBelowFloor.route.quote.minAmount = '995000';
    expect(() => verifyArcSwapEstimate(
      sdkMinimumBelowFloor.estimate,
      sdkMinimumBelowFloor.request,
      sdkMinimumBelowFloor.route,
      rates,
      now,
    )).toThrow('estimate and selected route disagree');
  });

  it.each([
    {
      tokenIn: 'USDC',
      tokenOut: 'EURC',
      sdkOutput: '1885057',
      sdkMinimum: '1875632',
      routeOutput: '1884885',
      routeMinimum: '1875461',
      gasAmount: '0.01936462185',
    },
    {
      tokenIn: 'EURC',
      tokenOut: 'USDC',
      sdkOutput: '1214429',
      sdkMinimum: '1208357',
      routeOutput: '1214429',
      routeMinimum: '1208357',
      gasAmount: '0.0203167587',
    },
  ] as const)('rejects materially mispriced Circle $tokenIn → $tokenOut quotes with reported fees', ({
    tokenIn,
    tokenOut,
    sdkOutput,
    sdkMinimum,
    routeOutput,
    routeMinimum,
    gasAmount,
  }) => {
    const { estimate, route, request } = createQuote(tokenIn, tokenOut, sdkOutput, sdkMinimum);
    route.quote.estimatedAmount = routeOutput;
    route.quote.minAmount = routeMinimum;
    route.quote.route.steps[0]!.estimate.toAmount = routeOutput;
    const estimateWithLiveFees = {
      ...estimate,
      fees: [
        { type: 'provider', amount: '0.0002', token: tokenIn },
        { type: 'gas', amount: gasAmount, token: 'USDC' },
      ],
    } satisfies SwapEstimate;

    expect(() => verifyArcSwapEstimate(estimateWithLiveFees, request, route, rates, now))
      .toThrow(`Arc Testnet ${tokenIn} → ${tokenOut} route is unavailable`);
  });

  it.each([
    ['USDC', 'EURC', '1885057', '1875632', '1884885', '1875461', '0.01936462185'],
    ['EURC', 'USDC', '1214429', '1208357', '1214429', '1208357', '0.0203167587'],
  ] as const)('rejects live-shaped materially mispriced Circle quotes for %s → %s', (
    tokenIn,
    tokenOut,
    sdkOutput,
    sdkMinimum,
    routeOutput,
    routeMinimum,
    gas,
  ) => {
    const { estimate, route, request } = createQuote(tokenIn, tokenOut, sdkOutput, sdkMinimum);
    route.quote.estimatedAmount = routeOutput;
    route.quote.minAmount = routeMinimum;
    route.quote.route.steps[0]!.estimate.toAmount = routeOutput;

    expect(() => verifyArcSwapEstimate({
      ...estimate,
      fees: [
        { type: 'provider', amount: '0.0002', token: tokenIn },
        { type: 'gas', amount: gas, token: 'USDC' },
      ],
    }, request, route, rates, now)).toThrow('route is unavailable');
  });

  it.each([
    ['USDC', 'EURC'],
    ['EURC', 'USDC'],
  ] as const)('rejects stale Arc Testnet USD references for %s → %s', (tokenIn, tokenOut) => {
    const { estimate, route, request } = createQuote(tokenIn, tokenOut, '900000', '895500');
    const staleRates = Object.fromEntries(
      Object.entries(rates).map(([address, rate]) => [address, { ...rate, fetchedAt: now - 15 * 60 * 1000 - 1 }]),
    );

    expect(() => verifyArcSwapEstimate(estimate, request, route, staleRates, now))
      .toThrow('Fresh USD rates for the configured Arc Testnet tokens are unavailable');
  });

  it('rejects a service route whose output token or decimals do not match the selected asset', () => {
    const { estimate, route, request } = createQuote('USDC', 'EURC', '1704495', '1695973');
    route.quote.route.steps[0]!.toToken.address = ARC_USDC.address;

    expect(() => verifyArcSwapEstimate(estimate, request, route, rates, now))
      .toThrow('Circle Swap returned a route that does not match the configured Arc Testnet tokens');
  });

  it.each([
    ['USDC', 'EURC'],
    ['EURC', 'USDC'],
  ] as const)('rejects an unsupported empty route for %s → %s', (tokenIn, tokenOut) => {
    const { estimate, route, request } = createQuote(tokenIn, tokenOut, '900000', '895500');
    route.quote.route.steps = [];

    expect(isArcSwapRouteQuote({ quote: route.quote, fees: route.fees })).toBe(false);
    expect(() => verifyArcSwapEstimate(estimate, request, route, rates, now))
      .toThrow('Circle Swap did not return a verifiable Arc Testnet route');
  });

  it.each([
    ['EURC', 'USDC', '1214421', '1208354'],
    ['USDC', 'EURC', '818175', '814084'],
  ] as const)('accepts a signed %s → %s route aligned with its six-decimal pool quote', (
    tokenIn,
    tokenOut,
    outputAmount,
    minimumAmount,
  ) => {
    const walletAddress = '0xB2856861345d81D23969665856Ae1776E7640DCc';
    const evidence = createPoolEvidence(tokenIn, BigInt(outputAmount));
    const payload = createExecutionPayload(walletAddress, tokenIn, outputAmount, minimumAmount);

    expect(() => verifyArcSwapExecutionPayload(
      createExecutionEstimate(walletAddress, tokenIn, outputAmount, minimumAmount),
      payload,
      { tokenIn, tokenOut, amountIn: '1', slippageBps: 50 },
      evidence,
      walletAddress,
      now,
    )).not.toThrow();
  });

  it.each([
    ['EURC', '1214421', '1208354'],
    ['USDC', '818175', '814084'],
  ] as const)('rejects a %s payload whose executable output differs from the reviewed quote', (
    tokenIn,
    outputAmount,
    minimumAmount,
  ) => {
    const walletAddress = '0xB2856861345d81D23969665856Ae1776E7640DCc';
    const tokenOut = tokenIn === 'EURC' ? 'USDC' : 'EURC';
    const payload = createExecutionPayload(walletAddress, tokenIn, outputAmount, minimumAmount);
    payload.estimatedAmount = (BigInt(outputAmount) + 1n).toString();

    expect(() => verifyArcSwapExecutionPayload(
      createExecutionEstimate(walletAddress, tokenIn, outputAmount, minimumAmount),
      payload,
      { tokenIn, tokenOut, amountIn: '1', slippageBps: 50 },
      createPoolEvidence(tokenIn, BigInt(outputAmount)),
      walletAddress,
      now,
    )).toThrow('does not match the independently verified');
  });

  it('rejects the captured USDC → EURC Circle output against its bracketed live pool snapshot', () => {
    const circleOutput = 2_100_104n;
    const poolOutput = 818_175n;
    const verifiedEurcToUsdcPoolOutput = 1_214_421n;
    const capturedEurcToUsdcCircleOutput = 1_214_426n;

    expect(isArcSwapPoolPriceWithinTolerance(
      capturedEurcToUsdcCircleOutput,
      verifiedEurcToUsdcPoolOutput,
    )).toBe(true);
    expect(isArcSwapPoolPriceWithinTolerance(circleOutput, poolOutput)).toBe(false);
    expect(circleOutput - poolOutput).toBe(1_281_929n);
  });

  it('identifies the EURC → USDC mismatch as pool pricing, not route conversion', () => {
    const circleOutput = 1_214_199n;
    const localPoolOutput = 1_214_421n;

    expect(isArcSwapPoolPriceWithinTolerance(circleOutput, localPoolOutput)).toBe(true);
    expect(circleOutput - localPoolOutput).toBe(-222n);
  });

  it('rejects malformed router addresses in a signed payload', () => {
    const payload = createExecutionPayload('0xB2856861345d81D23969665856Ae1776E7640DCc');

    expect(payload.transaction.executionParams.instructions[1]!.value).toBe('0x0');
    expect(isArcSwapExecutionPayload(payload)).toBe(true);
    expect(BigInt(payload.transaction.executionParams.instructions[1]!.value)).toBe(0n);

    payload.transaction.executionParams.instructions[1]!.target =
      '0xFf70F4A1d11995621854F3692acF286d8aCd04b';
    expect(isArcSwapExecutionPayload(payload)).toBe(false);
  });

  it('rejects signed quotes whose price, token units, recipient, fees, or output floor disagree', () => {
    const walletAddress = '0xB2856861345d81D23969665856Ae1776E7640DCc';
    const verify = (payload: ArcSwapExecutionPayload) => verifyArcSwapExecutionPayload(
      createExecutionEstimate(walletAddress),
      payload,
      { tokenIn: 'EURC', tokenOut: 'USDC', amountIn: '1', slippageBps: 50 },
      createPoolEvidence(),
      walletAddress,
      now,
    );

    const badPrice = createExecutionPayload(walletAddress);
    badPrice.estimatedAmount = '2000000';
    badPrice.route.steps[0]!.estimate.toAmount = '2000000';
    expect(() => verify(badPrice)).toThrow('does not match the independently verified');

    const badUnits = createExecutionPayload(walletAddress);
    badUnits.route.steps[0]!.fromToken.decimals = 18;
    expect(() => verify(badUnits)).toThrow('does not match the independently verified');

    const badRecipient = createExecutionPayload(walletAddress);
    badRecipient.transaction.executionParams.tokens[1]!.beneficiary = '0x0000000000000000000000000000000000000001';
    expect(() => verify(badRecipient)).toThrow('does not match the independently verified');

    const badFee = createExecutionPayload(walletAddress);
    badFee.fees.provider[0]!.amount = '201';
    expect(() => verify(badFee)).toThrow('does not match the independently verified');

    const badFloor = createExecutionPayload(walletAddress);
    badFloor.transaction.executionParams.instructions[1]!.minTokenOut = '1208347';
    expect(() => verify(badFloor)).toThrow('does not match the independently verified');
  });

  it('rejects expired signed payloads and malformed transaction amounts', () => {
    const walletAddress = '0xB2856861345d81D23969665856Ae1776E7640DCc';
    const expired = createExecutionPayload(walletAddress);
    expired.transaction.executionParams.deadline = String(Math.floor(now / 1000));
    expect(() => verifyArcSwapExecutionPayload(
      createExecutionEstimate(walletAddress),
      expired,
      { tokenIn: 'EURC', tokenOut: 'USDC', amountIn: '1', slippageBps: 50 },
      createPoolEvidence(),
      walletAddress,
      now,
    )).toThrow('does not match the independently verified');

    const malformed = createExecutionPayload(walletAddress);
    malformed.transaction.executionParams.instructions[1]!.minTokenOut = '1.2';
    expect(isArcSwapExecutionPayload(malformed)).toBe(false);

    const malformedValue = createExecutionPayload(walletAddress);
    malformedValue.transaction.executionParams.instructions[1]!.value = '0x';
    expect(isArcSwapExecutionPayload(malformedValue)).toBe(false);
  });
});

function createPoolEvidence(
  tokenIn: ArcSwapSymbol = 'EURC',
  expectedOutput = 1_214_421n,
): ArcSwapPoolEvidence {
  const amountIn = 1_000_000n;
  const providerFee = 200n;
  return {
    tokenIn,
    tokenOut: tokenIn === 'EURC' ? 'USDC' : 'EURC',
    amountIn,
    providerFee,
    amountToPool: amountIn - providerFee,
    expectedOutput,
    minimumOutput: expectedOutput * 9_950n / 10_000n,
  };
}

function createExecutionEstimate(
  walletAddress: string,
  tokenIn: ArcSwapSymbol = 'EURC',
  outputAmount = '1214421',
  minimumAmount = '1208354',
): SwapEstimate {
  const tokenOut = tokenIn === 'EURC' ? 'USDC' : 'EURC';
  return {
    tokenIn,
    tokenOut,
    amountIn: '1',
    chainIn: Blockchain.Arc_Testnet,
    chainOut: Blockchain.Arc_Testnet,
    chain: Blockchain.Arc_Testnet,
    fromAddress: walletAddress,
    toAddress: walletAddress,
    estimatedOutput: { amount: formatUnits(BigInt(outputAmount), 6), token: tokenOut },
    stopLimit: { amount: formatUnits(BigInt(minimumAmount), 6), token: tokenOut },
    fees: [
      { type: 'provider', amount: '0.0002', token: tokenIn },
      { type: 'gas', amount: '0.015', token: 'USDC' },
    ],
  };
}

function createExecutionPayload(
  walletAddress: string,
  tokenIn: ArcSwapSymbol = 'EURC',
  estimatedAmount = '1214421',
  minimumAmount = '1208354',
): ArcSwapExecutionPayload {
  const inputAsset = tokenIn === 'EURC' ? ARC_EURC : ARC_USDC;
  const tokenOut: ArcSwapSymbol = tokenIn === 'EURC' ? 'USDC' : 'EURC';
  const outputAsset = tokenOut === 'USDC' ? ARC_USDC : ARC_EURC;
  return {
    amount: '1000000',
    estimatedAmount,
    tokenInAddress: inputAsset.address,
    tokenOutAddress: outputAsset.address,
    fromAddress: walletAddress,
    toAddress: walletAddress,
    route: {
      provider: 'lifi',
      steps: [{
        type: 'swap',
        tool: 'fly',
        toolName: 'Fly',
        fromToken: { address: inputAsset.address, symbol: tokenIn, decimals: 6 },
        toToken: { address: outputAsset.address, symbol: tokenOut, decimals: 6 },
        estimate: { fromAmount: '999800', toAmount: estimatedAmount },
      }],
    },
    fees: {
      provider: [{
        type: 'PARTNER',
        token: inputAsset.address,
        amount: '200',
        decimals: 6,
        chain: 'Arc_Testnet',
        symbol: tokenIn,
      }],
      swap: [],
    },
    transaction: {
      signature: `0x${'1'.repeat(130)}`,
      executionParams: {
        execId: '0x01a1a5efc8c2715d8b4af6034698d88b',
        deadline: '1800000600',
        metadata: '0x',
        tokens: [
          { token: inputAsset.address, beneficiary: walletAddress },
          { token: outputAsset.address, beneficiary: walletAddress },
        ],
        instructions: [
          {
            target: '0xf992EFCB5FA2eD7cB48310D9dd8Cb4ce5FB7DdC9',
            data: '0x7ebc46f0',
            value: '0',
            tokenIn: inputAsset.address,
            amountToApprove: '200',
            tokenOut: '0x0000000000000000000000000000000000000000',
            minTokenOut: '0',
          },
          {
            target: '0xFf70F4A1d11995621854F3692acF286d8aCd04b2',
            data: '0x4666fc80',
            value: '0x0',
            tokenIn: inputAsset.address,
            amountToApprove: '999800',
            tokenOut: outputAsset.address,
            minTokenOut: minimumAmount,
          },
        ],
      },
    },
  };
}

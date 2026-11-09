import { parseUnits, type Address } from 'viem';
import type { SwapEstimate } from '@circle-fin/swap-kit';
import { ARC_EURC, ARC_USDC, type BaseAssetConfig } from '../../data/tokens';
import type { ArcSwapSymbol } from '../../types/swap';

const RATE_SCALE = 18;
const MAX_RATE_AGE_MS = 15 * 60 * 1000;

const assets: Record<ArcSwapSymbol, BaseAssetConfig & { address: Address }> = {
  USDC: ARC_USDC,
  EURC: ARC_EURC,
};

interface ArcSwapRouteStep {
  type: string;
  tool: string;
  toolName: string;
  fromToken: { address: string; symbol: string; decimals: number };
  toToken: { address: string; symbol: string; decimals: number };
  estimate: { fromAmount: string; toAmount: string };
}

export interface ArcSwapRouteQuote {
  quote: {
    estimatedAmount: string;
    minAmount: string;
    route: { provider: string; steps: ArcSwapRouteStep[] };
  };
  fees?: Array<{
    token: string;
    amount: string;
    decimals: number;
    symbol: string;
    chain?: string;
  }>;
}

export interface ArcSwapExecutionPayload {
  amount: string;
  estimatedAmount: string;
  tokenInAddress: string;
  tokenOutAddress: string;
  fromAddress: string;
  toAddress: string;
  route: { provider: string; steps: ArcSwapRouteStep[] };
  fees: {
    provider: Array<{
      type: string;
      token: string;
      amount: string;
      decimals: number;
      chain: string;
      symbol: string;
    }>;
    swap: unknown[];
  };
  transaction: {
    signature: `0x${string}`;
    executionParams: {
      execId: string;
      deadline: string;
      metadata: `0x${string}`;
      tokens: Array<{ token: string; beneficiary: string }>;
      instructions: Array<{
        target: string;
        data: `0x${string}`;
        value: string;
        tokenIn: string;
        amountToApprove: string;
        tokenOut: string;
        minTokenOut: string;
      }>;
    };
  };
}

export interface ArcSwapPoolEvidence {
  tokenIn: ArcSwapSymbol;
  tokenOut: ArcSwapSymbol;
  amountIn: bigint;
  providerFee: bigint;
  amountToPool: bigint;
  expectedOutput: bigint;
  minimumOutput: bigint;
}

const ARC_FEE_COLLECTOR = '0xf992EFCB5FA2eD7cB48310D9dd8Cb4ce5FB7DdC9';
const ARC_FLY_ROUTER = '0xFf70F4A1d11995621854F3692acF286d8aCd04b2';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MAX_POOL_QUOTE_DEVIATION_BPS = 10n;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isArcSwapEvmAddress(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
}

function isRouteToken(value: unknown): value is ArcSwapRouteStep['fromToken'] {
  return isRecord(value) &&
    isArcSwapEvmAddress(value.address) &&
    typeof value.symbol === 'string' &&
    typeof value.decimals === 'number' &&
    Number.isInteger(value.decimals);
}

function isEvmQuantity(value: unknown): value is string {
  return typeof value === 'string' &&
    (/^\d+$/.test(value) || /^0x[0-9a-f]+$/i.test(value));
}

function isZeroEvmQuantity(value: unknown): boolean {
  return isEvmQuantity(value) && BigInt(value) === 0n;
}

export function isArcSwapRouteQuote(value: unknown): value is ArcSwapRouteQuote {
  if (!isRecord(value) || !isRecord(value.quote)) return false;
  const quote = value.quote;
  if (!isRecord(quote.route)) return false;
  const route = quote.route;
  if (
    typeof quote.estimatedAmount !== 'string' ||
    typeof quote.minAmount !== 'string' ||
    typeof route.provider !== 'string' ||
    !Array.isArray(route.steps) ||
    route.steps.length === 0
  ) return false;

  const validSteps = route.steps.every((step: unknown) =>
    isRecord(step) &&
    typeof step.type === 'string' &&
    typeof step.tool === 'string' &&
    typeof step.toolName === 'string' &&
    isRouteToken(step.fromToken) &&
    isRouteToken(step.toToken) &&
    isRecord(step.estimate) &&
    typeof step.estimate.fromAmount === 'string' &&
    typeof step.estimate.toAmount === 'string',
  );
  const validFees = value.fees === undefined || (
    Array.isArray(value.fees) &&
    value.fees.every((fee) =>
      isRecord(fee) &&
      typeof fee.token === 'string' &&
      typeof fee.amount === 'string' &&
      typeof fee.decimals === 'number' &&
      Number.isInteger(fee.decimals) &&
      typeof fee.symbol === 'string' &&
      (fee.chain === undefined || typeof fee.chain === 'string'),
    )
  );
  return validSteps && validFees;
}

export function isArcSwapExecutionPayload(value: unknown): value is ArcSwapExecutionPayload {
  if (
    !isRecord(value) ||
    !isRecord(value.route) ||
    !isRecord(value.fees) ||
    !isRecord(value.transaction) ||
    !isRecord(value.transaction.executionParams)
  ) return false;
  const { route, fees, transaction } = value;
  if (!isRecord(transaction.executionParams)) return false;
  const params = transaction.executionParams;
  const validInstructions = Array.isArray(params.instructions) && params.instructions.every((instruction: unknown) =>
    isRecord(instruction) &&
    isArcSwapEvmAddress(instruction.target) &&
    typeof instruction.data === 'string' &&
    /^0x([0-9a-f]{2})+$/i.test(instruction.data) &&
    isEvmQuantity(instruction.value) &&
    isArcSwapEvmAddress(instruction.tokenIn) &&
    typeof instruction.amountToApprove === 'string' &&
    /^\d+$/.test(instruction.amountToApprove) &&
    isArcSwapEvmAddress(instruction.tokenOut) &&
    typeof instruction.minTokenOut === 'string' &&
    /^\d+$/.test(instruction.minTokenOut),
  );
  const validTokens = Array.isArray(params.tokens) && params.tokens.every((token: unknown) =>
    isRecord(token) &&
    isArcSwapEvmAddress(token.token) &&
    isArcSwapEvmAddress(token.beneficiary),
  );
  const validFees = Array.isArray(fees.provider) &&
    fees.provider.every((fee: unknown) =>
      isRecord(fee) &&
      typeof fee.type === 'string' &&
      isArcSwapEvmAddress(fee.token) &&
      typeof fee.amount === 'string' &&
      /^\d+$/.test(fee.amount) &&
      typeof fee.decimals === 'number' &&
      Number.isInteger(fee.decimals) &&
      typeof fee.chain === 'string' &&
      typeof fee.symbol === 'string',
    ) &&
    Array.isArray(fees.swap);
  return (
    typeof value.amount === 'string' &&
    /^\d+$/.test(value.amount) &&
    typeof value.estimatedAmount === 'string' &&
    /^\d+$/.test(value.estimatedAmount) &&
    isArcSwapEvmAddress(value.tokenInAddress) &&
    isArcSwapEvmAddress(value.tokenOutAddress) &&
    isArcSwapEvmAddress(value.fromAddress) &&
    isArcSwapEvmAddress(value.toAddress) &&
    typeof route.provider === 'string' &&
    Array.isArray(route.steps) &&
    route.steps.every((step: unknown) =>
      isRecord(step) &&
      typeof step.type === 'string' &&
      typeof step.tool === 'string' &&
      typeof step.toolName === 'string' &&
      isRouteToken(step.fromToken) &&
      isRouteToken(step.toToken) &&
      isRecord(step.estimate) &&
      typeof step.estimate.fromAmount === 'string' &&
      /^\d+$/.test(step.estimate.fromAmount) &&
      typeof step.estimate.toAmount === 'string' &&
      /^\d+$/.test(step.estimate.toAmount),
    ) &&
    validFees &&
    typeof transaction.signature === 'string' &&
    /^0x[0-9a-f]{130}$/i.test(transaction.signature) &&
    typeof params.execId === 'string' &&
    /^(?:0x[0-9a-f]+|\d+)$/i.test(params.execId) &&
    typeof params.deadline === 'string' &&
    /^\d+$/.test(params.deadline) &&
    typeof params.metadata === 'string' &&
    /^0x([0-9a-f]{2})*$/i.test(params.metadata) &&
    validTokens &&
    validInstructions
  );
}

export interface ArcSwapTokenRate {
  priceUSD: string;
  fetchedAt: number;
  decimals?: number;
}

export interface ArcSwapQuoteVerificationRequest {
  tokenIn: ArcSwapSymbol;
  tokenOut: ArcSwapSymbol;
  amountIn: string;
  slippageBps: number;
}

export class ArcSwapQuoteVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArcSwapQuoteVerificationError';
  }
}

export function isArcSwapRouteUnavailableError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<object>();
  const unavailableMessage = /no route available|unsupported route|insufficient [\w ]*liquidity|no liquidity|liquidity unavailable|multi-tick quote is unavailable|independently verified only for EURC|remains disabled until its route passes/i;

  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (unavailableMessage.test(current)) return true;
      continue;
    }
    if (!current || typeof current !== 'object' || visited.has(current)) continue;

    visited.add(current);
    const details = current as Record<string, unknown>;
    if (
      details.name === 'INPUT_UNSUPPORTED_ROUTE' ||
      details.code === 1003 ||
      details.code === '1003' ||
      details.code === 331001 ||
      details.code === '331001'
    ) return true;

    pending.push(details.message, details.cause, details.response, details.data, details.error);
  }

  return false;
}

function fail(message: string): never {
  throw new ArcSwapQuoteVerificationError(message);
}

function parseBaseUnits(value: string, decimals: number, label: string): bigint {
  try {
    if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error('Invalid decimal amount');
    return parseUnits(value, decimals);
  } catch {
    return fail(`Circle Swap returned an invalid ${label} amount. The quote is hidden for safety.`);
  }
}

function parseRate(value: string, label: string): bigint {
  try {
    if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error('Invalid rate');
    const rate = parseUnits(value, RATE_SCALE);
    if (rate <= 0n) throw new Error('Non-positive rate');
    return rate;
  } catch {
    return fail(`A valid current USD rate is unavailable for ${label}. The quote is hidden for safety.`);
  }
}

function isIntegerString(value: string): boolean {
  return /^\d+$/.test(value);
}

function validateRoute(
  routeQuote: ArcSwapRouteQuote,
  request: ArcSwapQuoteVerificationRequest,
  estimate: SwapEstimate,
): { inputAmount: bigint; outputAmount: bigint } {
  const inputAsset = assets[request.tokenIn];
  const outputAsset = assets[request.tokenOut];
  const route = routeQuote.quote?.route;
  const steps = route?.steps;
  if (!route?.provider || !steps?.length) {
    return fail('Circle Swap did not return a verifiable Arc Testnet route. The quote is hidden for safety.');
  }

  const inputAddress = inputAsset.address.toLowerCase();
  const outputAddress = outputAsset.address.toLowerCase();
  const firstStep = steps[0];
  const lastStep = steps[steps.length - 1];
  if (
    !firstStep ||
    !lastStep ||
    firstStep.type !== 'swap' ||
    lastStep.type !== 'swap' ||
    firstStep.fromToken.address.toLowerCase() !== inputAddress ||
    firstStep.fromToken.symbol !== request.tokenIn ||
    firstStep.fromToken.decimals !== inputAsset.decimals ||
    lastStep.toToken.address.toLowerCase() !== outputAddress ||
    lastStep.toToken.symbol !== request.tokenOut ||
    lastStep.toToken.decimals !== outputAsset.decimals ||
    steps.some((step, index) => {
      if (
        step.type !== 'swap' ||
        !step.tool ||
        !step.toolName ||
        !isIntegerString(step.estimate.fromAmount) ||
        !isIntegerString(step.estimate.toAmount) ||
        step.estimate.fromAmount === '0' ||
        step.estimate.toAmount === '0' ||
        step.fromToken.decimals !== (index === 0 ? inputAsset.decimals : steps[index - 1]?.toToken.decimals) ||
        step.toToken.decimals !== (index === steps.length - 1 ? outputAsset.decimals : steps[index + 1]?.fromToken.decimals)
      ) return true;
      const previousStep = steps[index - 1];
      return Boolean(previousStep && (
        previousStep.toToken.address.toLowerCase() !== step.fromToken.address.toLowerCase() ||
        previousStep.toToken.symbol !== step.fromToken.symbol ||
        previousStep.toToken.decimals !== step.fromToken.decimals
      ));
    }) ||
    !isIntegerString(routeQuote.quote.estimatedAmount) ||
    !isIntegerString(routeQuote.quote.minAmount) ||
    BigInt(routeQuote.quote.minAmount) <= 0n ||
    BigInt(routeQuote.quote.minAmount) > BigInt(routeQuote.quote.estimatedAmount)
  ) {
    return fail('Circle Swap returned a route that does not match the configured Arc Testnet tokens. The quote is hidden for safety.');
  }

  const inputAmount = parseBaseUnits(request.amountIn, inputAsset.decimals, 'input');
  const routeOutputAmount = BigInt(routeQuote.quote.estimatedAmount);
  const routeMinimumAmount = BigInt(routeQuote.quote.minAmount);
  const sdkOutputAmount = parseBaseUnits(estimate.estimatedOutput.amount, outputAsset.decimals, 'expected output');
  const sdkMinimumAmount = parseBaseUnits(estimate.stopLimit.amount, outputAsset.decimals, 'minimum received');
  const slippageFactor = BigInt(10_000 - request.slippageBps);
  const routeOutputDifference = routeOutputAmount > sdkOutputAmount
    ? routeOutputAmount - sdkOutputAmount
    : sdkOutputAmount - routeOutputAmount;
  if (
    inputAmount <= 0n ||
    BigInt(firstStep.estimate.fromAmount) > inputAmount ||
    BigInt(lastStep.estimate.toAmount) !== routeOutputAmount ||
    routeOutputDifference * 10_000n > routeOutputAmount * BigInt(request.slippageBps) ||
    routeMinimumAmount * 10_000n < routeOutputAmount * slippageFactor ||
    sdkMinimumAmount <= 0n ||
    sdkMinimumAmount > sdkOutputAmount ||
    sdkMinimumAmount * 10_000n < sdkOutputAmount * slippageFactor ||
    estimate.estimatedOutput.token !== request.tokenOut ||
    estimate.stopLimit.token !== request.tokenOut ||
    parseBaseUnits(estimate.amountIn, inputAsset.decimals, 'input') !== inputAmount ||
    estimate.tokenIn !== request.tokenIn ||
    estimate.tokenOut !== request.tokenOut ||
    estimate.chainIn !== 'Arc_Testnet' ||
    estimate.chainOut !== 'Arc_Testnet'
  ) {
    return fail('Circle Swap estimate and selected route disagree on token order or output units. The quote is hidden for safety.');
  }

  const serviceFees = routeQuote.fees ?? [];
  const sdkFees = (estimate.fees ?? []).filter((fee) => fee.type !== 'gas');
  if (serviceFees.length !== sdkFees.length) {
    return fail('Circle Swap estimate and selected route disagree on fee components. The quote is hidden for safety.');
  }
  for (const serviceFee of serviceFees) {
    const feeAsset = Object.values(assets).find((asset) =>
      asset.address.toLowerCase() === serviceFee.token.toLowerCase() &&
      asset.symbol === serviceFee.symbol,
    );
    const sdkFeeIndex = sdkFees.findIndex((fee) =>
      fee.token === serviceFee.symbol &&
      fee.amount !== null &&
      parseBaseUnits(fee.amount, serviceFee.decimals, `${fee.type} fee`) ===
        BigInt(serviceFee.amount),
    );
    if (
      !feeAsset ||
      serviceFee.decimals !== feeAsset.decimals ||
      (serviceFee.chain !== undefined && serviceFee.chain !== 'Arc_Testnet') ||
      sdkFeeIndex < 0
    ) {
      return fail('Circle Swap estimate and selected route disagree on fee tokens or units. The quote is hidden for safety.');
    }
    sdkFees.splice(sdkFeeIndex, 1);
  }

  return { inputAmount, outputAmount: sdkOutputAmount };
}

export function verifyArcSwapEstimate(
  estimate: SwapEstimate,
  request: ArcSwapQuoteVerificationRequest,
  routeQuote: ArcSwapRouteQuote,
  rates: Readonly<Record<string, ArcSwapTokenRate | undefined>>,
  now = Date.now(),
): void {
  if (
    request.tokenIn === request.tokenOut ||
    !Number.isInteger(request.slippageBps) ||
    request.slippageBps < 0 ||
    request.slippageBps > 10_000
  ) {
    return fail('Arc Swap quote parameters are invalid. Request a fresh quote.');
  }

  const { inputAmount, outputAmount } = validateRoute(routeQuote, request, estimate);
  const inputAsset = assets[request.tokenIn];
  const outputAsset = assets[request.tokenOut];
  const inputRate = rates[inputAsset.address.toLowerCase()];
  const outputRate = rates[outputAsset.address.toLowerCase()];

  if (
    !inputRate ||
    !outputRate ||
    !Number.isFinite(inputRate.fetchedAt) ||
    !Number.isFinite(outputRate.fetchedAt) ||
    now - inputRate.fetchedAt > MAX_RATE_AGE_MS ||
    now - outputRate.fetchedAt > MAX_RATE_AGE_MS ||
    inputRate.fetchedAt - now > MAX_RATE_AGE_MS ||
    outputRate.fetchedAt - now > MAX_RATE_AGE_MS ||
    (inputRate.decimals !== undefined && inputRate.decimals !== inputAsset.decimals) ||
    (outputRate.decimals !== undefined && outputRate.decimals !== outputAsset.decimals)
  ) {
    if (!inputRate || !outputRate) {
      return fail('No independent Arc Testnet USDC/EURC pricing evidence is available. Circle cached USD rates and a Fly/LI.FI quote do not independently verify this route, so the quote is hidden for safety.');
    }
    return fail('Fresh USD rates for the configured Arc Testnet tokens are unavailable. The quote is hidden for safety.');
  }

  const inputUsdRate = parseRate(inputRate.priceUSD, request.tokenIn);
  const outputUsdRate = parseRate(outputRate.priceUSD, request.tokenOut);
  const inputUsdValue = inputAmount * inputUsdRate / (10n ** BigInt(inputAsset.decimals));
  const outputUsdValue = outputAmount * outputUsdRate / (10n ** BigInt(outputAsset.decimals));
  let feeUsdValue = 0n;

  for (const fee of estimate.fees ?? []) {
    if (fee.amount === null) {
      return fail(`Circle Swap could not estimate the ${fee.type} fee. The quote is hidden for safety.`);
    }
    const feeAsset = assets[fee.token as ArcSwapSymbol];
    if (!feeAsset) {
      return fail(`Circle Swap returned a fee in an unsupported token (${fee.token}). The quote is hidden for safety.`);
    }
    const feeRate = rates[feeAsset.address.toLowerCase()];
    if (!feeRate || !Number.isFinite(feeRate.fetchedAt) || now - feeRate.fetchedAt > MAX_RATE_AGE_MS) {
      return fail(`A fresh USD rate for the ${fee.token} fee is unavailable. The quote is hidden for safety.`);
    }
    const feeUsdRate = parseRate(feeRate.priceUSD, fee.token);
    const feeAmount = parseBaseUnits(fee.amount, RATE_SCALE, `${fee.type} fee`);
    feeUsdValue += feeAmount * feeUsdRate / (10n ** BigInt(RATE_SCALE));
  }

  const valueDifference = inputUsdValue > outputUsdValue
    ? inputUsdValue - outputUsdValue
    : outputUsdValue - inputUsdValue;
  const slippageAllowance = inputUsdValue * BigInt(request.slippageBps) / 10_000n;
  if (valueDifference > feeUsdValue + slippageAllowance) {
    return fail(
      `Arc Testnet ${request.tokenIn} → ${request.tokenOut} route is unavailable: Circle's estimate cannot be reconciled with current market USD reference values. Those values do not prove executable testnet pricing, so no output, minimum, or fee estimate is shown.`,
    );
  }
}

export function isArcSwapPoolPriceWithinTolerance(candidate: bigint, expected: bigint): boolean {
  const difference = candidate > expected ? candidate - expected : expected - candidate;
  return expected > 0n && difference * 10_000n <= expected * MAX_POOL_QUOTE_DEVIATION_BPS;
}

export function verifyArcSwapExecutionPayload(
  estimate: SwapEstimate,
  payload: ArcSwapExecutionPayload,
  request: ArcSwapQuoteVerificationRequest,
  evidence: ArcSwapPoolEvidence,
  walletAddress: string,
  now = Date.now(),
): void {
  if (
    !(
      (request.tokenIn === 'EURC' && request.tokenOut === 'USDC') ||
      (request.tokenIn === 'USDC' && request.tokenOut === 'EURC')
    ) ||
    !Number.isInteger(request.slippageBps) ||
    request.slippageBps < 0 ||
    request.slippageBps > 10_000
  ) {
    return fail('Only Arc Testnet USDC/EURC swaps can be independently verified.');
  }

  const inputAsset = assets[request.tokenIn];
  const outputAsset = assets[request.tokenOut];
  const params = payload.transaction.executionParams;
  const inputAmount = parseBaseUnits(request.amountIn, inputAsset.decimals, 'input');
  const estimatedAmount = BigInt(payload.estimatedAmount);
  const minimumAmount = BigInt(params.instructions[1]?.minTokenOut ?? '0');
  const signatureDeadline = BigInt(params.deadline);
  const instructions = params.instructions;
  const tokens = params.tokens;
  const step = payload.route.steps[0];
  const serviceFee = payload.fees.provider[0];
  const providerFees = (estimate.fees ?? []).filter((fee) => fee.type !== 'gas');
  const gasFees = (estimate.fees ?? []).filter((fee) => fee.type === 'gas');
  const providerFee = serviceFee ? BigInt(serviceFee.amount) : 0n;

  if (
    inputAmount <= 0n ||
    inputAmount !== evidence.amountIn ||
    evidence.tokenIn !== request.tokenIn ||
    evidence.tokenOut !== request.tokenOut ||
    evidence.providerFee !== providerFee ||
    evidence.amountToPool !== inputAmount - providerFee ||
    estimatedAmount <= 0n ||
    !isArcSwapPoolPriceWithinTolerance(estimatedAmount, evidence.expectedOutput) ||
    parseBaseUnits(estimate.estimatedOutput.amount, outputAsset.decimals, 'expected output') !== estimatedAmount ||
    parseBaseUnits(estimate.stopLimit.amount, outputAsset.decimals, 'minimum received') !== minimumAmount ||
    !step ||
    payload.amount !== inputAmount.toString() ||
    payload.tokenInAddress.toLowerCase() !== inputAsset.address.toLowerCase() ||
    payload.tokenOutAddress.toLowerCase() !== outputAsset.address.toLowerCase() ||
    payload.fromAddress.toLowerCase() !== walletAddress.toLowerCase() ||
    payload.toAddress.toLowerCase() !== walletAddress.toLowerCase() ||
    payload.route.provider.toLowerCase() !== 'lifi' ||
    payload.route.steps.length !== 1 ||
    step.type !== 'swap' ||
    step.tool.toLowerCase() !== 'fly' ||
    step.fromToken.address.toLowerCase() !== inputAsset.address.toLowerCase() ||
    step.fromToken.symbol !== request.tokenIn ||
    step.fromToken.decimals !== inputAsset.decimals ||
    step.toToken.address.toLowerCase() !== outputAsset.address.toLowerCase() ||
    step.toToken.symbol !== request.tokenOut ||
    step.toToken.decimals !== outputAsset.decimals ||
    step.estimate.fromAmount !== evidence.amountToPool.toString() ||
    step.estimate.toAmount !== estimatedAmount.toString() ||
    instructions.length !== 2 ||
    tokens.length !== 2 ||
    serviceFee?.type !== 'PARTNER' ||
    serviceFee.token.toLowerCase() !== inputAsset.address.toLowerCase() ||
    serviceFee.symbol !== request.tokenIn ||
    serviceFee.decimals !== inputAsset.decimals ||
    serviceFee.chain !== 'Arc_Testnet' ||
    payload.fees.provider.length !== 1 ||
    payload.fees.swap.length !== 0 ||
    providerFees.length !== 1 ||
    providerFees[0]?.token !== request.tokenIn ||
    providerFees[0]?.amount === null ||
    parseBaseUnits(providerFees[0]!.amount!, inputAsset.decimals, 'provider fee') !== providerFee ||
    gasFees.length !== 1 ||
    gasFees[0]?.token !== 'USDC' ||
    gasFees[0]?.amount === null ||
    !/^\d+(?:\.\d+)?$/.test(gasFees[0]!.amount!) ||
    estimate.tokenIn !== request.tokenIn ||
    estimate.tokenOut !== request.tokenOut ||
    parseBaseUnits(estimate.amountIn, inputAsset.decimals, 'input') !== inputAmount ||
    estimate.estimatedOutput.token !== request.tokenOut ||
    estimate.chainIn !== 'Arc_Testnet' ||
    estimate.chainOut !== 'Arc_Testnet' ||
    estimate.fromAddress?.toLowerCase() !== walletAddress.toLowerCase() ||
    estimate.toAddress?.toLowerCase() !== walletAddress.toLowerCase() ||
    signatureDeadline <= BigInt(Math.floor(now / 1000)) ||
    instructions[0]?.target.toLowerCase() !== ARC_FEE_COLLECTOR.toLowerCase() ||
    instructions[0]?.data.slice(0, 10).toLowerCase() !== '0x7ebc46f0' ||
    !isZeroEvmQuantity(instructions[0]?.value) ||
    instructions[0]?.tokenIn.toLowerCase() !== inputAsset.address.toLowerCase() ||
    instructions[0]?.amountToApprove !== providerFee.toString() ||
    instructions[0]?.tokenOut.toLowerCase() !== ZERO_ADDRESS.toLowerCase() ||
    instructions[0]?.minTokenOut !== '0' ||
    instructions[1]?.target.toLowerCase() !== ARC_FLY_ROUTER.toLowerCase() ||
    instructions[1]?.data.slice(0, 10).toLowerCase() !== '0x4666fc80' ||
    !isZeroEvmQuantity(instructions[1]?.value) ||
    instructions[1]?.tokenIn.toLowerCase() !== inputAsset.address.toLowerCase() ||
    instructions[1]?.amountToApprove !== evidence.amountToPool.toString() ||
    instructions[1]?.tokenOut.toLowerCase() !== outputAsset.address.toLowerCase() ||
    minimumAmount <= 0n ||
    minimumAmount > evidence.expectedOutput ||
    minimumAmount > estimatedAmount ||
    minimumAmount < evidence.minimumOutput ||
    tokens[0]?.token.toLowerCase() !== inputAsset.address.toLowerCase() ||
    tokens[0]?.beneficiary.toLowerCase() !== walletAddress.toLowerCase() ||
    tokens[1]?.token.toLowerCase() !== outputAsset.address.toLowerCase() ||
    tokens[1]?.beneficiary.toLowerCase() !== walletAddress.toLowerCase() ||
    params.instructions.reduce((sum, instruction) => sum + BigInt(instruction.amountToApprove), 0n) !== inputAmount ||
    estimate.stopLimit.token !== request.tokenOut ||
    estimate.estimatedOutput.token !== request.tokenOut
  ) {
    return fail('Circle returned a signed Arc Testnet route that does not match the independently verified EURC/USDC pool quote, recipient, fees, output floor, or token units. The quote is hidden for safety.');
  }
}

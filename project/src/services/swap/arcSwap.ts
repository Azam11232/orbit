import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2';
import {
  Blockchain,
  createSwapKitContext,
  estimate,
  getChainByEnum,
  swap,
  type SwapEstimate,
} from '@circle-fin/swap-kit';
import {
  decodeFunctionData,
  parseAbi,
  parseUnits,
  type Address,
  type EIP1193Provider,
  type EIP1193Parameters,
  type Hash,
  type PublicClient,
} from 'viem';
import { ARC_EURC, ARC_USDC } from '../../data/tokens';
import type { ArcSwapSymbol } from '../../types/swap';
import { ArcSwapQuoteVerificationError } from './quoteVerification';
import {
  ARC_FLY_ROUTER,
  ARC_SWAP_ADAPTER,
  ARC_SWAP_FEE_COLLECTOR,
} from './receiptAccounting';

const ARC_CHAIN_ID = 5042002;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const swapContext = createSwapKitContext();
const ERC20_ABI = parseAbi([
  'function approve(address spender,uint256 amount)',
]);
const ADAPTER_ABI = parseAbi([
  'function execute(((address target,bytes data,uint256 value,address tokenIn,uint256 amountToApprove,address tokenOut,uint256 minTokenOut)[] instructions,(address token,address beneficiary)[] tokens,uint256 execId,uint256 deadline,bytes metadata) params,(uint8 permitType,address token,uint256 amount,bytes permitCalldata)[] tokenInputs,bytes signature)',
]);

export interface ArcSwapRequest {
  provider: EIP1193Provider;
  publicClient: PublicClient;
  walletAddress: Address;
  tokenIn: ArcSwapSymbol;
  tokenOut: ArcSwapSymbol;
  amountIn: string;
  slippageBps: number;
}

export type ArcSwapQuoteValidationRequest = Pick<
  ArcSwapRequest,
  'walletAddress' | 'tokenIn' | 'tokenOut' | 'amountIn' | 'slippageBps'
>;

export type ArcSwapQuote = SwapEstimate;
type SwapKitAdapter = Parameters<typeof estimate>[1]['from']['adapter'];

function toSwapKitAdapter(
  adapter: Awaited<ReturnType<typeof createViemAdapterFromProvider>>,
): SwapKitAdapter {
  // The installed packages resolve distinct copies of the shared adapter capability types.
  return adapter as unknown as SwapKitAdapter;
}

function getArcSwapAsset(symbol: ArcSwapSymbol) {
  return symbol === 'USDC' ? ARC_USDC : ARC_EURC;
}

function parseInputAmount(amount: string): bigint {
  try {
    const parsed = parseUnits(amount, 6);
    if (parsed <= 0n) throw new Error('Amount must be positive.');
    return parsed;
  } catch {
    throw new ArcSwapQuoteVerificationError('Enter a valid Arc Testnet swap amount with up to six decimals.');
  }
}

function assertArcSwapPair(tokenIn: ArcSwapSymbol, tokenOut: ArcSwapSymbol): void {
  if (!(
    (tokenIn === 'USDC' && tokenOut === 'EURC') ||
    (tokenIn === 'EURC' && tokenOut === 'USDC')
  )) {
    throw new ArcSwapQuoteVerificationError('Only Arc Testnet USDC/EURC swaps are supported.');
  }
}

function assertArcSwapConfiguration(): void {
  const chain = getChainByEnum(Blockchain.Arc_Testnet);
  if (
    chain.kitContracts?.adapter?.toLowerCase() !== ARC_SWAP_ADAPTER.toLowerCase() ||
    chain.usdcAddress?.toLowerCase() !== ARC_USDC.address.toLowerCase() ||
    chain.eurcAddress?.toLowerCase() !== ARC_EURC.address.toLowerCase()
  ) {
    throw new ArcSwapQuoteVerificationError('Circle Swap Kit Arc Testnet token or Adapter configuration does not match ORBIT.');
  }
}

async function assertWalletContext(
  provider: EIP1193Provider,
  walletAddress: Address,
  publicClient: PublicClient,
): Promise<void> {
  const [chainId, accounts, rpcChainId] = await Promise.all([
    provider.request({ method: 'eth_chainId' }),
    provider.request({ method: 'eth_accounts' }),
    publicClient.getChainId(),
  ]);
  if (
    typeof chainId !== 'string' ||
    Number.parseInt(chainId, 16) !== ARC_CHAIN_ID ||
    rpcChainId !== ARC_CHAIN_ID ||
    !Array.isArray(accounts) ||
    !accounts.some((account) => typeof account === 'string' && account.toLowerCase() === walletAddress.toLowerCase())
  ) {
    throw new ArcSwapQuoteVerificationError('The connected wallet changed accounts or left Arc Testnet. Reconnect and request a fresh quote.');
  }
}

export function verifyArcSwapEstimate(quote: SwapEstimate, request: ArcSwapQuoteValidationRequest): void {
  assertArcSwapPair(request.tokenIn, request.tokenOut);
  if (!Number.isInteger(request.slippageBps) || request.slippageBps < 0 || request.slippageBps > 10_000) {
    throw new ArcSwapQuoteVerificationError('Arc Swap slippage settings are invalid.');
  }
  const inputAsset = getArcSwapAsset(request.tokenIn);
  const outputAsset = getArcSwapAsset(request.tokenOut);
  const inputAmount = parseInputAmount(request.amountIn);
  let quotedInput: bigint;
  let expectedOutput: bigint;
  let minimumOutput: bigint;
  try {
    quotedInput = parseUnits(quote.amountIn, inputAsset.decimals);
    expectedOutput = parseUnits(quote.estimatedOutput.amount, outputAsset.decimals);
    minimumOutput = parseUnits(quote.stopLimit.amount, outputAsset.decimals);
  } catch {
    throw new ArcSwapQuoteVerificationError('Circle Swap returned invalid input or output units. The quote is hidden for safety.');
  }
  const route = quote.route;
  const firstStep = route?.steps[0];
  const lastStep = route?.steps[route.steps.length - 1];
  let routeInputAmount: bigint;
  let routeOutputAmount: bigint;
  try {
    routeInputAmount = BigInt(firstStep?.estimate.fromAmount ?? '');
    routeOutputAmount = BigInt(lastStep?.estimate.toAmount ?? '');
  } catch {
    throw new ArcSwapQuoteVerificationError('Circle Swap returned invalid executable route units.');
  }
  const routeOutputDifference = routeOutputAmount > expectedOutput
    ? routeOutputAmount - expectedOutput
    : expectedOutput - routeOutputAmount;
  const slippageFactor = BigInt(10_000 - request.slippageBps);
  if (
    quote.chainIn !== Blockchain.Arc_Testnet ||
    quote.chainOut !== Blockchain.Arc_Testnet ||
    quote.tokenIn !== request.tokenIn ||
    quote.tokenOut !== request.tokenOut ||
    quotedInput !== inputAmount ||
    quote.fromAddress.toLowerCase() !== request.walletAddress.toLowerCase() ||
    quote.toAddress.toLowerCase() !== request.walletAddress.toLowerCase() ||
    quote.estimatedOutput.token !== request.tokenOut ||
    quote.stopLimit.token !== request.tokenOut ||
    expectedOutput <= 0n ||
    minimumOutput <= 0n ||
    minimumOutput > expectedOutput ||
    routeInputAmount <= 0n ||
    routeInputAmount > inputAmount ||
    routeOutputAmount <= 0n ||
    routeOutputDifference * 10_000n > routeOutputAmount * BigInt(request.slippageBps) ||
    minimumOutput * 10_000n < expectedOutput * slippageFactor ||
    !route?.provider ||
    !firstStep ||
    !lastStep ||
    firstStep.fromToken.address.toLowerCase() !== inputAsset.address.toLowerCase() ||
    firstStep.fromToken.symbol !== request.tokenIn ||
    firstStep.fromToken.decimals !== inputAsset.decimals ||
    lastStep.toToken.address.toLowerCase() !== outputAsset.address.toLowerCase() ||
    lastStep.toToken.symbol !== request.tokenOut ||
    lastStep.toToken.decimals !== outputAsset.decimals ||
    route.steps.some((step, index) => {
      const previousStep = route.steps[index - 1];
      return !step.tool ||
        !step.toolName ||
        !/^\d+$/.test(step.estimate.fromAmount) ||
        !/^\d+$/.test(step.estimate.toAmount) ||
        (previousStep !== undefined &&
          (previousStep.toToken.address.toLowerCase() !== step.fromToken.address.toLowerCase() ||
            previousStep.toToken.symbol !== step.fromToken.symbol ||
            previousStep.toToken.decimals !== step.fromToken.decimals ||
            previousStep.estimate.toAmount !== step.estimate.fromAmount));
    })
  ) {
    throw new ArcSwapQuoteVerificationError('Circle Swap returned a quote that does not match the requested Arc Testnet tokens, wallet, amount, or minimum output.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getTransactionRequest(args: { method: string; params?: unknown }): Record<string, unknown> | undefined {
  if (args.method !== 'eth_sendTransaction' || !Array.isArray(args.params)) return undefined;
  const transaction = args.params[0];
  return isRecord(transaction) ? transaction : undefined;
}

function classifyApproval(
  transaction: Record<string, unknown> | undefined,
  request: ArcSwapRequest,
  inputAmount: bigint,
): boolean {
  if (
    typeof transaction?.to !== 'string' ||
    transaction.to.toLowerCase() !== getArcSwapAsset(request.tokenIn).address.toLowerCase() ||
    typeof transaction.data !== 'string' ||
    !transaction.data.toLowerCase().startsWith('0x095ea7b3')
  ) return false;

  let approval: ReturnType<typeof decodeFunctionData<typeof ERC20_ABI>>;
  try {
    approval = decodeFunctionData({
      abi: ERC20_ABI,
      data: transaction.data as `0x${string}`,
    });
  } catch {
    throw new ArcSwapQuoteVerificationError('Circle Swap requested a malformed token approval. No transaction was submitted.');
  }
  if (
    approval.functionName !== 'approve' ||
    approval.args[0].toLowerCase() !== ARC_SWAP_ADAPTER.toLowerCase() ||
    approval.args[1] !== inputAmount
  ) {
    throw new ArcSwapQuoteVerificationError('Circle Swap requested an approval that does not match the reviewed token, exact amount, or verified Arc Adapter.');
  }
  return true;
}

function verifyAdapterTransaction(
  transaction: Record<string, unknown> | undefined,
  request: ArcSwapRequest,
  inputAmount: bigint,
  quote: ArcSwapQuote,
): boolean {
  if (
    typeof transaction?.to !== 'string' ||
    transaction.to.toLowerCase() !== ARC_SWAP_ADAPTER.toLowerCase()
  ) return false;
  if (typeof transaction.data !== 'string' || !/^0x[0-9a-f]+$/i.test(transaction.data)) {
    throw new ArcSwapQuoteVerificationError('Circle Swap returned a malformed Arc Adapter transaction.');
  }

  let decoded: ReturnType<typeof decodeFunctionData<typeof ADAPTER_ABI>>;
  try {
    decoded = decodeFunctionData({
      abi: ADAPTER_ABI,
      data: transaction.data as `0x${string}`,
    });
  } catch {
    throw new ArcSwapQuoteVerificationError('Circle Swap returned an unrecognized Arc Adapter transaction.');
  }
  const params = decoded.args[0];
  const tokens = params.tokens;
  const tokenInputs = decoded.args[1];
  const inputAsset = getArcSwapAsset(request.tokenIn);
  const outputAsset = getArcSwapAsset(request.tokenOut);
  const reviewedOutput = parseUnits(quote.estimatedOutput.amount, outputAsset.decimals);
  const reviewedMinimum = parseUnits(quote.stopLimit.amount, outputAsset.decimals);
  const slippageMinimum = reviewedOutput * BigInt(10_000 - request.slippageBps) / 10_000n;
  const feeInstruction = params.instructions[0];
  const swapInstruction = params.instructions[1];
  const approvedAmount = params.instructions.reduce((sum, instruction) => sum + instruction.amountToApprove, 0n);
  if (
    decoded.functionName !== 'execute' ||
    typeof transaction.from !== 'string' ||
    transaction.from.toLowerCase() !== request.walletAddress.toLowerCase() ||
    tokens.length !== 2 ||
    tokens[0]?.token.toLowerCase() !== inputAsset.address.toLowerCase() ||
    tokens[0]?.beneficiary.toLowerCase() !== request.walletAddress.toLowerCase() ||
    tokens[1]?.token.toLowerCase() !== outputAsset.address.toLowerCase() ||
    tokens[1]?.beneficiary.toLowerCase() !== request.walletAddress.toLowerCase() ||
    params.instructions.length !== 2 ||
    !feeInstruction ||
    !swapInstruction ||
    feeInstruction.target.toLowerCase() !== ARC_SWAP_FEE_COLLECTOR.toLowerCase() ||
    feeInstruction.data.slice(0, 10).toLowerCase() !== '0x7ebc46f0' ||
    feeInstruction.value !== 0n ||
    feeInstruction.tokenIn.toLowerCase() !== inputAsset.address.toLowerCase() ||
    feeInstruction.tokenOut.toLowerCase() !== ZERO_ADDRESS ||
    feeInstruction.amountToApprove <= 0n ||
    swapInstruction.target.toLowerCase() !== ARC_FLY_ROUTER.toLowerCase() ||
    swapInstruction.data.slice(0, 10).toLowerCase() !== '0x4666fc80' ||
    swapInstruction.value !== 0n ||
    swapInstruction.tokenIn.toLowerCase() !== inputAsset.address.toLowerCase() ||
    swapInstruction.tokenOut.toLowerCase() !== outputAsset.address.toLowerCase() ||
    swapInstruction.amountToApprove <= 0n ||
    swapInstruction.minTokenOut < reviewedMinimum ||
    swapInstruction.minTokenOut < slippageMinimum ||
    swapInstruction.minTokenOut > reviewedOutput ||
    tokenInputs.length !== 1 ||
    tokenInputs[0]?.permitType !== 0 ||
    tokenInputs[0]?.token.toLowerCase() !== inputAsset.address.toLowerCase() ||
    tokenInputs[0]?.amount !== inputAmount ||
    approvedAmount !== inputAmount
  ) {
    throw new ArcSwapQuoteVerificationError('Circle Swap returned an Arc Adapter transaction with mismatched tokens, recipient, input amount, or output protection.');
  }
  return true;
}

function asTransactionHash(value: unknown): Hash {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) {
    throw new ArcSwapQuoteVerificationError('Arc Testnet did not return a valid swap transaction hash.');
  }
  return value as Hash;
}

export async function estimateArcSwap(request: ArcSwapRequest): Promise<ArcSwapQuote> {
  assertArcSwapPair(request.tokenIn, request.tokenOut);
  parseInputAmount(request.amountIn);
  if (!Number.isInteger(request.slippageBps) || request.slippageBps < 0 || request.slippageBps > 10_000) {
    throw new ArcSwapQuoteVerificationError('Arc Swap slippage settings are invalid.');
  }
  assertArcSwapConfiguration();
  await assertWalletContext(request.provider, request.walletAddress, request.publicClient);
  const adapter = toSwapKitAdapter(await createViemAdapterFromProvider({ provider: request.provider }));
  const quote = await estimate(swapContext, {
    from: { adapter, chain: 'Arc_Testnet' },
    tokenIn: request.tokenIn,
    tokenOut: request.tokenOut,
    amountIn: request.amountIn,
    to: { recipientAddress: request.walletAddress },
    config: { allowanceStrategy: 'approve', slippageBps: request.slippageBps },
  });
  verifyArcSwapEstimate(quote, request);
  return quote;
}

export async function executeArcSwap(
  request: ArcSwapRequest,
  quote: ArcSwapQuote,
  onTransactionHash?: (hash: Hash, kind: 'approval' | 'swap') => void,
  onApprovalConfirmed?: (hash: Hash) => void,
  beforeTransactionRequest?: () => void,
): Promise<{ txHash: Hash }> {
  assertArcSwapPair(request.tokenIn, request.tokenOut);
  if (!Number.isInteger(request.slippageBps) || request.slippageBps < 0 || request.slippageBps > 10_000) {
    throw new ArcSwapQuoteVerificationError('Arc Swap slippage settings are invalid.');
  }
  verifyArcSwapEstimate(quote, request);
  assertArcSwapConfiguration();
  await assertWalletContext(request.provider, request.walletAddress, request.publicClient);

  const inputAmount = parseInputAmount(request.amountIn);
  const inputAsset = getArcSwapAsset(request.tokenIn);
  const approvalHashes: Hash[] = [];
  let swapHash: Hash | undefined;
  let broadcastCallbackError: Error | undefined;
  const reportedHashes = new Set<string>();
  const reportHash = (hash: Hash, kind: 'approval' | 'swap') => {
    if (reportedHashes.has(hash.toLowerCase())) return;
    reportedHashes.add(hash.toLowerCase());
    onTransactionHash?.(hash, kind);
  };
  const instrumentedProvider = new Proxy(request.provider, {
    get(target, property) {
      if (property !== 'request') {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (args: EIP1193Parameters) => {
        if (args.method !== 'eth_sendTransaction') {
          return Reflect.apply(request.provider.request, request.provider, [args]) as Promise<unknown>;
        }
        beforeTransactionRequest?.();
        const transaction = getTransactionRequest(args);
        const isApproval = classifyApproval(transaction, request, inputAmount);
        const isSwap = verifyAdapterTransaction(transaction, request, inputAmount, quote);
        if (!isApproval && !isSwap) {
          throw new ArcSwapQuoteVerificationError('Circle Swap attempted to submit an unverified Arc Testnet transaction.');
        }
        const result = await Reflect.apply(request.provider.request, request.provider, [args]) as unknown;
        const hash = asTransactionHash(result);
        if (isApproval) approvalHashes.push(hash);
        if (isSwap) swapHash = hash;
        reportHash(hash, isApproval ? 'approval' : 'swap');
        return result;
      };
    },
  });

  const adapter = toSwapKitAdapter(await createViemAdapterFromProvider({ provider: instrumentedProvider }));
  beforeTransactionRequest?.();
  const result = await swap(swapContext, {
    from: { adapter, chain: 'Arc_Testnet' },
    tokenIn: request.tokenIn,
    tokenOut: request.tokenOut,
    amountIn: request.amountIn,
    to: { recipientAddress: request.walletAddress },
    config: { allowanceStrategy: 'approve', slippageBps: request.slippageBps },
  }, (transactionHash) => {
    try {
      const hash = asTransactionHash(transactionHash);
      if (swapHash && swapHash.toLowerCase() !== hash.toLowerCase()) {
        throw new ArcSwapQuoteVerificationError('Circle Swap returned a transaction hash that does not match the submitted Arc Adapter transaction.');
      }
      swapHash = hash;
      reportHash(hash, 'swap');
    } catch (error) {
      broadcastCallbackError = error instanceof Error ? error : new Error(String(error));
    }
  });
  if (broadcastCallbackError) throw broadcastCallbackError;
  const resultHash = asTransactionHash(result.txHash);
  if (swapHash && swapHash.toLowerCase() !== resultHash.toLowerCase()) {
    throw new ArcSwapQuoteVerificationError('Circle Swap result does not match the Arc Testnet transaction submitted by the wallet.');
  }
  if (
    result.chainIn !== Blockchain.Arc_Testnet ||
    result.chainOut !== Blockchain.Arc_Testnet ||
    result.tokenIn !== request.tokenIn ||
    result.tokenOut !== request.tokenOut ||
    result.fromAddress.toLowerCase() !== request.walletAddress.toLowerCase() ||
    result.toAddress.toLowerCase() !== request.walletAddress.toLowerCase() ||
    parseUnits(result.amountIn, inputAsset.decimals) !== inputAmount
  ) {
    throw new ArcSwapQuoteVerificationError('Circle Swap execution result does not match the reviewed Arc Testnet swap.');
  }

  for (const hash of approvalHashes) {
    const receipt = await request.publicClient.getTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new ArcSwapQuoteVerificationError(`Arc Testnet token approval ${hash} reverted; the swap was not completed.`);
    }
    onApprovalConfirmed?.(hash);
  }
  return { txHash: resultHash };
}

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { swapMock } = vi.hoisted(() => ({ swapMock: vi.fn() }));

vi.mock('@circle-fin/adapter-viem-v2', () => ({
  createViemAdapterFromProvider: vi.fn(async ({ provider }: { provider: unknown }) => ({ provider })),
}));

vi.mock('@circle-fin/swap-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@circle-fin/swap-kit')>();
  return { ...actual, swap: swapMock };
});

import { Blockchain } from '@circle-fin/swap-kit';
import {
  encodeFunctionData,
  parseAbi,
  parseUnits,
  type Address,
  type EIP1193Provider,
  type Hash,
  type PublicClient,
} from 'viem';
import { ARC_EURC, ARC_USDC } from '../../data/tokens';
import type { ArcSwapSymbol } from '../../types/swap';
import { executeArcSwap, type ArcSwapQuote, type ArcSwapRequest } from './arcSwap';
import {
  ARC_FLY_ROUTER,
  ARC_SWAP_ADAPTER,
  ARC_SWAP_FEE_COLLECTOR,
} from './receiptAccounting';

const wallet = '0x1111111111111111111111111111111111111111' as Address;
const txHash = `0x${'a'.repeat(64)}` as Hash;
const zeroAddress = '0x0000000000000000000000000000000000000000';
const adapterAbi = parseAbi([
  'function execute(((address target,bytes data,uint256 value,address tokenIn,uint256 amountToApprove,address tokenOut,uint256 minTokenOut)[] instructions,(address token,address beneficiary)[] tokens,uint256 execId,uint256 deadline,bytes metadata) params,(uint8 permitType,address token,uint256 amount,bytes permitCalldata)[] tokenInputs,bytes signature)',
]);

type TestProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

function createQuote(tokenIn: ArcSwapSymbol, tokenOut: ArcSwapSymbol): ArcSwapQuote {
  const inputAsset = tokenIn === 'USDC' ? ARC_USDC : ARC_EURC;
  const outputAsset = tokenOut === 'USDC' ? ARC_USDC : ARC_EURC;
  return {
    tokenIn,
    tokenOut,
    amountIn: '1',
    chainIn: Blockchain.Arc_Testnet,
    chainOut: Blockchain.Arc_Testnet,
    chain: Blockchain.Arc_Testnet,
    fromAddress: wallet,
    toAddress: wallet,
    estimatedOutput: { amount: '1.915674', token: tokenOut },
    stopLimit: { amount: '1.906096', token: tokenOut },
    fees: [{ type: 'provider', amount: '0.0002', token: tokenIn }],
    route: {
      provider: 'lifi',
      steps: [{
        type: 'swap',
        tool: 'fly',
        toolName: 'Fly',
        fromToken: { address: inputAsset.address, symbol: tokenIn, decimals: inputAsset.decimals },
        toToken: { address: outputAsset.address, symbol: tokenOut, decimals: outputAsset.decimals },
        estimate: { fromAmount: '999800', toAmount: parseUnits('1.915674', 6).toString() },
      }],
    },
  } satisfies ArcSwapQuote;
}

function createAdapterTransaction({
  minimumOutput = parseUnits('1.906096', 6),
  outputToken = ARC_EURC.address,
}: {
  minimumOutput?: bigint;
  outputToken?: Address;
} = {}) {
  const data = encodeFunctionData({
    abi: adapterAbi,
    functionName: 'execute',
    args: [{
      instructions: [
        {
          target: ARC_SWAP_FEE_COLLECTOR,
          data: '0x7ebc46f0',
          value: 0n,
          tokenIn: ARC_USDC.address,
          amountToApprove: 200n,
          tokenOut: zeroAddress,
          minTokenOut: 0n,
        },
        {
          target: ARC_FLY_ROUTER,
          data: '0x4666fc80',
          value: 0n,
          tokenIn: ARC_USDC.address,
          amountToApprove: 999_800n,
          tokenOut: outputToken,
          minTokenOut: minimumOutput,
        },
      ],
      tokens: [
        { token: ARC_USDC.address, beneficiary: wallet },
        { token: ARC_EURC.address, beneficiary: wallet },
      ],
      execId: 1n,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      metadata: '0x',
    }, [{
      permitType: 0,
      token: ARC_USDC.address,
      amount: 1_000_000n,
      permitCalldata: '0x',
    }], '0x'],
  });
  return { from: wallet, to: ARC_SWAP_ADAPTER, data, value: '0x0' };
}

function createExecutionContext(transaction: ReturnType<typeof createAdapterTransaction>) {
  const providerRequest = vi.fn(async (args: { method: string; params?: unknown[] }) => {
    if (args.method === 'eth_chainId') return `0x${Number(5042002).toString(16)}`;
    if (args.method === 'eth_accounts') return [wallet];
    if (args.method === 'eth_sendTransaction') return txHash;
    throw new Error(`Unexpected provider request: ${args.method}`);
  });
  const provider = { request: providerRequest } as unknown as EIP1193Provider;
  const publicClient = {
    getChainId: vi.fn().mockResolvedValue(5042002),
  } as unknown as PublicClient;
  const request: ArcSwapRequest = {
    provider,
    publicClient,
    walletAddress: wallet,
    tokenIn: 'USDC',
    tokenOut: 'EURC',
    amountIn: '1',
    slippageBps: 50,
  };
  swapMock.mockImplementation(async (
    _context: unknown,
    options: { from: { adapter: { provider: TestProvider } } },
  ) => {
    const submittedHash = await options.from.adapter.provider.request({
      method: 'eth_sendTransaction',
      params: [transaction],
    }) as Hash;
    return {
      txHash: submittedHash,
      chainIn: Blockchain.Arc_Testnet,
      chainOut: Blockchain.Arc_Testnet,
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      fromAddress: wallet,
      toAddress: wallet,
      amountIn: request.amountIn,
    };
  });
  return { providerRequest, publicClient, request };
}

describe('Arc Swap submitted transaction verification', () => {
  beforeEach(() => {
    swapMock.mockReset();
  });

  it('does not forward a transaction whose minimum output is below the reviewed quote', async () => {
    const context = createExecutionContext(createAdapterTransaction({
      minimumOutput: parseUnits('1.906095', 6),
    }));

    await expect(executeArcSwap(context.request, createQuote('USDC', 'EURC')))
      .rejects.toThrow('mismatched tokens, recipient, input amount, or output protection');
    expect(context.providerRequest.mock.calls.filter(([args]) => args.method === 'eth_sendTransaction')).toHaveLength(0);
  });

  it('does not forward mismatched SDK transaction data', async () => {
    const context = createExecutionContext(createAdapterTransaction({
      outputToken: ARC_USDC.address,
    }));

    await expect(executeArcSwap(context.request, createQuote('USDC', 'EURC')))
      .rejects.toThrow('mismatched tokens, recipient, input amount, or output protection');
    expect(context.providerRequest.mock.calls.filter(([args]) => args.method === 'eth_sendTransaction')).toHaveLength(0);
  });

  it('forwards a valid SDK transaction that preserves the reviewed minimum', async () => {
    const context = createExecutionContext(createAdapterTransaction());

    await expect(executeArcSwap(context.request, createQuote('USDC', 'EURC')))
      .resolves.toEqual({ txHash });
    expect(context.providerRequest.mock.calls.filter(([args]) => args.method === 'eth_sendTransaction')).toHaveLength(1);
  });
});

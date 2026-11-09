import { describe, expect, it } from 'vitest';
import {
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  keccak256,
  parseAbi,
  parseAbiParameters,
  parseUnits,
  toBytes,
  toHex,
  type Address,
  type Hash,
} from 'viem';
import { ARC_EURC, ARC_USDC } from '../../data/tokens';
import {
  accountArcSwapReceipt,
  ARC_FLY_ROUTER,
  ARC_SWAP_ADAPTER,
  ARC_SWAP_FEE_COLLECTOR,
  type ArcSwapReceipt,
  type ArcSwapReceiptLog,
  type ArcSwapReceiptTransaction,
} from './receiptAccounting';

const wallet = '0x1111111111111111111111111111111111111111' as Address;
const feeRecipient = '0xc06ebbefd94032b85424d51906e2a335efae264b' as Address;
const splitFeeRecipient = '0xb499efcdb5aa8fbdc9dc4fa0f27cdc3847680320' as Address;
const router = '0x3333333333333333333333333333333333333333' as Address;
const hash = `0x${'f'.repeat(64)}` as Hash;
const executeAbi = parseAbi([
  'function execute(((address target,bytes data,uint256 value,address tokenIn,uint256 amountToApprove,address tokenOut,uint256 minTokenOut)[] instructions,(address token,address beneficiary)[] tokens,uint256 execId,uint256 deadline,bytes metadata) params,(uint8 permitType,address token,uint256 amount,bytes permitCalldata)[] tokenInputs,bytes signature)',
]);
const accountExecuteAbi = parseAbi(['function execute(bytes32 mode,bytes executionCalldata)']);
const approvalAbi = parseAbi([
  'function approve(address spender,uint256 amount)',
  'function increaseAllowance(address spender,uint256 addedValue)',
]);
const accountCallsAbi = parseAbiParameters('(address target,uint256 value,bytes callData)[]');
const batchExecutionMode = `0x0100000000000000000000000000000000000000000000000000000000000000` as const;
const transferTopic = keccak256(toBytes('Transfer(address,address,uint256)'));

function transferLog(token: Address, from: Address, to: Address, amount: bigint): ArcSwapReceiptLog {
  return {
    address: token,
    topics: [
      transferTopic,
      toHex(BigInt(from), { size: 32 }),
      toHex(BigInt(to), { size: 32 }),
    ],
    data: toHex(amount, { size: 32 }),
  };
}

function createTransaction(
  inputAmount = 1_000_000n,
  providerFee = 200n,
  minimumOutput = 1_208_354n,
  tokenIn: 'EURC' | 'USDC' = 'EURC',
): ArcSwapReceiptTransaction {
  const inputAsset = tokenIn === 'EURC' ? ARC_EURC : ARC_USDC;
  const outputAsset = tokenIn === 'EURC' ? ARC_USDC : ARC_EURC;
  const amountToPool = inputAmount - providerFee;
  const input = encodeFunctionData({
    abi: executeAbi,
    functionName: 'execute',
    args: [
      {
        instructions: [
          {
            target: ARC_SWAP_FEE_COLLECTOR,
            data: `0x7ebc46f0${'00'.repeat(32)}`,
            value: 0n,
            tokenIn: inputAsset.address,
            amountToApprove: providerFee,
            tokenOut: '0x0000000000000000000000000000000000000000',
            minTokenOut: 0n,
          },
          {
            target: '0xFf70F4A1d11995621854F3692acF286d8aCd04b2',
            data: `0x4666fc80${'00'.repeat(32)}`,
            value: 0n,
            tokenIn: inputAsset.address,
            amountToApprove: amountToPool,
            tokenOut: outputAsset.address,
            minTokenOut: minimumOutput,
          },
        ],
        tokens: [
          { token: inputAsset.address, beneficiary: wallet },
          { token: outputAsset.address, beneficiary: wallet },
        ],
        execId: 1n,
        deadline: 1_800_000_000n,
        metadata: '0x',
      },
      [{ permitType: 0, token: inputAsset.address, amount: inputAmount, permitCalldata: '0x' }],
      `0x${'1'.repeat(130)}`,
    ],
  });
  return {
    hash,
    from: wallet,
    to: ARC_SWAP_ADAPTER,
    input,
  };
}

function createReceipt(logs: ArcSwapReceiptLog[]): ArcSwapReceipt {
  return {
    transactionHash: hash,
    status: 'success',
    blockTimestamp: 1_800_000_000n,
    gasUsed: 468_062n,
    effectiveGasPrice: 20_500_000_000n,
    logs,
  };
}

function wrapInSmartAccountBatch(
  transaction: ArcSwapReceiptTransaction,
  inputAmount: bigint,
  tokenIn: 'EURC' | 'USDC',
  approvalFunction: 'approve' | 'increaseAllowance',
): ArcSwapReceiptTransaction {
  const inputAsset = tokenIn === 'EURC' ? ARC_EURC : ARC_USDC;
  const approvalCall = encodeFunctionData({
    abi: approvalAbi,
    functionName: approvalFunction,
    args: [ARC_SWAP_ADAPTER, inputAmount],
  });
  const executionCalldata = encodeAbiParameters(accountCallsAbi, [[
    { target: inputAsset.address, value: 0n, callData: approvalCall },
    { target: ARC_SWAP_ADAPTER, value: 0n, callData: transaction.input },
  ]]);
  return {
    ...transaction,
    to: wallet,
    input: encodeFunctionData({
      abi: accountExecuteAbi,
      functionName: 'execute',
      args: [batchExecutionMode, executionCalldata],
    }),
  };
}

describe('Arc Swap receipt accounting', () => {
  it('accounts for the confirmed receipt structure with output distinct from the quote', () => {
    const transaction = createTransaction();
    const receipt = createReceipt([
      transferLog(ARC_EURC.address, wallet, ARC_SWAP_ADAPTER, 1_000_000n),
      transferLog(ARC_EURC.address, ARC_SWAP_ADAPTER, feeRecipient, 200n),
      transferLog(ARC_EURC.address, ARC_SWAP_ADAPTER, ARC_FLY_ROUTER, 999_800n),
      transferLog(ARC_USDC.address, ARC_SWAP_ADAPTER, wallet, 1_214_426n),
    ]);

    const accounting = accountArcSwapReceipt(transaction, receipt, wallet);

    expect(accounting).toEqual({
      inputToken: 'EURC',
      outputToken: 'USDC',
      amountSold: '1',
      minimumReceived: '1.208354',
      providerFee: '0.0002',
      amountReceived: '1.214426',
      gasPaid: '0.009595271',
      completedAt: 1_800_000_000_000,
      usdcBalanceBefore: null,
      usdcBalanceAfter: null,
      netUsdcBalanceChange: '1.214426',
    });
    expect(accounting.amountReceived).not.toBe('1.214421');
  });

  it('reports exact receipt USDC balance change separately from native gas', () => {
    const accounting = accountArcSwapReceipt(createTransaction(), createReceipt([
      transferLog(ARC_EURC.address, wallet, ARC_SWAP_ADAPTER, 1_000_000n),
      transferLog(ARC_EURC.address, ARC_SWAP_ADAPTER, feeRecipient, 200n),
      transferLog(ARC_EURC.address, ARC_SWAP_ADAPTER, ARC_FLY_ROUTER, 999_800n),
      transferLog(ARC_USDC.address, ARC_SWAP_ADAPTER, wallet, 1_214_421n),
    ]), wallet);

    expect(accounting.amountReceived).toBe('1.214421');
    expect(accounting.minimumReceived).toBe('1.208354');
    expect(accounting.gasPaid).toBe('0.009595271');
    expect(accounting.usdcBalanceBefore).toBeNull();
    expect(accounting.usdcBalanceAfter).toBeNull();
    expect(accounting.netUsdcBalanceChange).toBe('1.214421');
  });

  it('accounts for USDC input and actual EURC output from receipt Transfer events', () => {
    const transaction = createTransaction(1_000_000n, 200n, 810_000n, 'USDC');
    const receipt = createReceipt([
      transferLog(ARC_USDC.address, wallet, ARC_SWAP_ADAPTER, 1_000_000n),
      transferLog(ARC_USDC.address, ARC_SWAP_ADAPTER, feeRecipient, 200n),
      transferLog(ARC_USDC.address, ARC_SWAP_ADAPTER, ARC_FLY_ROUTER, 999_800n),
      transferLog(ARC_EURC.address, ARC_SWAP_ADAPTER, wallet, 818_175n),
    ]);

    const accounting = accountArcSwapReceipt(transaction, receipt, wallet);

    expect(accounting.amountSold).toBe('1');
    expect(accounting.inputToken).toBe('USDC');
    expect(accounting.outputToken).toBe('EURC');
    expect(accounting.minimumReceived).toBe('0.81');
    expect(accounting.providerFee).toBe('0.0002');
    expect(accounting.amountReceived).toBe('0.818175');
    expect(accounting.netUsdcBalanceChange).toBe('-1');
  });

  it('derives token balance change from receipt transfers without subtracting native gas', () => {
    const accounting = accountArcSwapReceipt(createTransaction(), createReceipt([
      transferLog(ARC_EURC.address, wallet, ARC_SWAP_ADAPTER, 1_000_000n),
      transferLog(ARC_EURC.address, ARC_SWAP_ADAPTER, feeRecipient, 200n),
      transferLog(ARC_EURC.address, ARC_SWAP_ADAPTER, ARC_FLY_ROUTER, 999_800n),
      transferLog(ARC_USDC.address, ARC_SWAP_ADAPTER, wallet, 1_214_421n),
    ]), wallet);

    expect(accounting.gasPaid).toBe('0.009595271');
    expect(accounting.netUsdcBalanceChange).toBe('1.214421');
    expect(accounting.usdcBalanceBefore).toBeNull();
    expect(accounting.usdcBalanceAfter).toBeNull();
  });

  it('uses the 10 EURC receipt output rather than the conflicting historical balance snapshot delta', () => {
    const accounting = accountArcSwapReceipt(
      createTransaction(10_000_000n, 2_000n, 12_083_465n),
      createReceipt([
        transferLog(ARC_EURC.address, wallet, ARC_SWAP_ADAPTER, 10_000_000n),
        transferLog(ARC_EURC.address, ARC_SWAP_ADAPTER, feeRecipient, 2_000n),
        transferLog(ARC_EURC.address, ARC_SWAP_ADAPTER, ARC_FLY_ROUTER, 9_998_000n),
        transferLog(ARC_USDC.address, ARC_SWAP_ADAPTER, wallet, 12_144_186n),
      ]),
      wallet,
      {
        gasPaid: 12_397_129_000_000_000n,
      },
    );

    expect(accounting).toEqual({
      inputToken: 'EURC',
      outputToken: 'USDC',
      amountSold: '10',
      minimumReceived: '12.083465',
      providerFee: '0.002',
      amountReceived: '12.144186',
      gasPaid: '0.012397129',
      completedAt: 1_800_000_000_000,
      usdcBalanceBefore: null,
      usdcBalanceAfter: null,
      netUsdcBalanceChange: '12.144186',
    });
    expect(formatUnits(240_702_397n - 228_570_608n, 6)).toBe('12.131789');
    expect(accounting.netUsdcBalanceChange).not.toBe('12.131789');
    expect(parseUnits(accounting.amountReceived, 6) - 12_131_789n).toBe(12_397n);
    expect(12_397_129_000_000_000n / 10n ** 12n).toBe(12_397n);
  });

  it('shows output as unavailable when receipt logs cannot prove the wallet received the minimum', () => {
    const receipt = createReceipt([
      transferLog(ARC_EURC.address, wallet, ARC_SWAP_ADAPTER, 1_000_000n),
      transferLog(ARC_EURC.address, ARC_SWAP_ADAPTER, feeRecipient, 200n),
      transferLog(ARC_EURC.address, ARC_SWAP_ADAPTER, ARC_FLY_ROUTER, 999_800n),
      transferLog(ARC_USDC.address, ARC_SWAP_ADAPTER, wallet, 1_208_353n),
    ]);

    expect(() => accountArcSwapReceipt(createTransaction(), receipt, wallet))
      .toThrow('do not prove an output to the wallet');
  });

  it('leaves the provider fee unverified when matching fee transfers are ambiguous', () => {
    const transfer = transferLog(ARC_EURC.address, ARC_SWAP_ADAPTER, feeRecipient, 200n);
    const receipt = createReceipt([
      transferLog(ARC_EURC.address, wallet, ARC_SWAP_ADAPTER, 1_000_000n),
      transfer,
      { ...transfer, topics: [...transfer.topics] },
      transferLog(ARC_EURC.address, ARC_SWAP_ADAPTER, ARC_FLY_ROUTER, 999_800n),
      transferLog(ARC_USDC.address, ARC_SWAP_ADAPTER, wallet, 1_210_000n),
    ]);

    expect(accountArcSwapReceipt(createTransaction(), receipt, wallet).providerFee).toBeNull();
  });

  it('rejects a receipt that does not match the successful Swap transaction', () => {
    expect(() => accountArcSwapReceipt(
      createTransaction(),
      { ...createReceipt([]), transactionHash: `0x${'a'.repeat(64)}` as Hash },
      wallet,
    )).toThrow('mismatched or not successful');
  });

  it('accounts for the confirmed EIP-7702 LI.FI/Fly USDC to EURC receipt', () => {
    const transaction = wrapInSmartAccountBatch(
      createTransaction(1_000_000n, 200n, 1_842_265n, 'USDC'),
      1_000_000n,
      'USDC',
      'increaseAllowance',
    );
    transaction.gasPrice = 25_000_000_000n;
    const receipt = {
      ...createReceipt([
        transferLog(ARC_USDC.address, wallet, ARC_SWAP_ADAPTER, 1_000_000n),
        transferLog(ARC_USDC.address, ARC_SWAP_ADAPTER, splitFeeRecipient, 20n),
        transferLog(ARC_USDC.address, ARC_SWAP_ADAPTER, ARC_SWAP_FEE_COLLECTOR, 180n),
        transferLog(ARC_USDC.address, ARC_SWAP_ADAPTER, ARC_FLY_ROUTER, 999_800n),
        transferLog(ARC_EURC.address, ARC_FLY_ROUTER, router, 1_851_523n),
        transferLog(ARC_EURC.address, ARC_SWAP_ADAPTER, wallet, 1_851_523n),
        transferLog(ARC_USDC.address, router, feeRecipient, 5_000n),
      ]),
      gasUsed: 538_405n,
      effectiveGasPrice: undefined,
    };

    const accounting = accountArcSwapReceipt(transaction, receipt, wallet);

    expect(accounting).toMatchObject({
      inputToken: 'USDC',
      outputToken: 'EURC',
      amountSold: '1',
      minimumReceived: '1.842265',
      providerFee: '0.0002',
      amountReceived: '1.851523',
      gasPaid: '0.013460125',
    });
  });

  it('accounts for the confirmed EIP-7702 LI.FI/Fly EURC to USDC receipt', () => {
    const transaction = wrapInSmartAccountBatch(
      createTransaction(2_000_000n, 400n, 2_416_289n, 'EURC'),
      2_000_000n,
      'EURC',
      'approve',
    );
    const receipt = {
      ...createReceipt([
        transferLog(ARC_EURC.address, wallet, ARC_SWAP_ADAPTER, 2_000_000n),
        transferLog(ARC_EURC.address, ARC_SWAP_ADAPTER, feeRecipient, 400n),
        transferLog(ARC_EURC.address, ARC_SWAP_ADAPTER, ARC_FLY_ROUTER, 1_999_600n),
        transferLog(ARC_USDC.address, ARC_SWAP_ADAPTER, wallet, 2_428_431n),
      ]),
      gasUsed: 571_156n,
      effectiveGasPrice: 25_000_000_000n,
    };

    const accounting = accountArcSwapReceipt(transaction, receipt, wallet);

    expect(accounting).toMatchObject({
      inputToken: 'EURC',
      outputToken: 'USDC',
      amountSold: '2',
      minimumReceived: '2.416289',
      providerFee: '0.0004',
      amountReceived: '2.428431',
      gasPaid: '0.0142789',
    });
  });

  it('sums multiple wallet receipt transfers for actual output', () => {
    const transaction = wrapInSmartAccountBatch(
      createTransaction(1_000_000n, 200n, 1_842_265n, 'USDC'),
      1_000_000n,
      'USDC',
      'increaseAllowance',
    );
    const accounting = accountArcSwapReceipt(transaction, createReceipt([
      transferLog(ARC_USDC.address, wallet, ARC_SWAP_ADAPTER, 1_000_000n),
      transferLog(ARC_USDC.address, ARC_SWAP_ADAPTER, splitFeeRecipient, 20n),
      transferLog(ARC_USDC.address, ARC_SWAP_ADAPTER, feeRecipient, 180n),
      transferLog(ARC_USDC.address, ARC_SWAP_ADAPTER, ARC_FLY_ROUTER, 999_800n),
      transferLog(ARC_EURC.address, ARC_SWAP_ADAPTER, wallet, 1_000_000n),
      transferLog(ARC_EURC.address, ARC_SWAP_ADAPTER, wallet, 851_523n),
    ]), wallet);

    expect(accounting.amountReceived).toBe('1.851523');
    expect(accounting.providerFee).toBe('0.0002');
  });

  it('does not account for missing swap transfers or unrelated token transfers', () => {
    const transaction = wrapInSmartAccountBatch(
      createTransaction(1_000_000n, 200n, 1_842_265n, 'USDC'),
      1_000_000n,
      'USDC',
      'increaseAllowance',
    );
    const unrelated = transferLog(ARC_EURC.address, router, feeRecipient, 1_851_523n);
    const unrelatedToken = transferLog('0x4444444444444444444444444444444444444444' as Address, router, wallet, 1n);

    expect(() => accountArcSwapReceipt(transaction, createReceipt([
      unrelated,
      unrelatedToken,
    ]), wallet)).toThrow('wallet transfer logs do not match');
  });

  it('rejects a failed receipt even when matching transfer logs are present', () => {
    const transaction = wrapInSmartAccountBatch(
      createTransaction(1_000_000n, 200n, 1_842_265n, 'USDC'),
      1_000_000n,
      'USDC',
      'increaseAllowance',
    );
    const receipt = createReceipt([
      transferLog(ARC_USDC.address, wallet, ARC_SWAP_ADAPTER, 1_000_000n),
      transferLog(ARC_USDC.address, ARC_SWAP_ADAPTER, ARC_FLY_ROUTER, 999_800n),
      transferLog(ARC_EURC.address, ARC_SWAP_ADAPTER, wallet, 1_851_523n),
    ]);

    expect(() => accountArcSwapReceipt(transaction, { ...receipt, status: 'reverted' }, wallet))
      .toThrow('mismatched or not successful');
  });
});

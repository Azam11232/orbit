import {
  decodeAbiParameters,
  decodeFunctionData,
  formatUnits,
  keccak256,
  parseAbi,
  parseAbiParameters,
  toBytes,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { ARC_EURC, ARC_USDC } from '../../data/tokens';

export const ARC_SWAP_ADAPTER = '0xBBD70b01a1CAbc96d5b7b129Ae1AAabdf50dd40b' as Address;
export const ARC_SWAP_FEE_COLLECTOR = '0xf992EFCB5FA2eD7cB48310D9dd8Cb4ce5FB7DdC9' as Address;
export const ARC_FLY_ROUTER = '0xFf70F4A1d11995621854F3692acF286d8aCd04b2' as Address;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const TRANSFER_TOPIC = keccak256(toBytes('Transfer(address,address,uint256)'));
const SMART_ACCOUNT_EXECUTE_ABI = parseAbi([
  'function execute(bytes32 mode,bytes executionCalldata)',
]);
const ERC20_APPROVAL_ABI = parseAbi([
  'function approve(address spender,uint256 amount)',
  'function increaseAllowance(address spender,uint256 addedValue)',
]);
const BATCH_EXECUTION_MODE = `0x0100000000000000000000000000000000000000000000000000000000000000` as Hex;
const BATCH_CALLS_ABI = parseAbiParameters('(address target,uint256 value,bytes callData)[]');
const ADAPTER_ABI = [{
  type: 'function',
  name: 'execute',
  stateMutability: 'nonpayable',
  inputs: [
    {
      name: 'params',
      type: 'tuple',
      components: [
        {
          name: 'instructions',
          type: 'tuple[]',
          components: [
            { name: 'target', type: 'address' },
            { name: 'data', type: 'bytes' },
            { name: 'value', type: 'uint256' },
            { name: 'tokenIn', type: 'address' },
            { name: 'amountToApprove', type: 'uint256' },
            { name: 'tokenOut', type: 'address' },
            { name: 'minTokenOut', type: 'uint256' },
          ],
        },
        {
          name: 'tokens',
          type: 'tuple[]',
          components: [
            { name: 'token', type: 'address' },
            { name: 'beneficiary', type: 'address' },
          ],
        },
        { name: 'execId', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'metadata', type: 'bytes' },
      ],
    },
    {
      name: 'tokenInputs',
      type: 'tuple[]',
      components: [
        { name: 'permitType', type: 'uint8' },
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'permitCalldata', type: 'bytes' },
      ],
    },
    { name: 'signature', type: 'bytes' },
  ],
  outputs: [],
}] as const;

export interface ArcSwapReceiptTransaction {
  hash: Hash;
  from: Address;
  to: Address | null;
  input: Hex;
  gasPrice?: bigint;
}

export interface ArcSwapReceiptLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
}

export interface ArcSwapReceipt {
  transactionHash: Hash;
  status: 'success' | 'reverted';
  blockTimestamp?: bigint;
  gasUsed: bigint;
  effectiveGasPrice?: bigint;
  logs: readonly ArcSwapReceiptLog[];
}

export interface ArcSwapReceiptAccounting {
  inputToken: 'USDC' | 'EURC';
  outputToken: 'USDC' | 'EURC';
  amountSold: string;
  minimumReceived: string;
  providerFee: string | null;
  amountReceived: string;
  gasPaid: string | null;
  completedAt: number | null;
  usdcBalanceBefore: string | null;
  usdcBalanceAfter: string | null;
  netUsdcBalanceChange: string | null;
}

export interface ArcSwapReceiptAccountingOptions {
  gasPaid?: bigint | null;
}

interface TransferEvent {
  from: Address;
  to: Address;
  amount: bigint;
}

function unavailable(message: string): never {
  throw new Error(`Actual Arc Swap receipt accounting is unavailable: ${message}`);
}

function sameAddress(left: string | null | undefined, right: string): boolean {
  return Boolean(left && left.toLowerCase() === right.toLowerCase());
}

function decodeTransfer(log: ArcSwapReceiptLog): TransferEvent | null {
  if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC.toLowerCase()) return null;
  if (
    log.topics.length !== 3 ||
    !/^0x[0-9a-f]{64}$/i.test(log.topics[1] ?? '') ||
    !/^0x[0-9a-f]{64}$/i.test(log.topics[2] ?? '') ||
    !/^0x[0-9a-f]{64}$/i.test(log.data)
  ) {
    return unavailable(`The ${log.address} Transfer log is malformed.`);
  }
  return {
    from: `0x${log.topics[1]!.slice(-40)}` as Address,
    to: `0x${log.topics[2]!.slice(-40)}` as Address,
    amount: BigInt(log.data),
  };
}

function getVerifiedAdapterCall(
  transaction: ArcSwapReceiptTransaction,
  walletAddress: Address,
): { transaction: ArcSwapReceiptTransaction; approvalCall?: { target: Address; value: bigint; callData: Hex } } {
  if (sameAddress(transaction.to, ARC_SWAP_ADAPTER)) {
    return { transaction };
  }
  if (
    !sameAddress(transaction.to, walletAddress) ||
    !sameAddress(transaction.from, walletAddress) ||
    !/^0x[0-9a-f]{8}/i.test(transaction.input)
  ) {
    return unavailable('The confirmed transaction is not a verified Arc Swap execution.');
  }

  let accountExecution: ReturnType<typeof decodeFunctionData<typeof SMART_ACCOUNT_EXECUTE_ABI>>;
  try {
    accountExecution = decodeFunctionData({
      abi: SMART_ACCOUNT_EXECUTE_ABI,
      data: transaction.input,
    });
  } catch {
    return unavailable('The confirmed wallet transaction could not be decoded as an Arc Swap execution.');
  }
  if (
    accountExecution.functionName !== 'execute' ||
    accountExecution.args[0].toLowerCase() !== BATCH_EXECUTION_MODE.toLowerCase()
  ) {
    return unavailable('The confirmed wallet transaction does not use the verified Arc Swap batch execution mode.');
  }

  let calls: readonly { target: Address; value: bigint; callData: Hex }[];
  try {
    [calls] = decodeAbiParameters(BATCH_CALLS_ABI, accountExecution.args[1]);
  } catch {
    return unavailable('The confirmed wallet batch does not contain decodable Arc Swap calls.');
  }
  const adapterCalls = calls.filter((call) => sameAddress(call.target, ARC_SWAP_ADAPTER));
  const otherCalls = calls.filter((call) => !sameAddress(call.target, ARC_SWAP_ADAPTER));
  if (adapterCalls.length !== 1 || adapterCalls[0]?.value !== 0n || otherCalls.length > 1) {
    return unavailable('The confirmed wallet batch does not contain exactly one verified Adapter execution.');
  }
  return {
    transaction: {
      ...transaction,
      to: ARC_SWAP_ADAPTER,
      input: adapterCalls[0]!.callData,
    },
    approvalCall: otherCalls[0],
  };
}

function getVerifiedInstructions(transaction: ArcSwapReceiptTransaction, walletAddress: Address) {
  const { transaction: adapterTransaction, approvalCall } = getVerifiedAdapterCall(transaction, walletAddress);
  if (!/^0x[0-9a-f]{8}/i.test(adapterTransaction.input)) {
    return unavailable('The confirmed Adapter transaction has no executable calldata.');
  }

  const decoded = (() => {
    try {
      return decodeFunctionData({
        abi: ADAPTER_ABI,
        data: adapterTransaction.input,
      });
    } catch {
      return unavailable('The confirmed Adapter transaction could not be decoded as a Swap execution.');
    }
  })();
  const params = decoded.args[0];
  const tokenInputs = decoded.args[1];
  const feeInstruction = params.instructions[0];
  const swapInstruction = params.instructions[1];
  const inputAsset = sameAddress(swapInstruction?.tokenIn, ARC_USDC.address) ? ARC_USDC : ARC_EURC;
  const outputAsset = sameAddress(swapInstruction?.tokenOut, ARC_USDC.address) ? ARC_USDC : ARC_EURC;
  const inputAmount = (feeInstruction?.amountToApprove ?? 0n) + (swapInstruction?.amountToApprove ?? 0n);
  if (
    !sameAddress(transaction.from, walletAddress) ||
    params.instructions.length !== 2 ||
    params.tokens.length !== 2 ||
    tokenInputs.length !== 1 ||
    !feeInstruction ||
    !swapInstruction ||
    !(
      (sameAddress(inputAsset.address, ARC_USDC.address) && sameAddress(outputAsset.address, ARC_EURC.address)) ||
      (sameAddress(inputAsset.address, ARC_EURC.address) && sameAddress(outputAsset.address, ARC_USDC.address))
    ) ||
    !sameAddress(params.tokens[0]?.token, inputAsset.address) ||
    !sameAddress(params.tokens[0]?.beneficiary, walletAddress) ||
    !sameAddress(params.tokens[1]?.token, outputAsset.address) ||
    !sameAddress(params.tokens[1]?.beneficiary, walletAddress) ||
    !sameAddress(feeInstruction.target, ARC_SWAP_FEE_COLLECTOR) ||
    feeInstruction.data.slice(0, 10).toLowerCase() !== '0x7ebc46f0' ||
    !sameAddress(feeInstruction.tokenIn, inputAsset.address) ||
    !sameAddress(feeInstruction.tokenOut, ZERO_ADDRESS) ||
    feeInstruction.value !== 0n ||
    !sameAddress(swapInstruction.target, ARC_FLY_ROUTER) ||
    swapInstruction.data.slice(0, 10).toLowerCase() !== '0x4666fc80' ||
    !sameAddress(swapInstruction.tokenIn, inputAsset.address) ||
    !sameAddress(swapInstruction.tokenOut, outputAsset.address) ||
    swapInstruction.value !== 0n ||
    feeInstruction.amountToApprove <= 0n ||
    swapInstruction.amountToApprove <= 0n ||
    swapInstruction.minTokenOut <= 0n ||
    tokenInputs[0]?.permitType !== 0 ||
    !sameAddress(tokenInputs[0]?.token, inputAsset.address) ||
    tokenInputs[0]?.amount !== inputAmount ||
    inputAmount <= 0n
  ) {
    return unavailable('The confirmed transaction does not contain a verified Arc USDC/EURC Adapter route.');
  }
  if (approvalCall) {
    let approval: ReturnType<typeof decodeFunctionData<typeof ERC20_APPROVAL_ABI>>;
    try {
      approval = decodeFunctionData({
        abi: ERC20_APPROVAL_ABI,
        data: approvalCall.callData,
      });
    } catch {
      return unavailable('The confirmed wallet batch contains an unrecognized token approval.');
    }
    if (
      approvalCall.value !== 0n ||
      !sameAddress(approvalCall.target, inputAsset.address) ||
      approval.functionName !== 'approve' && approval.functionName !== 'increaseAllowance' ||
      !sameAddress(approval.args[0], ARC_SWAP_ADAPTER) ||
      approval.args[1] !== inputAmount
    ) {
      return unavailable('The confirmed wallet batch contains an approval that does not match the verified swap input.');
    }
  }
  return { feeInstruction, swapInstruction, inputAsset, outputAsset, inputAmount };
}

export function accountArcSwapReceipt(
  transaction: ArcSwapReceiptTransaction,
  receipt: ArcSwapReceipt,
  walletAddress: Address,
  options: ArcSwapReceiptAccountingOptions = {},
): ArcSwapReceiptAccounting {
  if (
    transaction.hash.toLowerCase() !== receipt.transactionHash.toLowerCase() ||
    receipt.status !== 'success'
  ) {
    return unavailable('The transaction receipt is mismatched or not successful.');
  }
  const { feeInstruction, swapInstruction, inputAsset, outputAsset, inputAmount } = getVerifiedInstructions(transaction, walletAddress);
  const transfers: Array<{ token: Address; event: TransferEvent }> = [];
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() !== ARC_EURC.address.toLowerCase() &&
      log.address.toLowerCase() !== ARC_USDC.address.toLowerCase()
    ) continue;
    const event = decodeTransfer(log);
    if (event) transfers.push({ token: log.address, event });
  }

  const outgoingInput = transfers
    .filter(({ token, event }) =>
      sameAddress(token, inputAsset.address) &&
      sameAddress(event.from, walletAddress) &&
      sameAddress(event.to, ARC_SWAP_ADAPTER),
    )
    .reduce((sum, { event }) => sum + event.amount, 0n);
  if (outgoingInput <= 0n || outgoingInput !== inputAmount) {
    return unavailable(`${inputAsset.symbol} wallet transfer logs do not match the confirmed Adapter input amounts.`);
  }

  const routerInput = transfers
    .filter(({ token, event }) =>
      sameAddress(token, inputAsset.address) &&
      sameAddress(event.from, ARC_SWAP_ADAPTER) &&
      sameAddress(event.to, ARC_FLY_ROUTER),
    )
    .reduce((sum, { event }) => sum + event.amount, 0n);
  if (routerInput !== swapInstruction.amountToApprove) {
    return unavailable(`${inputAsset.symbol} transfer logs do not verify the LI.FI/Fly route input.`);
  }

  const outputTransfers = transfers.filter(({ token, event }) =>
    sameAddress(token, outputAsset.address) &&
    sameAddress(event.from, ARC_SWAP_ADAPTER) &&
    sameAddress(event.to, walletAddress),
  );
  const amountReceived = outputTransfers.reduce((sum, { event }) => sum + event.amount, 0n);
  if (outputTransfers.length === 0 || amountReceived < swapInstruction.minTokenOut) {
    return unavailable(`${outputAsset.symbol} transfer logs do not prove an output to the wallet at or above the transaction minimum.`);
  }

  const providerFeeTransfers = transfers.filter(({ token, event }) =>
    sameAddress(token, inputAsset.address) &&
    sameAddress(event.from, ARC_SWAP_ADAPTER) &&
    !sameAddress(event.to, ARC_SWAP_ADAPTER) &&
    !sameAddress(event.to, ARC_FLY_ROUTER),
  );
  const providerFeeAmount = providerFeeTransfers.reduce((sum, { event }) => sum + event.amount, 0n);
  const providerFee = providerFeeTransfers.length > 0 && providerFeeAmount === feeInstruction.amountToApprove
    ? formatUnits(providerFeeAmount, inputAsset.decimals)
    : null;

  const gasPrice = receipt.effectiveGasPrice ?? transaction.gasPrice;
  const gasPaidRaw = options.gasPaid ?? (gasPrice === undefined ? null : receipt.gasUsed * gasPrice);
  const usdcTransferNetChange = transfers
    .filter(({ token }) => sameAddress(token, ARC_USDC.address))
    .reduce((change, { event }) => {
      if (sameAddress(event.to, walletAddress)) return change + event.amount;
      if (sameAddress(event.from, walletAddress)) return change - event.amount;
      return change;
    }, 0n);
  return {
    inputToken: inputAsset.address.toLowerCase() === ARC_USDC.address.toLowerCase() ? 'USDC' : 'EURC',
    outputToken: outputAsset.address.toLowerCase() === ARC_USDC.address.toLowerCase() ? 'USDC' : 'EURC',
    amountSold: formatUnits(outgoingInput, inputAsset.decimals),
    minimumReceived: formatUnits(swapInstruction.minTokenOut, outputAsset.decimals),
    providerFee,
    amountReceived: formatUnits(amountReceived, outputAsset.decimals),
    gasPaid: gasPaidRaw === null ? null : formatUnits(gasPaidRaw, 18),
    completedAt: receipt.blockTimestamp === undefined ? null : Number(receipt.blockTimestamp) * 1000,
    usdcBalanceBefore: null,
    usdcBalanceAfter: null,
    netUsdcBalanceChange: formatUnits(usdcTransferNetChange, ARC_USDC.decimals),
  };
}

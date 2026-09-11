import { formatUnits, parseAbi, type Address, type PublicClient } from 'viem';
import { base } from 'wagmi/chains';
import type { LendingAssetConfig, LendingAssetPosition, LendingPosition, LendingOperation } from '../../types/lending';

export const AAVE_BASE_POOL = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' as Address;

export const AAVE_BASE_ASSETS: LendingAssetConfig[] = [
  { symbol: 'USDC', name: 'USD Coin', underlying: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, color: '#2775CA' },
  { symbol: 'WETH', name: 'Wrapped Ether', underlying: '0x4200000000000000000000000000000000000006', decimals: 18, color: '#627EEA' },
];

const poolAbi = parseAbi([
  'function getReserveData(address asset) view returns (uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt)',
  'function ADDRESSES_PROVIDER() view returns (address)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)',
]);
const providerAbi = parseAbi(['function getPriceOracle() view returns (address)']);
const oracleAbi = parseAbi(['function getAssetPrice(address asset) view returns (uint256)']);
const erc20Abi = parseAbi(['function balanceOf(address account) view returns (uint256)', 'function allowance(address owner, address spender) view returns (uint256)']);
const RAY = 1e27;

function percentFromRay(value: bigint): number { return Number(value) / RAY * 100; }

export function createAaveProvider(client: PublicClient) {
  return {
    async getPosition(address: Address): Promise<LendingPosition> {
      const [account, addressesProvider, usdcReserve, wethReserve] = await client.multicall({
        allowFailure: false,
        contracts: [
          { address: AAVE_BASE_POOL, abi: poolAbi, functionName: 'getUserAccountData', args: [address] },
          { address: AAVE_BASE_POOL, abi: poolAbi, functionName: 'ADDRESSES_PROVIDER' },
          { address: AAVE_BASE_POOL, abi: poolAbi, functionName: 'getReserveData', args: [AAVE_BASE_ASSETS[0].underlying] },
          { address: AAVE_BASE_POOL, abi: poolAbi, functionName: 'getReserveData', args: [AAVE_BASE_ASSETS[1].underlying] },
        ],
      });
      const oracle = await client.readContract({ address: addressesProvider, abi: providerAbi, functionName: 'getPriceOracle' });
      const reserves = [usdcReserve, wethReserve];
      const assets = await Promise.all(AAVE_BASE_ASSETS.map(async (asset, index): Promise<LendingAssetPosition> => {
        const reserve = reserves[index];
        const [supplied, borrowed, liquidity, priceBase] = await client.multicall({
          allowFailure: false,
          contracts: [
            { address: reserve[8], abi: erc20Abi, functionName: 'balanceOf', args: [address] },
            { address: reserve[10], abi: erc20Abi, functionName: 'balanceOf', args: [address] },
            { address: asset.underlying, abi: erc20Abi, functionName: 'balanceOf', args: [AAVE_BASE_POOL] },
            { address: oracle, abi: oracleAbi, functionName: 'getAssetPrice', args: [asset.underlying] },
          ],
        }) as [bigint, bigint, bigint, bigint];
        return { ...asset, supplied, borrowed, supplyApy: percentFromRay(reserve[2]), borrowApr: percentFromRay(reserve[4]), liquidity, priceBase, aToken: reserve[8], variableDebtToken: reserve[10] };
      }));
      return { assets, totalCollateralBase: account[0], totalDebtBase: account[1], availableBorrowsBase: account[2], currentLiquidationThreshold: account[3], ltv: account[4], healthFactor: account[5], protocol: 'Aave V3' };
    },
    async getAllowance(asset: LendingAssetConfig, owner: Address) {
      return client.readContract({ address: asset.underlying, abi: erc20Abi, functionName: 'allowance', args: [owner, AAVE_BASE_POOL] });
    },
    encode(operation: LendingOperation, asset: LendingAssetConfig, amount: bigint, user: Address) {
      if (operation === 'supply') return { address: AAVE_BASE_POOL, abi: poolAbi, functionName: 'supply', args: [asset.underlying, amount, user, 0] } as const;
      if (operation === 'withdraw') return { address: AAVE_BASE_POOL, abi: poolAbi, functionName: 'withdraw', args: [asset.underlying, amount, user] } as const;
      if (operation === 'borrow') return { address: AAVE_BASE_POOL, abi: poolAbi, functionName: 'borrow', args: [asset.underlying, amount, 2n, 0, user] } as const;
      return { address: AAVE_BASE_POOL, abi: poolAbi, functionName: 'repay', args: [asset.underlying, amount, 2n, user] } as const;
    },
    format(amount: bigint, asset: LendingAssetConfig) { return formatUnits(amount, asset.decimals); },
    chainId: base.id,
  };
}

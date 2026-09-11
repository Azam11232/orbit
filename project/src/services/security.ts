import {
  erc20Abi,
  formatUnits,
  maxUint256,
  parseAbiItem,
  type Address,
  type PublicClient,
} from 'viem';
import { base } from 'wagmi/chains';
import { BASE_ERC20_ASSETS } from '../data/tokens';
import type { ChainTransaction } from './transactions';

export type ApprovalRisk = 'High' | 'Medium' | 'Low' | 'Unknown';

export interface ApprovalTokenConfig {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
  color: string;
}

export interface TokenApproval {
  id: string;
  token: ApprovalTokenConfig;
  spenderAddress: Address;
  allowance: bigint;
  allowanceFormatted: string;
  isUnlimited: boolean;
  risk: ApprovalRisk;
  status: string;
  lastSeenBlock: bigint;
}

export interface ApprovalScanResult {
  approvals: TokenApproval[];
  scannedFromBlock: bigint;
  scannedToBlock: bigint;
  scope: string;
}

export interface SecurityFactor {
  label: string;
  detail: string;
  severity: 'neutral' | 'warning' | 'critical';
  impact: number;
}

export interface ContractSafetyStatus {
  symbol: string;
  address: string;
  status: 'Verified in ORBIT' | 'Unknown / not verified by ORBIT';
}

export interface WalletSecurityReport {
  score: number;
  severity: 'Low' | 'Medium' | 'High';
  factors: SecurityFactor[];
  recommendations: string[];
  summary: string;
  unknownContractInteractions: number;
  failedTransactions: number;
  largeOutgoingTransfers: number;
  approvalAlerts: TokenApproval[];
  trackedContractStatus: ContractSafetyStatus[];
}

export const APPROVAL_TOKENS: ApprovalTokenConfig[] = [
  {
    symbol: 'WETH',
    name: 'Wrapped Ether',
    address: '0x4200000000000000000000000000000000000006',
    decimals: 18,
    color: '#627EEA',
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    address: '0x833589fCD6EDB6E08f4c7C32D4f71b54bDA02913',
    decimals: 6,
    color: '#2775CA',
  },
  {
    symbol: 'cbBTC',
    name: 'Coinbase Wrapped BTC',
    address: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf',
    decimals: 8,
    color: '#F7931A',
  },
];

const approvalEvent = parseAbiItem(
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
);
const SCAN_BLOCK_WINDOW = 1_000_000n;

function classifyAllowance(allowance: bigint, decimals: number): ApprovalRisk {
  if (allowance === maxUint256) return 'High';
  if (allowance > 1_000_000n * 10n ** BigInt(decimals)) return 'Medium';
  if (allowance > 0n) return 'Low';
  return 'Unknown';
}

function approvalStatus(risk: ApprovalRisk, isUnlimited: boolean): string {
  if (isUnlimited) return 'Unlimited allowance active';
  if (risk === 'Medium') return 'Large allowance active';
  if (risk === 'Low') return 'Limited allowance active';
  return 'Insufficient information';
}

export interface ApprovalProvider {
  scan(address: Address): Promise<ApprovalScanResult>;
}

export function createApprovalProvider(client: PublicClient): ApprovalProvider {
  return {
    async scan(address) {
      const latestBlock = await client.getBlockNumber();
      const fromBlock = latestBlock > SCAN_BLOCK_WINDOW ? latestBlock - SCAN_BLOCK_WINDOW : 0n;
      const approvals: TokenApproval[] = [];

      for (const token of APPROVAL_TOKENS) {
        const logs = await client.getLogs({
          address: token.address,
          event: approvalEvent,
          args: { owner: address },
          fromBlock,
          toBlock: latestBlock,
        });
        const candidates = new Map<string, bigint>();
        for (const log of logs) {
          if (log.args.spender) {
            const current = candidates.get(log.args.spender.toLowerCase());
            if (!current || log.blockNumber > current) {
              candidates.set(log.args.spender.toLowerCase(), log.blockNumber);
            }
          }
        }

        for (const [spenderKey, lastSeenBlock] of candidates) {
          const spenderAddress = spenderKey as Address;
          const allowance = await client.readContract({
            address: token.address,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [address, spenderAddress],
          });
          if (allowance === 0n) continue;
          const isUnlimited = allowance === maxUint256;
          const risk = classifyAllowance(allowance, token.decimals);
          approvals.push({
            id: `${token.address}:${spenderKey}`,
            token,
            spenderAddress,
            allowance,
            allowanceFormatted: formatUnits(allowance, token.decimals),
            isUnlimited,
            risk,
            status: approvalStatus(risk, isUnlimited),
            lastSeenBlock,
          });
        }
      }

      return {
        approvals: approvals.sort((left, right) => {
          const riskOrder = { High: 0, Medium: 1, Low: 2, Unknown: 3 };
          return riskOrder[left.risk] - riskOrder[right.risk];
        }),
        scannedFromBlock: fromBlock,
        scannedToBlock: latestBlock,
        scope: 'Configured Base tokens, recent Approval events',
      };
    },
  };
}

export function calculateSecurityScore(approvals: TokenApproval[]): number {
  const unlimitedCount = approvals.filter((approval) => approval.isUnlimited).length;
  const highRiskCount = approvals.filter((approval) => approval.risk === 'High').length;
  const mediumRiskCount = approvals.filter((approval) => approval.risk === 'Medium').length;
  return Math.max(0, 100 - unlimitedCount * 15 - highRiskCount * 10 - mediumRiskCount * 5);
}

export function buildWalletSecurityReport({
  approvals,
  transactions,
  portfolio,
  isConnected,
  chainId,
  walletAddress,
}: {
  approvals: TokenApproval[];
  transactions: ChainTransaction[];
  portfolio: {
    totalValueUsd: number;
    assets: Array<{ symbol: string; isNative: boolean; valueUsd: number | null; priceUsd: number | null }>;
  };
  isConnected: boolean;
  chainId?: number;
  walletAddress?: Address;
}): WalletSecurityReport {
  const factors: SecurityFactor[] = [];
  let score = 100;
  const approvalAlerts = approvals.filter(
    (approval) => approval.isUnlimited || approval.risk === 'High' || approval.risk === 'Medium',
  );

  if (!isConnected || !walletAddress) {
    return {
      score: 0,
      severity: 'High',
      factors: [{
        label: 'Wallet disconnected',
        detail: 'Connect a Base wallet to run a live security analysis.',
        severity: 'warning',
        impact: 100,
      }],
      recommendations: ['Connect a wallet to start analyzing wallet security.'],
      summary: 'No connected wallet is available for live security checks.',
      unknownContractInteractions: 0,
      failedTransactions: 0,
      largeOutgoingTransfers: 0,
      approvalAlerts,
      trackedContractStatus: portfolio.assets
        .filter((asset) => !asset.isNative)
        .map((asset) => {
          const match = BASE_ERC20_ASSETS.find((token) => token.symbol === asset.symbol);
          return {
            symbol: asset.symbol,
            address: match?.address ?? 'Unknown / not verified by ORBIT',
            status: match ? 'Verified in ORBIT' : 'Unknown / not verified by ORBIT',
          };
        }),
    };
  }

  if (chainId !== base.id) {
    score = Math.max(0, score - 25);
    factors.push({
      label: 'Wrong network',
      detail: 'The wallet is not currently on Base Mainnet.',
      severity: 'warning',
      impact: 25,
    });
  }

  const unrestrictedApprovals = approvals.filter((approval) => approval.isUnlimited);
  if (unrestrictedApprovals.length > 0) {
    const impact = Math.min(45, unrestrictedApprovals.length * 15);
    score = Math.max(0, score - impact);
    factors.push({
      label: 'Unlimited approvals',
      detail: `${unrestrictedApprovals.length} approval${unrestrictedApprovals.length > 1 ? 's are' : ' is'} unlimited or effectively unrestricted.`,
      severity: 'critical',
      impact,
    });
  }

  const highRiskApprovals = approvals.filter((approval) => approval.risk === 'High');
  if (highRiskApprovals.length > 0) {
    const impact = Math.min(30, highRiskApprovals.length * 10);
    score = Math.max(0, score - impact);
    factors.push({
      label: 'High-risk approvals',
      detail: `${highRiskApprovals.length} approval${highRiskApprovals.length > 1 ? 's' : ''} have a high allowance risk.`,
      severity: 'critical',
      impact,
    });
  }

  const mediumRiskApprovals = approvals.filter((approval) => approval.risk === 'Medium');
  if (mediumRiskApprovals.length > 0) {
    const impact = Math.min(20, mediumRiskApprovals.length * 5);
    score = Math.max(0, score - impact);
    factors.push({
      label: 'Medium-risk approvals',
      detail: `${mediumRiskApprovals.length} approval${mediumRiskApprovals.length > 1 ? 's are' : ' is'} large enough to review.`,
      severity: 'warning',
      impact,
    });
  }

  const failedTransactions = transactions.filter((tx) => tx.status === 'failed').length;
  if (failedTransactions > 0) {
    const impact = Math.min(15, failedTransactions * 5);
    score = Math.max(0, score - impact);
    factors.push({
      label: 'Failed transactions',
      detail: `${failedTransactions} recent transaction${failedTransactions > 1 ? 's failed' : ' failed'} on Base.`,
      severity: 'warning',
      impact,
    });
  }

  const knownContractAddresses = new Set(
    BASE_ERC20_ASSETS.map((asset) => asset.address?.toLowerCase()).filter(Boolean) as string[],
  );

  const walletAddressLower = walletAddress.toLowerCase();
  const unknownContractSet = new Set<string>();
  for (const tx of transactions) {
    const target = tx.to.toLowerCase();
    const interaction = tx.category === 'Contract Interaction' || tx.category === 'Approval' || tx.category === 'Swap' || tx.category === 'Bridge' || tx.category === 'Lending';
    const isSelf = target === walletAddressLower;
    const isKnown = knownContractAddresses.has(target);
    if (interaction && !isSelf && !isKnown && target !== '0x') {
      unknownContractSet.add(tx.to);
    }
  }

  const unknownContractInteractions = unknownContractSet.size;
  if (unknownContractInteractions > 0) {
    const impact = Math.min(25, unknownContractInteractions * 7);
    score = Math.max(0, score - impact);
    factors.push({
      label: 'Unknown contract interactions',
      detail: `${unknownContractInteractions} recent interaction${unknownContractInteractions > 1 ? 's' : ''} were with addresses not recognized by ORBIT.`,
      severity: 'warning',
      impact,
    });
  }

  const ethPrice = portfolio.assets.find((asset) => asset.symbol === 'ETH')?.priceUsd ?? null;
  const largeOutgoingTransfers =
    ethPrice !== null && portfolio.totalValueUsd > 0
      ? transactions.filter((tx) => {
          const isOutgoing = tx.from.toLowerCase() === walletAddressLower;
          const value = Number(tx.value || '0');
          if (!isOutgoing || !Number.isFinite(value) || value <= 0) return false;
          return value * ethPrice > portfolio.totalValueUsd * 0.3;
        }).length
      : 0;

  if (largeOutgoingTransfers > 0) {
    const impact = Math.min(20, largeOutgoingTransfers * 10);
    score = Math.max(0, score - impact);
    factors.push({
      label: 'Large outgoing transfers',
      detail: `${largeOutgoingTransfers} outgoing transfer${largeOutgoingTransfers > 1 ? 's were' : ' was'} large relative to the current portfolio value.`,
      severity: 'warning',
      impact,
    });
  }

  const trackedContractStatus = portfolio.assets
    .filter((asset) => !asset.isNative)
    .map((asset) => {
      const match = BASE_ERC20_ASSETS.find((token) => token.symbol === asset.symbol);
      return {
        symbol: asset.symbol,
        address: match?.address ?? 'Unknown / not verified by ORBIT',
        status: match ? 'Verified in ORBIT' : 'Unknown / not verified by ORBIT',
      } satisfies ContractSafetyStatus;
    });

  const recommendations: string[] = [];
  if (unrestrictedApprovals.length > 0) recommendations.push('Revoke unnecessary unlimited approvals from the approval review flow.');
  if (chainId !== base.id) recommendations.push('Switch back to Base Mainnet to keep wallet activity within the supported network.');
  if (unknownContractInteractions > 0) recommendations.push('Review the unknown contract interactions in your recent transaction history.');
  if (failedTransactions > 0) recommendations.push('Review failed transactions to confirm there were no unexpected or repeated calls.');
  if (largeOutgoingTransfers > 0) recommendations.push('Review large outgoing transfers against your current portfolio before repeating similar actions.');
  if (recommendations.length === 0) recommendations.push('No immediate actions are indicated by the current wallet and transaction data.');

  const summary =
    score >= 85
      ? 'Wallet conditions are generally healthy based on the on-chain data currently available.'
      : score >= 60
        ? 'Wallet activity shows some caution areas, mostly from approvals or transaction patterns.'
        : 'The wallet shows material risk signals that are worth reviewing promptly.';

  const severity = score >= 85 ? 'Low' : score >= 60 ? 'Medium' : 'High';

  return {
    score,
    severity,
    factors,
    recommendations,
    summary,
    unknownContractInteractions,
    failedTransactions,
    largeOutgoingTransfers,
    approvalAlerts,
    trackedContractStatus,
  };
}


import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useReducedMotion } from 'framer-motion';
import { useAccount } from 'wagmi';
import { arcTestnet } from 'wagmi/chains';
import {
  ArrowDownLeft,
  ArrowDownRight,
  ArrowUpRight,
  AlertTriangle,
  Check,
  ChevronRight,
  CircleHelp,
  Clipboard,
  Clock3,
  ExternalLink,
  FileSearch,
  Fingerprint,
  LockKeyhole,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  Wallet,
  XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useApprovals } from '../hooks/useApprovals';
import { useRevokeApproval } from '../hooks/useRevokeApproval';
import { useTransactions } from '../hooks/useTransactions';
import { ARC_TESTNET } from '../data/networks';
import {
  APPROVAL_SCAN_HISTORY_WINDOWS,
  APPROVAL_SCAN_HISTORY_WINDOW_STORAGE_KEY,
  DEFAULT_APPROVAL_SCAN_HISTORY_WINDOW,
  canRevokeApproval,
  countLargeOutgoingTransfers,
  getApprovalCoveragePercent,
  getApprovalScanStatus,
  getSecurityAssessment,
  summarizeApprovalInventory,
  type ApprovalScanHistoryWindow,
  type ApprovalRisk,
  type TokenApproval,
} from '../services/security';
import { formatTransactionDate, shortAddr } from '../services/transactions';
import { Button, Card, ChainLogo, Pill, TokenIcon } from './ui';
import { SlideToConfirm } from './SlideToConfirm';

type ApprovalStatusFilter = 'all' | 'active' | 'zero';
type ApprovalRiskFilter = 'all' | ApprovalRisk;

const explorerUrl = ARC_TESTNET.blockExplorers.default.url;
const compactNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function shortenAddress(address: string): string {
  return `${address.slice(0, 7)}…${address.slice(-5)}`;
}

function countLabel(value: number | null, available: boolean): string {
  return available && value !== null ? compactNumber.format(value) : 'Unknown';
}

function riskColor(risk: ApprovalRisk): 'green' | 'amber' | 'red' | 'purple' {
  if (risk === 'High') return 'red';
  if (risk === 'Medium') return 'amber';
  if (risk === 'Low') return 'green';
  return 'purple';
}

function addressUrl(address: string): string {
  return `${explorerUrl}/address/${address}`;
}

function VerificationBadge({ value }: { value: boolean | null }) {
  if (value === true) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-emerald-300">
        <ShieldCheck size={11} aria-hidden="true" /> Verified
      </span>
    );
  }
  if (value === false) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-slate-400">
        <Shield size={11} aria-hidden="true" /> Unverified
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-amber-200">
      <CircleHelp size={11} aria-hidden="true" /> Unavailable
    </span>
  );
}

function MetricRow({
  icon: Icon,
  label,
  value,
  tone = 'slate',
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  tone?: 'slate' | 'emerald' | 'amber' | 'rose' | 'cyan';
}) {
  const toneClass = {
    slate: 'text-slate-400 bg-white/[.035]',
    emerald: 'text-emerald-300 bg-emerald-400/[.08]',
    amber: 'text-amber-200 bg-amber-300/[.08]',
    rose: 'text-rose-300 bg-rose-400/[.08]',
    cyan: 'text-cyan-200 bg-cyan-400/[.08]',
  }[tone];

  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl border border-white/[.055] bg-[#0c1414]/70 px-3 py-2.5">
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${toneClass}`}>
        <Icon size={15} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-slate-400">{label}</span>
      <strong className="shrink-0 font-mono text-sm font-semibold tabular-nums text-slate-100">{value}</strong>
      <ChevronRight size={13} className="shrink-0 text-slate-600" aria-hidden="true" />
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  accent,
  children,
}: {
  icon: LucideIcon;
  label: string;
  accent: string;
  children: ReactNode;
}) {
  return (
    <Card className="security-summary-card min-h-[150px] rounded-2xl border border-[#243331] bg-[#0b1212]/95 p-4 shadow-[0_14px_34px_rgba(0,0,0,.16)] sm:p-5">
      <div className="flex items-center gap-2.5">
        <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${accent}`}>
          <Icon size={16} aria-hidden="true" />
        </span>
        <h2 className="text-[11px] font-semibold uppercase tracking-[.13em] text-slate-400">{label}</h2>
      </div>
      <div className="mt-3">{children}</div>
    </Card>
  );
}

function shortError(error: string): string {
  return error.length > 180 ? `${error.slice(0, 177)}…` : error;
}

function formatTransactionAmount(transaction: {
  value: string;
  nativeSymbol?: string;
  tokenTransfers: Array<{ amount: string; symbol: string; direction: 'sent' | 'received' }>;
}): string {
  if (transaction.tokenTransfers.length > 0) {
    return transaction.tokenTransfers
      .slice(0, 2)
      .map((transfer) => `${transfer.direction === 'sent' ? '−' : '+'}${transfer.amount} ${transfer.symbol}`)
      .join(', ');
  }
  const amount = Number(transaction.value);
  return Number.isFinite(amount) && amount > 0
    ? `${amount.toLocaleString(undefined, { maximumFractionDigits: 5 })} ${transaction.nativeSymbol ?? 'token'}`
    : '—';
}

function formatTimestamp(timestamp: number | null): string {
  return timestamp === null ? 'Unavailable' : formatTransactionDate(timestamp);
}

function readApprovalScanHistoryWindow(): {
  blocks: ApprovalScanHistoryWindow;
  error: string | null;
} {
  try {
    const stored = localStorage.getItem(APPROVAL_SCAN_HISTORY_WINDOW_STORAGE_KEY);
    const blocks = Number(stored);
    if (APPROVAL_SCAN_HISTORY_WINDOWS.some((window) => window === blocks)) {
      return { blocks: blocks as ApprovalScanHistoryWindow, error: null };
    }
  } catch (error) {
    return {
      blocks: DEFAULT_APPROVAL_SCAN_HISTORY_WINDOW,
      error: error instanceof Error ? error.message : 'Unable to read the saved history window.',
    };
  }
  return { blocks: DEFAULT_APPROVAL_SCAN_HISTORY_WINDOW, error: null };
}

function PageAnchor({ id }: { id: string }) {
  return <span id={id} className="relative -top-3 block scroll-mt-6" aria-hidden="true" />;
}

export function SecurityCenter({ onManageApprovals }: { onManageApprovals: () => void }) {
  const reduceMotion = useReducedMotion();
  const { address, isConnected, chainId } = useAccount();
  const [historyWindowSetting, setHistoryWindowSetting] = useState(readApprovalScanHistoryWindow);
  const [approvalToConfirm, setApprovalToConfirm] = useState<TokenApproval | null>(null);
  const [cooldownClock, setCooldownClock] = useState(Date.now());
  const approvalsQuery = useApprovals(true, historyWindowSetting.blocks);
  const transactionsQuery = useTransactions(
    address,
    isConnected && chainId === arcTestnet.id && Boolean(address),
    chainId,
    false,
    true,
  );
  const {
    revoke,
    activeApprovalId,
    status: revokeStatus,
    transactionHash,
    error: revokeError,
    retryRevokeCheck,
  } = useRevokeApproval();
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<ApprovalStatusFilter>('all');
  const [riskFilter, setRiskFilter] = useState<ApprovalRiskFilter>('all');
  const [activeTab, setActiveTab] = useState('token-approvals');
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [continueScanError, setContinueScanError] = useState<string | null>(null);

  const approvals = useMemo(() => approvalsQuery.data?.approvals ?? [], [approvalsQuery.data]);
  const transactions = transactionsQuery.transactions;
  const connectedToArc = isConnected && chainId === ARC_TESTNET.id && Boolean(address);
  const approvalAvailable = approvalsQuery.data !== undefined;
  const activityAvailable = transactionsQuery.lastScannedAt !== null && !transactionsQuery.isError;
  const hasTransactionSample = transactionsQuery.lastScannedAt !== null;
  const activeApprovals = approvals.filter((approval) => approval.allowance > 0n);
  const unlimitedApprovals = activeApprovals.filter((approval) => approval.isUnlimited);
  const finiteHighApprovals = activeApprovals.filter((approval) => approval.risk === 'Medium');
  const failedTransactions = transactions.filter((transaction) => transaction.status === 'failed');
  const largeOutgoing = address ? countLargeOutgoingTransfers(transactions, address) : 0;
  const contractInteractions = transactions.filter((transaction) =>
    transaction.category === 'Contract Interaction',
  );
  const outgoingTransferCount = transactions.reduce((count, transaction) =>
    count +
    transaction.tokenTransfers.filter((transfer) => transfer.direction === 'sent').length +
    (transaction.category === 'Send' && transaction.tokenTransfers.length === 0 && Number(transaction.value) > 0 ? 1 : 0),
  0);
  const incomingTransferCount = transactions.reduce((count, transaction) =>
    count +
    transaction.tokenTransfers.filter((transfer) => transfer.direction === 'received').length +
    (transaction.category === 'Receive' && transaction.tokenTransfers.length === 0 && Number(transaction.value) > 0 ? 1 : 0),
  0);
  const approvalCoverage = approvalsQuery.data
    ? getApprovalCoveragePercent(approvalsQuery.data.coveredBlocks, approvalsQuery.data.totalBlocks)
    : 0;
  const approvalScanStatus = getApprovalScanStatus({
    isFetching: approvalsQuery.isFetching,
    isError: approvalsQuery.isError,
    data: approvalsQuery.data,
    now: cooldownClock,
  });
  const cooldownActive = approvalsQuery.cooldownUntil !== null &&
    approvalsQuery.cooldownUntil > cooldownClock;
  const providerLimitEncountered = !approvalsQuery.data?.isComplete && (
    approvalScanStatus === 'Partial scan — provider limit' || cooldownActive
  );
  const scanStatusLabel = approvalScanStatus ?? (
    providerLimitEncountered
      ? 'Partial scan — provider limit'
      : !isConnected ? 'Connect wallet' : !connectedToArc ? 'Assessment unavailable' : 'Scan required'
  );

  useEffect(() => {
    if (!cooldownActive || approvalsQuery.cooldownUntil === null) return;
    const timer = window.setTimeout(
      () => setCooldownClock(Date.now()),
      Math.max(0, approvalsQuery.cooldownUntil - Date.now() + 20),
    );
    return () => window.clearTimeout(timer);
  }, [approvalsQuery.cooldownUntil, cooldownActive]);
  const approvalInventory = summarizeApprovalInventory(
    approvalAvailable ? approvals : undefined,
    Boolean(approvalsQuery.data?.isComplete),
  );

  const assessment = getSecurityAssessment({
    walletConnected: isConnected && Boolean(address),
    supportedNetwork: chainId === arcTestnet.id,
    isScanning: approvalsQuery.isFetching || transactionsQuery.isFetching,
    providerRateLimited: providerLimitEncountered,
    approvalScanStarted: approvalsQuery.data !== undefined,
    approvalWindowComplete: Boolean(approvalsQuery.data?.isComplete),
    approvalHistoryStartsAtGenesis: approvalsQuery.data?.scannedFromBlock === 0n,
    approvalDataUnavailable: approvalsQuery.isError || Boolean(approvalsQuery.data?.errors.length),
    activityScanStarted: activityAvailable,
    activityDataUnavailable: transactionsQuery.isError,
    activityHasUnresolvedTransactions: transactions.some(
      (transaction) => transaction.status !== 'success' && transaction.status !== 'failed',
    ),
  });
  const filteredApprovals = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    return approvals.filter((approval) => {
      const matchesQuery = !query || [
        approval.token.symbol,
        approval.token.name,
        approval.token.address,
        approval.spenderAddress,
      ].some((value) => value.toLowerCase().includes(query));
      const matchesStatus = statusFilter === 'all' ||
        (statusFilter === 'active' ? approval.allowance > 0n : approval.allowance === 0n);
      const matchesRisk = riskFilter === 'all' || approval.risk === riskFilter;
      return matchesQuery && matchesStatus && matchesRisk;
    });
  }, [approvals, riskFilter, searchText, statusFilter]);

  const verificationIssues = approvals.filter((approval) =>
    approval.tokenVerified !== true || approval.spenderVerified !== true,
  ).length;
  const tokenVerificationFailures = approvalsQuery.data?.errors.filter((error) =>
    /contract verification/i.test(error),
  ).length ?? 0;
  const hasVerificationIssues = verificationIssues > 0 || tokenVerificationFailures > 0;
  const recommendations = [
    {
      icon: LockKeyhole,
      title: 'Revoke unused approvals',
      detail: approvalAvailable
        ? activeApprovals.length > 0
          ? `${activeApprovals.length} active allowance${activeApprovals.length === 1 ? '' : 's'} observed. Revoke only allowances you no longer need.`
          : approvals.length === 0
            ? 'No spender records were found in the checked window. This preventive reminder remains because older or unsupported approvals may exist.'
            : approvalsQuery.data?.isComplete
              ? 'No active allowance was observed among checked records in this window. This preventive reminder remains because older or unsupported approvals may exist.'
              : `No active allowance was observed among ${approvals.length} checked records. This reminder remains because the scan is incomplete.`
        : 'Approval state is unavailable until the scan succeeds.',
      tone: activeApprovals.length > 0 ? 'amber' as const : 'slate' as const,
      action: approvalAvailable && activeApprovals.length > 0 ? 'Review approvals' : null,
      onClick: onManageApprovals,
      available: approvalAvailable && activeApprovals.length > 0,
    },
    {
      icon: AlertTriangle,
      title: 'Review unlimited allowances',
      detail: approvalAvailable
        ? unlimitedApprovals.length > 0
          ? `${unlimitedApprovals.length} unlimited allowance${unlimitedApprovals.length === 1 ? '' : 's'} observed; review whether each is still needed.`
          : approvals.length === 0
            ? 'No spender records were found in the checked window. This preventive reminder remains because older or unsupported approvals may exist.'
            : approvalsQuery.data?.isComplete
              ? 'No unlimited allowance was observed among checked records in this window. This reminder remains because older or unsupported approvals may exist.'
              : `No unlimited allowance was observed among ${approvals.length} checked records. This reminder remains because the scan is incomplete.`
        : 'Unlimited allowance state is unavailable until the scan succeeds.',
      tone: unlimitedApprovals.length > 0 ? 'amber' as const : 'slate' as const,
      action: approvalAvailable && unlimitedApprovals.length > 0 ? 'Filter unlimited' : null,
      onClick: onManageApprovals,
      available: approvalAvailable && unlimitedApprovals.length > 0,
    },
    ...(hasVerificationIssues ? [{
      icon: Fingerprint,
      title: 'Verify unknown contracts',
      detail: `${verificationIssues + tokenVerificationFailures} observed token/spender verification check${verificationIssues + tokenVerificationFailures === 1 ? '' : 's'} returned unverified or unavailable. ArcScan verification metadata is not an independent audit or a safety guarantee.`,
      tone: 'cyan' as const,
      action: approvalAvailable ? 'Inspect contracts' : null,
      onClick: onManageApprovals,
      available: approvalAvailable,
    }] : []),
    {
      icon: ArrowUpRight,
      title: 'Keep an eye on large transfers',
      detail: activityAvailable
        ? largeOutgoing > 0
          ? `${largeOutgoing} outgoing transfer${largeOutgoing === 1 ? '' : 's'} at or above 100 USDC units in the recent activity sample.`
          : 'No matching transfer was observed in the recent activity sample. This monitoring reminder remains because the sample covers only recent activity.'
        : 'Recent transfer activity is unavailable.',
      tone: largeOutgoing > 0 ? 'amber' as const : 'slate' as const,
      action: activityAvailable && largeOutgoing > 0 ? 'Review activity' : null,
      onClick: () => jumpTo('transaction-analysis'),
      available: activityAvailable && largeOutgoing > 0,
    },
  ];

  const continueApprovalScan = async () => {
    setContinueScanError(null);
    try {
      await approvalsQuery.continueScan();
    } catch (error) {
      setContinueScanError(error instanceof Error ? error.message : 'Unable to continue the approval scan.');
    }
  };

  const changeHistoryWindow = (value: string) => {
    const blocks = Number(value);
    if (!APPROVAL_SCAN_HISTORY_WINDOWS.some((window) => window === blocks)) return;
    try {
      localStorage.setItem(APPROVAL_SCAN_HISTORY_WINDOW_STORAGE_KEY, String(blocks));
      setHistoryWindowSetting({ blocks: blocks as ApprovalScanHistoryWindow, error: null });
    } catch (error) {
      setHistoryWindowSetting({
        blocks: blocks as ApprovalScanHistoryWindow,
        error: error instanceof Error ? error.message : 'Unable to save the history window preference.',
      });
    }
  };

  const refreshScan = () => {
    void continueApprovalScan();
    transactionsQuery.refetch();
  };

  const copyAddress = async (value: string) => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard access is unavailable in this browser.');
      await navigator.clipboard.writeText(value);
      setCopiedAddress(value);
      setCopyError(null);
      window.setTimeout(() => setCopiedAddress((current) => current === value ? null : current), 1600);
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : 'Unable to copy address.');
    }
  };

  const confirmRevoke = (approval: TokenApproval) => {
    if (!canRevokeApproval(approval)) return;
    setApprovalToConfirm(approval);
  };

  const jumpTo = (id: string) => {
    setActiveTab(id);
    document.getElementById(id)?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  };

  const tabs = [
    ['token-approvals', 'Approval Summary'],
    ['transaction-analysis', 'Transaction Analysis'],
    ['risk-insights', 'Risk Insights'],
    ['security-recommendations', 'Security Recommendations'],
  ] as const;

  return (
    <main className="security-page min-w-0 space-y-5 pb-10">
      <section className="security-hero relative overflow-hidden rounded-2xl border border-[#29423c] px-5 py-5 shadow-[0_18px_55px_rgba(0,0,0,.2)] sm:px-7 sm:py-6">
        <div className="security-hero-glow pointer-events-none absolute inset-0" aria-hidden="true" />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-emerald-300/15 bg-emerald-300/[.08] text-emerald-200">
              <ShieldCheck size={24} strokeWidth={1.7} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-[-.035em] text-white sm:text-[28px]">Security Center</h1>
                <Pill color={scanStatusLabel === 'Window complete' ? 'green' : scanStatusLabel === 'Scanning' ? 'cyan' : 'amber'}>
                  {scanStatusLabel}
                </Pill>
              </div>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-300/80">
                Check and manage your wallet security, token approvals, and recent activity on Arc Testnet.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
                <span className="inline-flex items-center gap-1.5">
                  <Clock3 size={12} aria-hidden="true" />
                  Last scan attempt: {approvalsQuery.data
                    ? new Date(approvalsQuery.data.lastScanAttemptAt).toLocaleString()
                    : 'Not started'}
                </span>
                {address && (
                  <span className="inline-flex items-center gap-1.5">
                    <Wallet size={12} aria-hidden="true" />
                    {shortAddr(address)}
                  </span>
                )}
                <span className="inline-flex items-center gap-1.5">
                  <ChainLogo chainId={ARC_TESTNET.id} className="h-3.5 w-3.5" />
                  Arc Testnet
                </span>
              </div>
            </div>
          </div>
          <Button
            variant="secondary"
            onClick={refreshScan}
            disabled={!connectedToArc || approvalsQuery.isFetching || transactionsQuery.isFetching || cooldownActive}
            className="shrink-0 self-start border-[#3a5a50] bg-[#0c1a17] text-emerald-100 hover:border-emerald-400/50 sm:self-center"
          >
            <RefreshCw
              size={14}
              className={approvalsQuery.isFetching || transactionsQuery.isFetching ? 'animate-spin' : ''}
              aria-hidden="true"
            />
            {approvalsQuery.isFetching || transactionsQuery.isFetching
              ? 'Scanning'
              : cooldownActive ? 'Provider cooldown' : 'Refresh Scan'}
          </Button>
        </div>
      </section>

      {(!isConnected || chainId !== arcTestnet.id) && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300/20 bg-amber-300/[.04] px-4 py-3 text-sm text-amber-100">
          <span className="flex items-center gap-2">
            <TriangleAlert size={16} aria-hidden="true" />
            {!isConnected
              ? 'Connect a wallet to load account-specific security data.'
              : 'Security scans are available on Arc Testnet. Current wallet data is not being assessed.'}
          </span>
        </div>
      )}

      {(approvalsQuery.isError || transactionsQuery.isError) && (
        <details role="alert" className="rounded-lg border border-rose-400/15 bg-rose-400/[.025] px-3 py-2 text-[11px] text-rose-100/80">
          <summary className="cursor-pointer font-medium">A security data source failed · view diagnostics</summary>
          {approvalsQuery.error && <p className="mt-2 break-words">Approval scan: {shortError(approvalsQuery.error.message)}</p>}
          {transactionsQuery.error && <p className="mt-1 break-words">ArcScan activity: {shortError(transactionsQuery.error.message)}</p>}
        </details>
      )}

      {approvalsQuery.data?.isComplete && approvalsQuery.isFetching && (
        <p role="status" className="rounded-lg border border-cyan-300/15 bg-cyan-300/[.035] px-4 py-2 text-[11px] text-cyan-100/80">
          Refreshing approval coverage; the previous successful results remain visible until this scan completes.
        </p>
      )}

      <section
        aria-label="Approval scan status"
        role="status"
        className="security-scan-status rounded-xl border border-[#344039] bg-[#0b1212]/90 px-3 py-3 sm:px-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <span className="text-xs font-semibold text-slate-100">
                {scanStatusLabel}
              </span>
              {approvalsQuery.data && (
                <span className="font-mono text-[11px] tabular-nums text-slate-300">
                  {approvalCoverage.toFixed(2)}% of the selected {approvalsQuery.data.historyWindowBlocks.toLocaleString()}-block window
                </span>
              )}
            </div>
            <p className="mt-1 text-[11px] leading-4 text-slate-400">
              {providerLimitEncountered
                ? `Partial scan — provider limit. The public RPC deferred pending ranges; ${approvalsQuery.data?.tokenCoverage.reduce((total, item) => total + item.remainingRangeCount, 0).toLocaleString() ?? 'Some'} remain. Completed ranges are saved.`
                : approvalScanStatus === 'Failed'
                  ? 'The latest attempt failed; previously saved coverage and results remain available.'
                : approvalsQuery.data && !approvalsQuery.data.isComplete
                  ? `${approvalsQuery.data.tokenCoverage.reduce((total, item) => total + item.remainingRangeCount, 0).toLocaleString()} ranges remain in the selected window. Completed ranges are saved; older history is not included.`
                  : approvalScanStatus === 'Window complete'
                      ? `${approvalCoverage.toFixed(2)}% of the selected ${(approvalsQuery.data?.historyWindowBlocks ?? BigInt(historyWindowSetting.blocks)).toLocaleString()}-block window is covered. This is not the wallet’s complete approval history.`
                    : connectedToArc
                      ? 'The scan covers a bounded recent history window for configured Arc Testnet tokens; older history is not included.'
                      : scanStatusLabel === 'Connect wallet'
                        ? 'Connect an Arc Testnet wallet to scan configured-token approval history.'
                        : 'Switch to Arc Testnet to load the required security data.'}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-400">
              <label className="inline-flex items-center gap-2">
                Recent history window
                <select
                  aria-label="Approval scan history window"
                  value={historyWindowSetting.blocks}
                  onChange={(event) => changeHistoryWindow(event.target.value)}
                  className="rounded-md border border-white/10 bg-[#111a19] px-2 py-1 text-[10px] text-slate-200"
                >
                  {APPROVAL_SCAN_HISTORY_WINDOWS.map((blocks) => (
                    <option key={blocks} value={blocks}>
                      {blocks.toLocaleString()} blocks ({(blocks / 10_000).toLocaleString()} standard ranges/token)
                    </option>
                  ))}
                </select>
              </label>
              {approvalsQuery.data && (
                <span>
                  Window boundary: blocks {approvalsQuery.data.scannedFromBlock.toString()}–{approvalsQuery.data.scannedToBlock.toString()} per token
                </span>
              )}
            </div>
            {historyWindowSetting.error && (
              <p className="mt-1 text-[10px] text-rose-200">
                History-window preference could not be saved: {historyWindowSetting.error}
              </p>
            )}
            {approvalsQuery.data && (
              <p className="mt-1 text-[10px] leading-4 text-slate-500">
                Successful ranges:{' '}
                {approvalsQuery.data.tokenCoverage.map((coverage) => (
                  `${coverage.symbol} ${
                    coverage.coveredRanges.length > 0
                      ? coverage.coveredRanges.map((range) => `${range.fromBlock}–${range.toBlock}`).join(', ')
                      : 'none'
                  }`
                )).join(' · ')}
              </p>
            )}
            {approvalsQuery.data && (
              <div
                className="mt-2 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-white/[.07]"
                role="progressbar"
                aria-label="Approval history coverage"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={approvalCoverage}
                aria-valuetext={`${approvalCoverage.toFixed(2)} percent covered`}
              >
                <div
                  className="h-full rounded-full bg-[var(--orbit-gold)] transition-[width] duration-300"
                  style={{ width: `${approvalCoverage}%` }}
                />
              </div>
            )}
            {cooldownActive && approvalsQuery.cooldownUntil !== null && (
              <p className="mt-1.5 text-[10px] text-amber-200/75">
                Provider cooldown until {new Date(approvalsQuery.cooldownUntil).toLocaleTimeString()}.
                Continue Scan is paused; retry becomes available after this time. No RPC requests are sent during cooldown.
              </p>
            )}
            {continueScanError && <p className="mt-1.5 text-[10px] text-rose-200">{continueScanError}</p>}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {approvalScanStatus !== 'Window complete' && connectedToArc && (
              <Button
                variant="secondary"
                className="rounded-lg px-2.5 py-1.5 text-[10px]"
                disabled={approvalsQuery.isFetching || cooldownActive}
                onClick={() => void continueApprovalScan()}
              >
                <RefreshCw
                  size={13}
                  className={approvalsQuery.isFetching ? 'animate-spin' : ''}
                  aria-hidden="true"
                />
                {cooldownActive
                  ? 'Provider cooldown'
                  : approvalsQuery.isFetching ? 'Scanning' : 'Continue scan'}
              </Button>
            )}
            <details className="relative">
              <summary className="cursor-pointer list-none rounded-md border border-white/[.1] px-2.5 py-1.5 text-[10px] font-medium text-slate-300 hover:bg-white/[.035]">
                Technical details
              </summary>
              <div className="absolute right-0 z-20 mt-2 w-[min(90vw,38rem)] rounded-xl border border-[#344039] bg-[#0b1212] p-3 shadow-xl sm:w-[38rem]">
                <div className="max-h-[65vh] space-y-3 overflow-y-auto text-[10px]">
                  <div>
                    <p className="mb-1 font-semibold text-slate-200">RPC errors</p>
                    {approvalsQuery.isError && (
                      <p className="mb-1 break-words text-rose-200">
                        Latest attempt: {approvalsQuery.error?.message ?? 'Scanner request failed'}
                      </p>
                    )}
                    {approvalsQuery.data?.errors.length ? (
                      <ul className="space-y-1 font-mono text-slate-400">
                        {approvalsQuery.data.errors.map((error, index) => (
                          <li key={`${index}:${error}`} className="break-words">{error}</li>
                        ))}
                      </ul>
                    ) : <p className="text-slate-500">No RPC errors recorded in the last attempt.</p>}
                  </div>
                  {approvalsQuery.data && (
                    <div className="border-t border-white/[.07] pt-2">
                      <p className="mb-1 font-semibold text-slate-200">Per-token coverage and ranges</p>
                      <div className="space-y-2 font-mono text-[10px]">
                        {approvalsQuery.data.tokenCoverage.map((tokenCoverage) => (
                          <div key={tokenCoverage.symbol} className="rounded-lg border border-white/[.07] p-2">
                            <p className="font-sans font-semibold text-slate-200">
                              {tokenCoverage.symbol}: {tokenCoverage.coveredRanges.length} covered intervals,
                              {' '}{tokenCoverage.failedRanges.length} failed, {tokenCoverage.remainingRangeCount.toLocaleString()} pending ranges
                            </p>
                            <p className="mt-1 font-sans text-slate-500">
                              Last successful range: {tokenCoverage.lastSuccessfulRange
                                ? `${tokenCoverage.lastSuccessfulRange.fromBlock}–${tokenCoverage.lastSuccessfulRange.toBlock}`
                                : 'none yet'}
                              {tokenCoverage.lastSuccessfulAt === null
                                ? ''
                                : ` · ${new Date(tokenCoverage.lastSuccessfulAt).toLocaleString()}`}
                            </p>
                            {tokenCoverage.coveredRanges.length > 0 && (
                              <p className="mt-1 break-words text-emerald-200/80">
                                Successful ranges: {tokenCoverage.coveredRanges.map((range) =>
                                  `${range.fromBlock}–${range.toBlock}`,
                                ).join(', ')}
                              </p>
                            )}
                            {tokenCoverage.failedRanges.length > 0 && (
                              <p className="mt-1 break-words text-rose-200/80">
                                Failed ranges: {tokenCoverage.failedRanges.slice(0, 10).map((range) => `${range.fromBlock}–${range.toBlock}`).join(', ')}
                                {tokenCoverage.failedRanges.length > 10 ? `, … (${tokenCoverage.failedRanges.length - 10} more)` : ''}
                              </p>
                            )}
                            {tokenCoverage.remainingRanges.length > 0 && (
                              <p className="mt-1 break-words text-slate-400">
                                Pending ranges: {tokenCoverage.remainingRanges.slice(0, 10).map((range) => `${range.fromBlock}–${range.toBlock}`).join(', ')}
                                {tokenCoverage.remainingRangeCount > 10 ? ', …' : ''}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </details>
          </div>
        </div>
      </section>

      <section aria-label="Security overview" className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard icon={Shield} label="Security Score" accent="bg-[#c6a76a]/[.09] text-[#d2b779]">
          <div className="flex min-w-0 items-center gap-3">
            <div
              className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-[#c6a76a]/25 bg-[#c6a76a]/[.07] text-[#d2b779]"
              aria-hidden="true"
              role="img"
            >
              <ShieldCheck size={23} strokeWidth={1.7} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-100">Not scored</p>
              <p className="mt-1 text-[11px] leading-4 text-slate-500">
                No reliable numeric score is available for this assessment.
              </p>
            </div>
          </div>
        </SummaryCard>

        <SummaryCard icon={Shield} label="Approval inventory" accent="bg-emerald-300/[.09] text-emerald-200">
          <div className="grid grid-cols-2 gap-3">
            <div className="min-w-0">
              <p className="text-[10px] leading-4 text-slate-500">Active allowances</p>
              <p className="mt-0.5 font-mono text-xl font-semibold leading-none tabular-nums text-white">
                {approvalInventory.activeAllowances ?? '—'}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-[10px] leading-4 text-slate-500">Observed spender records</p>
              <p className="mt-0.5 font-mono text-xl font-semibold leading-none tabular-nums text-white">
                {approvalInventory.observedSpenderRecords ?? '—'}
              </p>
            </div>
          </div>
          <p className="mt-2 text-[10px] leading-4 text-slate-500">
            {approvalInventory.activeAllowances === null
              ? 'No checked allowance values are available.'
              : approvalInventory.isCoverageComplete
                ? 'Counts reflect current on-chain values for observed records in the selected history window; older history is not included.'
                : `Counts reflect checked records only; the scan is incomplete, so other approvals may not be included.`}
          </p>
        </SummaryCard>

        <SummaryCard icon={AlertTriangle} label="Unlimited Allowances" accent="bg-amber-300/[.09] text-amber-200">
          <div className="flex items-baseline gap-2">
            <p className="font-mono text-[27px] font-semibold leading-none tabular-nums text-white">
              {approvalAvailable && approvals.length > 0 ? unlimitedApprovals.length : '—'}
            </p>
            <span className={`text-[11px] ${unlimitedApprovals.length > 0 ? 'text-amber-200' : 'text-slate-500'}`}>
              {approvalAvailable && approvals.length > 0
                ? unlimitedApprovals.length > 0 ? 'review recommended' : approvalsQuery.data?.isComplete ? 'none observed' : 'partial data'
                : 'no checked records'}
            </span>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            {approvalAvailable && approvals.length > 0
              ? `${finiteHighApprovals.length} high finite allowance${finiteHighApprovals.length === 1 ? '' : 's'} among checked records`
              : 'Requires checked on-chain allowance values'}
          </p>
        </SummaryCard>

        <SummaryCard icon={FileSearch} label="Scan Status" accent="bg-cyan-300/[.09] text-cyan-200">
          <p className="text-sm font-semibold text-slate-100">
            {scanStatusLabel}
          </p>
          <p className="mt-1 text-[11px] leading-4 text-slate-500">
            {approvalsQuery.data
              ? `${approvalCoverage.toFixed(2)}% of selected window covered · ${approvalsQuery.data.tokenCoverage.reduce((total, item) => total + item.remainingRangeCount, 0).toLocaleString()} ranges remain`
              : 'Approval coverage unavailable'}
          </p>
        </SummaryCard>
      </section>

      <nav aria-label="Security sections" className="security-tabs flex min-w-0 gap-1 overflow-x-auto border-b border-white/[.08]">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => jumpTo(id)}
            aria-current={activeTab === id ? 'page' : undefined}
            className={`security-tab relative shrink-0 px-3 py-3 text-xs font-medium transition-colors sm:px-4 ${
              activeTab === id ? 'text-emerald-200' : 'text-slate-500 hover:text-slate-200'
            }`}
          >
            {label}
            {activeTab === id && <span className="absolute inset-x-3 bottom-[-1px] h-[2px] rounded bg-emerald-300 sm:inset-x-4" />}
          </button>
        ))}
      </nav>

      <div className="grid min-w-0 items-start gap-4">
        <section className="min-w-0 space-y-4">
          <PageAnchor id="token-approvals" />
          <Card className="min-w-0 overflow-hidden rounded-2xl border border-[#243331] bg-[#0b1212]/95 shadow-[0_14px_34px_rgba(0,0,0,.15)]">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/[.06] px-4 py-4 sm:px-5">
              <div>
                <h2 className="text-base font-semibold tracking-tight text-slate-100">Approval Summary</h2>
                <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500">
                  Approval coverage and checked allowance totals only. View individual records and revoke permissions on Approvals &amp; Revoke.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {approvalsQuery.data && (
                  <Pill color={approvalsQuery.data.isComplete ? 'green' : 'amber'}>
                    {approvalsQuery.data.isComplete ? 'WINDOW COMPLETE' : 'PARTIAL COVERAGE'}
                  </Pill>
                )}
                <Button variant="secondary" className="rounded-lg px-2.5 py-1.5 text-[10px]" onClick={onManageApprovals}>
                  Manage approvals <ChevronRight size={14} aria-hidden="true" />
                </Button>
              </div>
            </div>

            <div className="px-4 py-3 sm:px-5">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-white/[.055] bg-[#0c1414]/70 px-3 py-2.5">
                  <p className="text-[10px] text-slate-500">Observed spender records</p>
                  <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-slate-100">
                    {approvalInventory.observedSpenderRecords ?? 'Unknown'}
                  </p>
                </div>
                <div className="rounded-lg border border-white/[.055] bg-[#0c1414]/70 px-3 py-2.5">
                  <p className="text-[10px] text-slate-500">Active allowances</p>
                  <p className="mt-1 font-mono text-lg font-semibold tabular-nums text-slate-100">
                    {approvalInventory.activeAllowances ?? 'Unknown'}
                  </p>
                </div>
              </div>
              <p className="mt-2 text-[10px] leading-4 text-slate-500">
                {approvalInventory.activeAllowances === null
                  ? 'No current allowance values have been checked for discovered spender records.'
                  : `The count reflects current allowance reads for ${approvalInventory.observedSpenderRecords ?? 0} discovered spender records that were successfully checked; it is not a complete wallet approval inventory.`}
              </p>
            </div>

            <div className="hidden">
            <div className="flex flex-col gap-2 border-b border-white/[.055] px-4 py-3 sm:flex-row sm:px-5">
              <label className="relative min-w-0 flex-1">
                <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" aria-hidden="true" />
                <input
                  type="search"
                  value={searchText}
                  onChange={(event) => setSearchText(event.target.value)}
                  placeholder="Search token, contract, or spender"
                  aria-label="Search token approvals"
                  className="h-9 w-full rounded-lg border border-[#263635] bg-[#080e0e] pl-9 pr-3 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-emerald-400/50"
                />
              </label>
              <label className="sr-only" htmlFor="approval-status-filter">Approval status</label>
              <select
                id="approval-status-filter"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as ApprovalStatusFilter)}
                className="h-9 rounded-lg border border-[#263635] bg-[#080e0e] px-3 text-xs text-slate-300 outline-none focus:border-emerald-400/50"
              >
                <option value="all">All statuses</option>
                <option value="active">Active allowance</option>
                <option value="zero">Zero / revoked</option>
              </select>
              <label className="sr-only" htmlFor="approval-risk-filter">Approval risk</label>
              <select
                id="approval-risk-filter"
                value={riskFilter}
                onChange={(event) => setRiskFilter(event.target.value as ApprovalRiskFilter)}
                className="h-9 rounded-lg border border-[#263635] bg-[#080e0e] px-3 text-xs text-slate-300 outline-none focus:border-emerald-400/50"
              >
                <option value="all">All risks</option>
                <option value="High">High</option>
                <option value="Medium">Medium</option>
                <option value="Low">Low</option>
                <option value="Unknown">Unknown</option>
              </select>
            </div>

            {revokeStatus === 'success' && transactionHash && (
              <p className="border-b border-emerald-300/10 bg-emerald-300/[.035] px-5 py-2.5 text-xs text-emerald-200">
                Revoke receipt confirmed and a fresh on-chain read verified zero allowance.{' '}
                <a href={`${explorerUrl}/tx/${transactionHash}`} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                  View transaction
                </a>
              </p>
            )}
            {revokeStatus === 'already-zero' && (
              <p role="status" className="border-b border-white/[.06] px-5 py-2.5 text-xs text-slate-300">
                A fresh on-chain read found this allowance already at zero; no transaction was submitted.
              </p>
            )}
            {(revokeStatus === 'confirmation-pending' || revokeStatus === 'verification-pending') && revokeError && (
              <div role="status" className="flex flex-wrap items-center gap-2 border-b border-amber-300/10 bg-amber-300/[.035] px-5 py-2.5 text-xs text-amber-100">
                <span>{revokeError.message}</span>
                {transactionHash && <a href={`${explorerUrl}/tx/${transactionHash}`} target="_blank" rel="noreferrer" className="underline underline-offset-2">View transaction</a>}
                <button type="button" onClick={() => void retryRevokeCheck()} className="underline underline-offset-2">
                  {revokeStatus === 'confirmation-pending' ? 'Retry confirmation check' : 'Retry allowance check'}
                </button>
              </div>
            )}
            {revokeStatus === 'error' && revokeError && (
              <p role="alert" className="border-b border-rose-300/10 px-5 py-2.5 text-xs text-rose-200">{revokeError.message}</p>
            )}

            {!isConnected ? (
              <div className="px-5 py-12 text-center">
                <Wallet size={19} className="mx-auto text-slate-600" aria-hidden="true" />
                <p className="mt-2 text-sm text-slate-300">Connect a wallet to inspect approvals.</p>
              </div>
            ) : chainId !== arcTestnet.id ? (
              <p className="px-5 py-12 text-center text-sm text-amber-200">Switch to Arc Testnet to scan approvals.</p>
            ) : approvalsQuery.isFetching && !approvalsQuery.data ? (
              <p className="px-5 py-12 text-center text-sm text-slate-400">Reading configured token approvals…</p>
            ) : approvalsQuery.isError && !approvalsQuery.data ? (
              <p className="px-5 py-12 text-center text-sm text-rose-200">Approval data is unavailable. No zero-approval result is inferred.</p>
            ) : !approvalsQuery.data ? (
              <p className="px-5 py-12 text-center text-sm text-slate-400">Approval scan has not completed.</p>
            ) : approvals.length === 0 ? (
              <p className="px-5 py-12 text-center text-sm text-slate-400">
                {approvalsQuery.data.isComplete
                  ? 'No Approval events were found for configured tokens in the covered block window. This does not include approvals predating that window.'
                  : 'No approvals were returned in successful ranges; coverage is incomplete, so this is not a confirmed zero-approval result.'}
              </p>
            ) : filteredApprovals.length === 0 ? (
              <p className="px-5 py-10 text-center text-sm text-slate-500">No observed approval records match these filters.</p>
            ) : (
              <div className="security-table-scroll min-w-0 overflow-x-auto">
                <table className="w-full min-w-[880px] table-fixed text-left">
                  <thead className="border-b border-white/[.06] bg-white/[.012] font-mono text-[9px] uppercase tracking-[.13em] text-slate-600">
                    <tr>
                      <th className="w-[18%] px-4 py-3 font-medium">Token</th>
                      <th className="w-[25%] px-4 py-3 font-medium">Spender / Contract</th>
                      <th className="w-[19%] px-4 py-3 font-medium">Current Allowance</th>
                      <th className="w-[12%] px-4 py-3 font-medium">Risk</th>
                      <th className="w-[13%] px-4 py-3 font-medium">Last Updated</th>
                      <th className="w-[13%] px-4 py-3 text-right font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[.045]">
                    {filteredApprovals.map((approval) => (
                      <tr key={approval.id} className="align-middle text-xs transition-colors hover:bg-white/[.018]">
                        <td className="px-4 py-3.5">
                          <div className="flex min-w-0 items-center gap-2.5">
                            <TokenIcon symbol={approval.token.symbol} color={approval.token.color} />
                            <div className="min-w-0">
                              <p className="truncate font-semibold text-slate-200">{approval.token.symbol}</p>
                              <div className="mt-1 flex min-w-0 items-center gap-1">
                                <a href={addressUrl(approval.token.address)} target="_blank" rel="noreferrer" className="truncate font-mono text-[9px] text-slate-500 hover:text-cyan-200">
                                  {shortenAddress(approval.token.address)}
                                </a>
                                <button
                                  type="button"
                                  aria-label={`Copy ${approval.token.symbol} contract address`}
                                  title="Copy token contract address"
                                  onClick={() => void copyAddress(approval.token.address)}
                                  className="shrink-0 text-slate-600 hover:text-emerald-200"
                                >
                                  {copiedAddress === approval.token.address ? <Check size={11} /> : <Clipboard size={11} />}
                                </button>
                              </div>
                              <div className="mt-1"><VerificationBadge value={approval.tokenVerified} /></div>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3.5">
                          <div className="flex min-w-0 items-start gap-1">
                            <div className="min-w-0 flex-1">
                              <a href={addressUrl(approval.spenderAddress)} target="_blank" rel="noreferrer" className="block truncate font-mono text-[11px] text-cyan-200 hover:underline">
                                {shortenAddress(approval.spenderAddress)}
                              </a>
                              <div className="mt-1"><VerificationBadge value={approval.spenderVerified} /></div>
                            </div>
                            <button
                              type="button"
                              aria-label={`Copy spender address ${approval.spenderAddress}`}
                              title="Copy spender address"
                              onClick={() => void copyAddress(approval.spenderAddress)}
                              className="shrink-0 pt-0.5 text-slate-600 hover:text-emerald-200"
                            >
                              {copiedAddress === approval.spenderAddress ? <Check size={12} /> : <Clipboard size={12} />}
                            </button>
                            <details className="relative shrink-0">
                              <summary className="cursor-pointer list-none px-1 text-base leading-4 text-slate-500 hover:text-slate-200" aria-label="More approval actions">···</summary>
                              <div className="absolute right-0 top-6 z-10 w-40 rounded-lg border border-[#31403e] bg-[#0b1212] p-1 shadow-xl">
                                <a className="flex items-center gap-2 rounded-md px-2 py-2 text-[11px] text-slate-300 hover:bg-white/[.05]" href={addressUrl(approval.spenderAddress)} target="_blank" rel="noreferrer">
                                  <ExternalLink size={12} /> View spender on ArcScan
                                </a>
                                <a className="flex items-center gap-2 rounded-md px-2 py-2 text-[11px] text-slate-300 hover:bg-white/[.05]" href={addressUrl(approval.token.address)} target="_blank" rel="noreferrer">
                                  <ExternalLink size={12} /> View token on ArcScan
                                </a>
                              </div>
                            </details>
                          </div>
                        </td>
                        <td className="px-4 py-3.5">
                          <p className={`truncate font-mono text-[11px] ${approval.allowance > 0n ? 'text-slate-200' : 'text-slate-500'}`}>
                            {approval.allowance === 0n ? `0 ${approval.token.symbol}` : approval.isUnlimited ? 'Unlimited' : `${approval.allowanceFormatted} ${approval.token.symbol}`}
                          </p>
                          <p className="mt-1 truncate text-[9px] text-slate-600">Verified at block {approval.allowanceCheckedBlock.toString()}</p>
                        </td>
                        <td className="px-4 py-3.5">
                          <Pill color={riskColor(approval.risk)}>{approval.risk}</Pill>
                        </td>
                        <td className="px-4 py-3.5 text-[10px] text-slate-500">
                          <time dateTime={new Date(approval.allowanceCheckedAt).toISOString()}>
                            {new Date(approval.allowanceCheckedAt).toLocaleString()}
                          </time>
                          <span className="mt-1 block font-mono text-[9px] text-slate-600">Event block {approval.lastSeenBlock.toString()}</span>
                        </td>
                        <td className="px-4 py-3.5 text-right">
                          <button
                            type="button"
                            onClick={() => void confirmRevoke(approval)}
                            disabled={revokeStatus === 'checking' || revokeStatus === 'pending' || revokeStatus === 'confirmation-pending' || revokeStatus === 'verification-pending' || !canRevokeApproval(approval)}
                            title={!canRevokeApproval(approval) ? 'Only verified token and spender contracts can be revoked here' : 'Revoke allowance'}
                            className="rounded-lg border border-rose-300/20 bg-rose-300/[.045] px-2.5 py-1.5 text-[10px] font-semibold text-rose-100 transition hover:border-rose-300/45 hover:bg-rose-300/[.1] disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {revokeStatus === 'checking' && activeApprovalId === approval.id
                              ? 'Checking allowance…'
                              : revokeStatus === 'pending' && activeApprovalId === approval.id
                              ? 'Confirm in wallet…'
                              : approval.allowance === 0n ? 'Already zero' : 'Revoke'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {approvalToConfirm && (
              <div className="space-y-3 border-t border-rose-300/10 bg-rose-300/[.025] px-4 py-4 sm:px-5" aria-label="Review approval revocation">
                <div>
                  <p className="text-sm font-semibold text-slate-100">Review permission change</p>
                  <p className="mt-1 text-xs leading-5 text-slate-400">This on-chain action sets the allowance to zero. Your wallet will still request its own transaction signature.</p>
                </div>
                <dl className="grid gap-3 text-xs sm:grid-cols-3">
                  <div><dt className="text-slate-500">Token</dt><dd className="mt-1 text-slate-200">{approvalToConfirm.token.symbol}</dd></div>
                  <div><dt className="text-slate-500">Current permission</dt><dd className="mt-1 text-slate-200">{approvalToConfirm.isUnlimited ? 'Unlimited' : `${approvalToConfirm.allowanceFormatted} ${approvalToConfirm.token.symbol}`}</dd></div>
                  <div><dt className="text-slate-500">Spender</dt><dd className="mt-1 break-all font-mono text-slate-200">{approvalToConfirm.spenderAddress}</dd></div>
                </dl>
                {activeApprovalId === approvalToConfirm.id && revokeStatus === 'already-zero' && <p role="status" className="text-xs text-slate-300">A fresh on-chain read found zero allowance. No transaction was submitted.</p>}
                {activeApprovalId === approvalToConfirm.id && revokeError && <p role="alert" className="text-xs text-rose-200">{revokeError.message}</p>}
                <SlideToConfirm
                  label="Slide to revoke"
                  confirmationKey={`${address?.toLowerCase() ?? ''}:${chainId ?? ''}:${approvalToConfirm.id}:${approvalToConfirm.allowance.toString()}`}
                  phase={activeApprovalId !== approvalToConfirm.id ? 'idle' : revokeStatus === 'checking' || revokeStatus === 'confirmation-pending' ? 'submitting' : revokeStatus === 'pending' || revokeStatus === 'verification-pending' ? 'pending' : revokeStatus === 'success' ? 'success' : revokeStatus === 'error' ? 'failed' : 'idle'}
                  disabled={!canRevokeApproval(approvalToConfirm) || (activeApprovalId === approvalToConfirm.id && Boolean(transactionHash))}
                  onConfirm={() => revoke(approvalToConfirm)}
                />
                <Button variant="secondary" className="w-full" disabled={revokeStatus === 'checking' || revokeStatus === 'confirmation-pending' || revokeStatus === 'pending' || revokeStatus === 'verification-pending'} onClick={() => setApprovalToConfirm(null)}>Cancel</Button>
              </div>
            )}
            {copyError && <p role="status" className="border-t border-white/[.055] px-5 py-2 text-[10px] text-amber-200">{copyError}</p>}
            {approvalsQuery.data && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[.055] px-4 py-3 text-[10px] text-slate-500 sm:px-5">
                <span>{approvals.length} observed spender record{approvals.length === 1 ? '' : 's'} · checked at block {approvalsQuery.data.scannedToBlock.toString()}</span>
                <span>{approvalsQuery.data.isComplete ? 'Selected recent-window ranges succeeded; older history is not included' : 'Coverage incomplete; results are not a full inventory'}</span>
              </div>
            )}
            </div>
          </Card>

          <PageAnchor id="recent-transactions" />
          <section id="transaction-analysis" aria-labelledby="recent-transactions-heading" className="security-section-anchor">
            <Card className="min-w-0 overflow-hidden rounded-2xl border border-[#243331] bg-[#0b1212]/95 shadow-[0_14px_34px_rgba(0,0,0,.15)]">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[.06] px-4 py-4 sm:px-5">
                <div>
                  <h2 id="recent-transactions-heading" className="text-base font-semibold text-slate-100">Recent Transactions</h2>
                  <p className="mt-1 text-xs text-slate-500">Latest ArcScan transaction page for this wallet; not a complete lifetime history.</p>
                  {hasTransactionSample && (transactionsQuery.isFetching || transactionsQuery.isError) && (
                    <p className="mt-1 text-[10px] text-amber-200">
                      {transactionsQuery.isFetching ? 'Refreshing; showing the previous successful sample.' : 'Refresh failed; showing the previous successful sample.'}
                    </p>
                  )}
                </div>
                <a
                  href={address ? `${explorerUrl}/address/${address}` : explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#2a403b] px-3 py-2 text-[10px] font-semibold text-emerald-200 transition hover:border-emerald-300/40 hover:bg-emerald-300/[.045]"
                >
                  View All on ArcScan <ExternalLink size={12} aria-hidden="true" />
                </a>
              </div>
              {!isConnected ? (
                <p className="px-5 py-10 text-center text-sm text-slate-500">Connect a wallet to view recent activity.</p>
              ) : !hasTransactionSample && transactionsQuery.isFetching ? (
                <p className="px-5 py-10 text-center text-sm text-slate-500">Loading recent ArcScan activity…</p>
              ) : !hasTransactionSample && transactionsQuery.isError ? (
                <p className="px-5 py-10 text-center text-sm text-rose-200">Recent transaction data is unavailable.</p>
              ) : !hasTransactionSample ? (
                <p className="px-5 py-10 text-center text-sm text-slate-500">Activity has not yet been scanned.</p>
              ) : transactions.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-slate-500">No transactions were returned for this recent page.</p>
              ) : (
                <div className="security-table-scroll min-w-0 overflow-x-auto">
                  <table className="w-full min-w-[980px] table-fixed text-left">
                    <thead className="border-b border-white/[.06] font-mono text-[9px] uppercase tracking-[.13em] text-slate-600">
                      <tr>
                        <th className="w-[13%] px-4 py-3 font-medium">Type</th>
                        <th className="w-[18%] px-4 py-3 font-medium">Hash / Details</th>
                        <th className="w-[21%] px-4 py-3 font-medium">Amount</th>
                        <th className="w-[21%] px-4 py-3 font-medium">To / From</th>
                        <th className="w-[11%] px-4 py-3 font-medium">Block</th>
                        <th className="w-[16%] px-4 py-3 font-medium">Time</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[.045]">
                      {transactions.slice(0, 12).map((transaction) => {
                        const isIncoming = transaction.category === 'Receive';
                        const isFailed = transaction.status === 'failed';
                        return (
                          <tr key={transaction.hash} className="text-xs hover:bg-white/[.018]">
                            <td className="px-4 py-3">
                              <span className={`inline-flex items-center gap-1.5 ${isFailed ? 'text-rose-200' : isIncoming ? 'text-cyan-200' : 'text-slate-300'}`}>
                                {isFailed ? <XCircle size={13} /> : isIncoming ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}
                                <span className="truncate">{transaction.category}</span>
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <a href={`${explorerUrl}/tx/${transaction.hash}`} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 font-mono text-[10px] text-cyan-200 hover:underline">
                                <span className="truncate">{shortAddr(transaction.hash)}</span>
                                <ExternalLink size={10} className="shrink-0" />
                              </a>
                              <p className={`mt-1 text-[9px] capitalize ${isFailed ? 'text-rose-300' : 'text-slate-600'}`}>{transaction.status}</p>
                            </td>
                            <td className="px-4 py-3">
                              <span className="block truncate font-mono text-[10px] text-slate-300">{formatTransactionAmount(transaction)}</span>
                            </td>
                            <td className="px-4 py-3">
                              <a href={addressUrl(isIncoming ? transaction.from : transaction.to)} target="_blank" rel="noreferrer" className="block truncate font-mono text-[10px] text-slate-400 hover:text-cyan-200" title={isIncoming ? transaction.from : transaction.to}>
                                {shortenAddress(isIncoming ? transaction.from : transaction.to)}
                              </a>
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 font-mono text-[10px] text-slate-500">{transaction.blockNumber ?? '—'}</td>
                            <td className="whitespace-nowrap px-4 py-3 text-[10px] text-slate-500">{formatTimestamp(transaction.timestamp)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </section>
        </section>

        <aside className="grid min-w-0 items-start gap-4 lg:grid-cols-2">
          <Card className="rounded-2xl border border-[#243331] bg-[#0b1212]/95 p-4 shadow-[0_14px_34px_rgba(0,0,0,.15)] sm:p-5">
            <PageAnchor id="risk-insights" />
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-slate-100">Observed Activity</h2>
                <p className="mt-1 text-xs text-slate-500">Counts from the latest ArcScan activity sample</p>
              </div>
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-300/[.08] text-cyan-200">
                <FileSearch size={15} aria-hidden="true" />
              </span>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <MetricRow icon={FileSearch} label="Transactions returned" value={countLabel(activityAvailable ? transactions.length : null, activityAvailable)} />
              <MetricRow icon={AlertTriangle} label="High-value outgoing" value={countLabel(activityAvailable ? largeOutgoing : null, activityAvailable)} tone={largeOutgoing > 0 ? 'amber' : 'slate'} />
              <MetricRow icon={XCircle} label="Failed transactions" value={countLabel(activityAvailable ? failedTransactions.length : null, activityAvailable)} tone={failedTransactions.length > 0 ? 'rose' : 'slate'} />
              <MetricRow icon={Fingerprint} label="Contract interactions" value={countLabel(activityAvailable ? contractInteractions.length : null, activityAvailable)} tone="cyan" />
              <p className="text-[10px] leading-4 text-slate-600 sm:col-span-2">
                Transactions classified as contract interactions in the latest ArcScan sample; this is not a count of individual calls or unique contracts.
              </p>
              <MetricRow icon={ArrowUpRight} label="Outgoing transfers" value={countLabel(activityAvailable ? outgoingTransferCount : null, activityAvailable)} />
              <MetricRow icon={ArrowDownRight} label="Incoming transfers" value={countLabel(activityAvailable ? incomingTransferCount : null, activityAvailable)} />
            </div>
            {transactionsQuery.isError && <p className="mt-3 text-[10px] text-rose-200">Activity metrics unavailable because ArcScan returned an error.</p>}
          </Card>

          <Card className="min-w-0 rounded-2xl border border-[#243331] bg-[#0b1212]/95 p-4 shadow-[0_14px_34px_rgba(0,0,0,.15)] sm:p-5">
            <PageAnchor id="security-recommendations" />
            <div className="flex items-start gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-300/[.08] text-emerald-200">
                <ShieldAlert size={16} aria-hidden="true" />
              </span>
              <div>
                <h2 className="text-base font-semibold text-slate-100">Security Recommendations</h2>
                <p className="mt-1 text-xs leading-5 text-slate-500">Guidance based only on scan results currently available.</p>
              </div>
            </div>
            <div className="mt-4 space-y-2.5">
              {recommendations.map((recommendation) => {
                const Icon = recommendation.icon;
                const recommendationTone = {
                  amber: 'text-amber-200',
                  slate: 'text-slate-400',
                  cyan: 'text-cyan-200',
                }[recommendation.tone];
                return (
                  <article key={recommendation.title} className="rounded-xl border border-white/[.055] bg-[#0c1414]/70 p-3">
                    <div className="flex items-start gap-2.5">
                      <span className={`mt-0.5 ${recommendationTone}`}>
                        <Icon size={14} aria-hidden="true" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <h3 className="text-xs font-semibold text-slate-200">{recommendation.title}</h3>
                        <p className="mt-1 text-[10px] leading-[1.55] text-slate-500">{recommendation.detail}</p>
                        {recommendation.available && recommendation.action && (
                          <button
                            type="button"
                            onClick={recommendation.onClick}
                            className="mt-2 inline-flex items-center gap-1 text-[10px] font-medium text-emerald-200 hover:text-emerald-100"
                          >
                            {recommendation.action} <ChevronRight size={11} />
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </Card>

          <Card className="min-w-0 rounded-2xl border border-[#243331] bg-[#0b1212]/95 p-4 shadow-[0_14px_34px_rgba(0,0,0,.12)] lg:col-span-2 sm:p-5">
            <h2 className="text-xs font-semibold text-slate-200">Coverage & verification</h2>
            <div className="mt-3 grid gap-3 text-[10px] leading-5 text-slate-500 sm:grid-cols-3">
              <p>Approval coverage applies only to the selected block window for configured tokens; it is not complete historical wallet coverage. Successful ranges are cached locally; uncovered ranges are retried on refresh.</p>
              <p>Activity uses the latest ArcScan sample (up to 20 transactions and transfer records). Unverified contract metadata is informational and does not mean a contract is malicious.</p>
              <p>A completed window can be labeled Window assessed; older or unsupported approvals are not included.</p>
            </div>
            <div className="mt-3 flex items-center gap-2 border-t border-white/[.055] pt-3 text-[10px] text-slate-500">
              {assessment.status === 'Window assessed' ? (
                <><ShieldCheck size={13} className="text-emerald-300" /> Selected approval window assessed · older history excluded</>
              ) : (
                <><CircleHelp size={13} className="text-amber-200" /> {assessment.status}</>
              )}
            </div>
            <div className="mt-3 flex items-center gap-2 text-[10px] text-slate-500">
              <ChainLogo chainId={ARC_TESTNET.id} className="h-3.5 w-3.5" />
              Arc Testnet · {address ? shortenAddress(address) : 'Wallet not connected'}
            </div>
          </Card>
        </aside>
      </div>
    </main>
  );
}

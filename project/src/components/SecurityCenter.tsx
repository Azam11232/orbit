import { useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
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
  Gauge,
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
  calculateSecurityScore,
  canRevokeApproval,
  countLargeOutgoingTransfers,
  summarizeApprovalScanErrors,
  type ApprovalRisk,
  type TokenApproval,
} from '../services/security';
import { formatTransactionDate, shortAddr } from '../services/transactions';
import { Button, Card, ChainLogo, Pill, TokenIcon } from './ui';

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

function PageAnchor({ id }: { id: string }) {
  return <span id={id} className="relative -top-3 block scroll-mt-6" aria-hidden="true" />;
}

export function SecurityCenter() {
  const { address, isConnected, chainId } = useAccount();
  const approvalsQuery = useApprovals(true);
  const transactionsQuery = useTransactions(
    address,
    isConnected && chainId === arcTestnet.id && Boolean(address),
    chainId,
    false,
    true,
  );
  const { revoke, activeApprovalId, status: revokeStatus, transactionHash, error: revokeError } = useRevokeApproval();
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<ApprovalStatusFilter>('all');
  const [riskFilter, setRiskFilter] = useState<ApprovalRiskFilter>('all');
  const [activeTab, setActiveTab] = useState('token-approvals');
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [showTechnicalErrors, setShowTechnicalErrors] = useState(false);

  const approvals = useMemo(() => approvalsQuery.data?.approvals ?? [], [approvalsQuery.data]);
  const transactions = transactionsQuery.transactions;
  const connectedToArc = isConnected && chainId === ARC_TESTNET.id && Boolean(address);
  const approvalAvailable = approvalsQuery.data !== undefined && !approvalsQuery.isError;
  const activityAvailable = transactionsQuery.lastScannedAt !== null && !transactionsQuery.isError;
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
  const scannedToBlock = approvalsQuery.data?.scannedToBlock.toString() ?? '—';

  const scoreIsComplete = Boolean(
    connectedToArc &&
    approvalsQuery.data?.isComplete &&
    activityAvailable &&
    transactions.every((transaction) => transaction.status !== 'unknown') &&
    !approvalsQuery.isFetching &&
    !transactionsQuery.isFetching &&
    !approvalsQuery.isError &&
    !transactionsQuery.isError,
  );
  const score = address
    ? calculateSecurityScore({
        approvals,
        transactions,
        walletAddress: address,
        isComplete: scoreIsComplete,
      })
    : null;
  const scanHasErrors = Boolean(
    approvalsQuery.isError ||
    transactionsQuery.isError ||
    approvalsQuery.data?.errors.length ||
    (approvalsQuery.data && !approvalsQuery.data.isComplete),
  );
  const completedAt = Math.max(
    approvalsQuery.data?.lastScannedAt ?? 0,
    transactionsQuery.lastScannedAt ?? 0,
  );
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
          : approvalsQuery.data?.isComplete
            ? 'No active allowances were observed in the completed configured-token scan.'
            : 'No active allowances were returned, but scan coverage is incomplete.'
        : 'Approval state is unavailable until the scan succeeds.',
      tone: activeApprovals.length > 0 ? 'amber' as const : 'slate' as const,
      action: approvalAvailable && activeApprovals.length > 0 ? 'Review approvals' : null,
      onClick: () => {
        setStatusFilter('active');
        jumpTo('token-approvals');
      },
      available: approvalAvailable && activeApprovals.length > 0,
    },
    {
      icon: AlertTriangle,
      title: 'Review unlimited allowances',
      detail: approvalAvailable
        ? unlimitedApprovals.length > 0
          ? `${unlimitedApprovals.length} unlimited allowance${unlimitedApprovals.length === 1 ? '' : 's'} observed; review whether each is still needed.`
          : approvalsQuery.data?.isComplete
            ? 'No unlimited allowance was observed in the completed configured-token scan.'
            : 'No unlimited allowance was returned, but the approval scan is incomplete.'
        : 'Unlimited allowance state is unavailable until the scan succeeds.',
      tone: unlimitedApprovals.length > 0 ? 'amber' as const : 'slate' as const,
      action: approvalAvailable && unlimitedApprovals.length > 0 ? 'Filter unlimited' : null,
      onClick: () => {
        setStatusFilter('active');
        setRiskFilter('High');
        jumpTo('token-approvals');
      },
      available: approvalAvailable && unlimitedApprovals.length > 0,
    },
    {
      icon: Fingerprint,
      title: 'Verify unknown contracts',
      detail: approvalAvailable
        ? hasVerificationIssues
          ? `${verificationIssues + tokenVerificationFailures} observed token/spender verification check${verificationIssues + tokenVerificationFailures === 1 ? '' : 's'} is unverified or unavailable. This is not a maliciousness verdict.`
          : approvals.length > 0
            ? 'All observed token and spender checks returned verified.'
            : 'No spender records were observed, so spender verification cannot be assessed.'
        : 'Contract verification could not be assessed without approval scan data.',
      tone: hasVerificationIssues || !approvalAvailable ? 'cyan' as const : 'slate' as const,
      action: approvalAvailable && hasVerificationIssues ? 'Inspect contracts' : null,
      onClick: () => jumpTo('token-approvals'),
      available: approvalAvailable && hasVerificationIssues,
    },
    {
      icon: ArrowUpRight,
      title: 'Keep an eye on large transfers',
      detail: activityAvailable
        ? largeOutgoing > 0
          ? `${largeOutgoing} outgoing transfer${largeOutgoing === 1 ? '' : 's'} at or above 100 USDC units in the recent activity sample.`
          : 'No outgoing transfer at or above 100 USDC units was observed in the recent activity sample.'
        : 'Recent transfer activity is unavailable.',
      tone: largeOutgoing > 0 ? 'amber' as const : 'slate' as const,
      action: activityAvailable && largeOutgoing > 0 ? 'Review activity' : null,
      onClick: () => jumpTo('transaction-analysis'),
      available: activityAvailable && largeOutgoing > 0,
    },
  ];

  const refreshScan = () => {
    void approvalsQuery.refetch();
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

  const confirmRevoke = async (approval: TokenApproval) => {
    if (!canRevokeApproval(approval)) return;
    const confirmed = window.confirm(
      `Revoke the ${approval.token.symbol} allowance for ${shortAddr(approval.spenderAddress)}? This will ask your wallet to submit an on-chain approval transaction.`,
    );
    if (!confirmed) return;
    await revoke(approval);
  };

  const jumpTo = (id: string) => {
    setActiveTab(id);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const tabs = [
    ['token-approvals', 'Token Approvals'],
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
                <Pill color={scanHasErrors ? 'amber' : scoreIsComplete ? 'green' : 'cyan'}>
                  {scanHasErrors ? 'PARTIAL SCAN' : scoreIsComplete ? 'COVERAGE COMPLETE' : 'SCAN STATUS UNKNOWN'}
                </Pill>
              </div>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-300/80">
                Check and manage your wallet security, token approvals, and recent activity on Arc Testnet.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
                <span className="inline-flex items-center gap-1.5">
                  <Clock3 size={12} aria-hidden="true" />
                  Last scanned: {completedAt > 0 ? new Date(completedAt).toLocaleString() : 'Not scanned'}
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
            disabled={!connectedToArc || approvalsQuery.isFetching || transactionsQuery.isFetching}
            className="shrink-0 self-start border-[#3a5a50] bg-[#0c1a17] text-emerald-100 hover:border-emerald-400/50 sm:self-center"
          >
            <RefreshCw
              size={14}
              className={approvalsQuery.isFetching || transactionsQuery.isFetching ? 'animate-spin' : ''}
              aria-hidden="true"
            />
            {approvalsQuery.isFetching || transactionsQuery.isFetching ? 'Refreshing scan' : 'Refresh Scan'}
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
        <div role="alert" className="rounded-xl border border-rose-400/20 bg-rose-400/[.045] px-4 py-3 text-xs text-rose-100">
          <p className="font-semibold">One or more security data sources failed. Results below may be incomplete.</p>
          {approvalsQuery.error && <p className="mt-1 break-words text-rose-200/80">Approval scan: {shortError(approvalsQuery.error.message)}</p>}
          {transactionsQuery.error && <p className="mt-1 break-words text-rose-200/80">ArcScan activity: {shortError(transactionsQuery.error.message)}</p>}
        </div>
      )}

      {approvalsQuery.data && approvalsQuery.data.errors.length > 0 && (
        <div className="rounded-xl border border-amber-300/20 bg-amber-300/[.035] px-4 py-3 text-xs text-amber-100">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-semibold">Partial approval coverage</p>
              <ul className="mt-1 space-y-1 text-amber-100/80">
                {summarizeApprovalScanErrors(approvalsQuery.data.errors).map((error) => <li key={error}>{error}</li>)}
              </ul>
            </div>
            <button
              type="button"
              className="rounded-md px-2 py-1 text-[10px] text-amber-100/70 underline decoration-amber-100/30 underline-offset-2 hover:text-amber-50"
              onClick={() => setShowTechnicalErrors((value) => !value)}
              aria-expanded={showTechnicalErrors}
            >
              {showTechnicalErrors ? 'Hide details' : `Technical details (${approvalsQuery.data.errors.length})`}
            </button>
          </div>
          {showTechnicalErrors && (
            <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto border-t border-amber-100/10 pt-2 font-mono text-[10px] text-amber-100/65">
              {approvalsQuery.data.errors.map((error, index) => <li key={`${index}:${error}`}>{error}</li>)}
            </ul>
          )}
        </div>
      )}

      <section aria-label="Security overview" className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard icon={Gauge} label="Security Score" accent="bg-cyan-300/[.09] text-cyan-200">
          <div className="flex items-center gap-3">
            <div
              className="security-score-gauge grid h-[58px] w-[58px] shrink-0 place-items-center rounded-full"
              style={{ '--security-score': score ?? 0 } as CSSProperties}
              aria-label={score === null ? 'Security score unknown' : `Security score ${score} out of 100`}
              role="img"
            >
              <span className="grid h-[46px] w-[46px] place-items-center rounded-full bg-[#0b1212] font-mono text-[15px] font-semibold tabular-nums text-white">
                {score ?? '—'}
              </span>
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-100">
                {score === null ? 'Unknown' : score >= 70 ? 'Lower observed risk' : score >= 40 ? 'Review advised' : 'Elevated observed risk'}
              </p>
              <p className="mt-1 text-[11px] leading-4 text-slate-500">
                {score === null ? 'Required checks or coverage incomplete' : 'Based on completed checks only'}
              </p>
            </div>
          </div>
        </SummaryCard>

        <SummaryCard icon={Shield} label="Active Approvals" accent="bg-emerald-300/[.09] text-emerald-200">
          <div className="flex items-baseline gap-2">
            <p className="font-mono text-[27px] font-semibold leading-none tabular-nums text-white">
              {approvalAvailable ? activeApprovals.length : '—'}
            </p>
            <span className="text-[11px] text-slate-500">
              {approvalAvailable ? approvalsQuery.data?.isComplete ? 'observed' : 'observed · partial' : 'unavailable'}
            </span>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            {approvalAvailable
              ? `${unlimitedApprovals.length} unlimited · ${finiteHighApprovals.length} high finite`
              : 'No confirmed count'}
          </p>
        </SummaryCard>

        <SummaryCard icon={AlertTriangle} label="Unlimited Allowances" accent="bg-amber-300/[.09] text-amber-200">
          <div className="flex items-baseline gap-2">
            <p className="font-mono text-[27px] font-semibold leading-none tabular-nums text-white">
              {approvalAvailable ? unlimitedApprovals.length : '—'}
            </p>
            <span className={`text-[11px] ${unlimitedApprovals.length > 0 ? 'text-amber-200' : 'text-slate-500'}`}>
              {approvalAvailable
                ? unlimitedApprovals.length > 0 ? 'review recommended' : approvalsQuery.data?.isComplete ? 'none observed' : 'partial data'
                : 'unknown'}
            </span>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            {approvalAvailable ? `${finiteHighApprovals.length} high finite allowance${finiteHighApprovals.length === 1 ? '' : 's'} observed` : 'Requires a successful approval scan'}
          </p>
        </SummaryCard>

        <SummaryCard icon={FileSearch} label="Scan Status" accent="bg-cyan-300/[.09] text-cyan-200">
          <p className="text-sm font-semibold text-slate-100">
            {approvalsQuery.isFetching || transactionsQuery.isFetching
              ? 'Scanning'
              : approvalsQuery.isError || transactionsQuery.isError
                ? 'Failed'
                : !approvalsQuery.data && !activityAvailable
                  ? connectedToArc ? 'Not yet scanned' : 'Not connected'
                  : scoreIsComplete ? 'Complete' : 'Incomplete'}
          </p>
          <p className="mt-1 text-[11px] leading-4 text-slate-500">
            {approvalsQuery.data
              ? `Block ${approvalsQuery.data.scannedFromBlock.toString()}–${approvalsQuery.data.scannedToBlock.toString()} · ${approvalsQuery.data.isComplete ? 'full configured history' : 'bounded coverage'}`
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

      <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(300px,.9fr)]">
        <section className="min-w-0 space-y-4">
          <PageAnchor id="token-approvals" />
          <Card className="min-w-0 overflow-hidden rounded-2xl border border-[#243331] bg-[#0b1212]/95 shadow-[0_14px_34px_rgba(0,0,0,.15)]">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/[.06] px-4 py-4 sm:px-5">
              <div>
                <h2 className="text-base font-semibold tracking-tight text-slate-100">Token Approvals</h2>
                <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500">
                  Allowances observed from configured Arc Testnet token Approval events; a partial scan never implies zero approvals.
                </p>
              </div>
              {approvalsQuery.data && (
                <Pill color={approvalsQuery.data.isComplete ? 'green' : 'amber'}>
                  {approvalsQuery.data.isComplete ? 'COVERAGE COMPLETE' : 'PARTIAL COVERAGE'}
                </Pill>
              )}
            </div>

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
                Allowance revoke confirmed.{' '}
                <a href={`${explorerUrl}/tx/${transactionHash}`} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                  View transaction
                </a>
              </p>
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
            ) : approvalsQuery.isFetching ? (
              <p className="px-5 py-12 text-center text-sm text-slate-400">Reading configured token approvals…</p>
            ) : approvalsQuery.isError ? (
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
                          <p className="mt-1 truncate text-[9px] text-slate-600">Checked at block {scannedToBlock}</p>
                        </td>
                        <td className="px-4 py-3.5">
                          <Pill color={riskColor(approval.risk)}>{approval.risk}</Pill>
                        </td>
                        <td className="px-4 py-3.5 font-mono text-[10px] text-slate-500">
                          Block {approval.lastSeenBlock.toString()}
                        </td>
                        <td className="px-4 py-3.5 text-right">
                          <button
                            type="button"
                            onClick={() => void confirmRevoke(approval)}
                            disabled={revokeStatus === 'pending' || !canRevokeApproval(approval)}
                            title={!canRevokeApproval(approval) ? 'Only verified token and spender contracts can be revoked here' : 'Revoke allowance'}
                            className="rounded-lg border border-rose-300/20 bg-rose-300/[.045] px-2.5 py-1.5 text-[10px] font-semibold text-rose-100 transition hover:border-rose-300/45 hover:bg-rose-300/[.1] disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {revokeStatus === 'pending' && activeApprovalId === approval.id
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
            {copyError && <p role="status" className="border-t border-white/[.055] px-5 py-2 text-[10px] text-amber-200">{copyError}</p>}
            {approvalsQuery.data && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[.055] px-4 py-3 text-[10px] text-slate-500 sm:px-5">
                <span>{approvals.length} observed spender record{approvals.length === 1 ? '' : 's'} · checked at block {approvalsQuery.data.scannedToBlock.toString()}</span>
                <span>{approvalsQuery.data.isComplete ? 'All configured scan ranges succeeded' : 'Coverage incomplete; results are not a full inventory'}</span>
              </div>
            )}
          </Card>

          <PageAnchor id="recent-transactions" />
          <section id="transaction-analysis" aria-labelledby="recent-transactions-heading" className="security-section-anchor">
            <Card className="min-w-0 overflow-hidden rounded-2xl border border-[#243331] bg-[#0b1212]/95 shadow-[0_14px_34px_rgba(0,0,0,.15)]">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[.06] px-4 py-4 sm:px-5">
                <div>
                  <h2 id="recent-transactions-heading" className="text-base font-semibold text-slate-100">Recent Transactions</h2>
                  <p className="mt-1 text-xs text-slate-500">Latest ArcScan transaction page for this wallet; not a complete lifetime history.</p>
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
              ) : transactionsQuery.isFetching ? (
                <p className="px-5 py-10 text-center text-sm text-slate-500">Loading recent ArcScan activity…</p>
              ) : transactionsQuery.isError ? (
                <p className="px-5 py-10 text-center text-sm text-rose-200">Recent transaction data is unavailable.</p>
              ) : !activityAvailable ? (
                <p className="px-5 py-10 text-center text-sm text-slate-500">Activity has not yet been scanned.</p>
              ) : transactions.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-slate-500">No transactions were returned for this recent page.</p>
              ) : (
                <div className="security-table-scroll min-w-0 overflow-x-auto">
                  <table className="w-full min-w-[760px] table-fixed text-left">
                    <thead className="border-b border-white/[.06] font-mono text-[9px] uppercase tracking-[.13em] text-slate-600">
                      <tr>
                        <th className="w-[17%] px-4 py-3 font-medium">Type</th>
                        <th className="w-[20%] px-4 py-3 font-medium">Hash / Details</th>
                        <th className="w-[24%] px-4 py-3 font-medium">Amount</th>
                        <th className="w-[18%] px-4 py-3 font-medium">To / From</th>
                        <th className="w-[10%] px-4 py-3 font-medium">Block</th>
                        <th className="w-[11%] px-4 py-3 font-medium">Time</th>
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
                            <td className="px-4 py-3 font-mono text-[10px] text-slate-500">{transaction.blockNumber ?? '—'}</td>
                            <td className="px-4 py-3 text-[10px] text-slate-500">{formatTimestamp(transaction.timestamp)}</td>
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

        <aside className="min-w-0 space-y-4">
          <PageAnchor id="risk-insights" />
          <Card className="rounded-2xl border border-[#243331] bg-[#0b1212]/95 p-4 shadow-[0_14px_34px_rgba(0,0,0,.15)] sm:p-5">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-slate-100">Observed Activity</h2>
                <p className="mt-1 text-xs text-slate-500">Counts from the latest ArcScan activity sample</p>
              </div>
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-300/[.08] text-cyan-200">
                <FileSearch size={15} aria-hidden="true" />
              </span>
            </div>
            <div className="mt-4 space-y-2">
              <MetricRow icon={FileSearch} label="Transactions returned" value={countLabel(activityAvailable ? transactions.length : null, activityAvailable)} />
              <MetricRow icon={AlertTriangle} label="High-value outgoing" value={countLabel(activityAvailable ? largeOutgoing : null, activityAvailable)} tone={largeOutgoing > 0 ? 'amber' : 'slate'} />
              <MetricRow icon={XCircle} label="Failed transactions" value={countLabel(activityAvailable ? failedTransactions.length : null, activityAvailable)} tone={failedTransactions.length > 0 ? 'rose' : 'slate'} />
              <MetricRow icon={Fingerprint} label="Contract interactions" value={countLabel(activityAvailable ? contractInteractions.length : null, activityAvailable)} tone="cyan" />
              <MetricRow icon={ArrowUpRight} label="Outgoing transfers" value={countLabel(activityAvailable ? outgoingTransferCount : null, activityAvailable)} />
              <MetricRow icon={ArrowDownRight} label="Incoming transfers" value={countLabel(activityAvailable ? incomingTransferCount : null, activityAvailable)} />
            </div>
            {transactionsQuery.isError && <p className="mt-3 text-[10px] text-rose-200">Activity metrics unavailable because ArcScan returned an error.</p>}
          </Card>

          <PageAnchor id="security-recommendations" />
          <Card className="rounded-2xl border border-[#243331] bg-[#0b1212]/95 p-4 shadow-[0_14px_34px_rgba(0,0,0,.15)] sm:p-5">
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

          <Card className="rounded-2xl border border-[#243331] bg-[#0b1212]/95 p-4 shadow-[0_14px_34px_rgba(0,0,0,.12)]">
            <h2 className="text-xs font-semibold text-slate-200">Coverage & verification</h2>
            <div className="mt-3 space-y-2 text-[10px] leading-5 text-slate-500">
              <p>Approval history is limited to the configured tokens and bounded Arc RPC history. Successful ranges are cached locally; uncovered ranges are retried on refresh.</p>
              <p>Activity shows only the latest ArcScan page. Unverified or unavailable contract metadata is informational and does not mean a contract is malicious.</p>
              <p>Security score remains Unknown unless approval coverage, required checks, and recent activity status are sufficient.</p>
            </div>
            <div className="mt-3 flex items-center gap-2 border-t border-white/[.055] pt-3 text-[10px] text-slate-500">
              {approvalsQuery.data?.isComplete && activityAvailable ? (
                <><ShieldCheck size={13} className="text-emerald-300" /> Required data sources available</>
              ) : (
                <><CircleHelp size={13} className="text-amber-200" /> At least one required check is incomplete</>
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

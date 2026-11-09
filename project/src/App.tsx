import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import {
  useAccount,
  useBalance,
  useConnect,
  useDisconnect,
  useSwitchChain,
} from "wagmi";
import { arcTestnet, base } from "wagmi/chains";
import { formatEther, formatUnits, isAddress, parseUnits, type Address, type Hash } from "viem";
import { getPortfolioAnalytics, getPortfolioAssetCountState, getPortfolioUsdStatusLabel, usePortfolio } from "./hooks/usePortfolio";
import { useApprovals } from "./hooks/useApprovals";
import { useRevokeApproval } from "./hooks/useRevokeApproval";
import { useSendTransaction, validateSendRequest } from "./hooks/useSendTransaction";
import { createFreshSendFormState, isCurrentSendFlow, shouldShowSendSuccess } from "./services/sendLifecycle";
import { useTokenBalance } from "./hooks/useTokenBalance";
import { useSwapQuote } from "./hooks/useSwapQuote";
import { useSwapApproval } from "./hooks/useSwapApproval";
import { useSwapExecution } from "./hooks/useSwapExecution";
import { useBridgeTokens } from "./hooks/useBridgeTokens";
import { useBridgeBalance } from "./hooks/useBridgeBalance";
import { getBridgeNativeGasRequirement, getBridgeQuoteFreshnessState, isBridgeNativeGasReady, isBridgeQuoteCurrent, isBridgeReviewable, isSameBridgeQuoteSnapshot, useBridgeQuote } from "./hooks/useBridgeQuote";
import { getBridgeApprovalActionState, getBridgeApprovalRequest, useBridgeApproval } from "./hooks/useBridgeApproval";
import { canShowBridgeSuccess, getBridgeSelectedRoute, getCompactBridgeProgressSteps, getCompactBridgeStatus, getRequiredBridgeChainId, isBridgeExecutionStarted, shouldResetBridgeAmount, shouldResetBridgeExecution, shouldShowBridgeSourceConfirmation, shouldShowBridgeWrongNetwork, shouldShowCctpDestinationMintAction, type BridgeExecutionStatus, useBridgeExecution } from "./hooks/useBridgeExecution";
import { beginArcForwardingTiming, getBridgeQuoteTiming, markArcForwardingTiming, type ArcForwardingTiming } from "./services/bridge/arcForwardingTiming";
import { useTransactions } from "./hooks/useTransactions";
import { useOrbitSettings } from "./hooks/useOrbitSettings";
import { useWatchlist, type WatchlistItem } from "./hooks/useWatchlist";
import { formatTransactionDate, getTimeAgo, shortAddr, explorerTxUrl, type ChainTransaction, type TxStatus } from "./services/transactions";
import { calculateSecurityScore, canRevokeApproval, countLargeOutgoingTransfers, getApprovalCoveragePercent, getSecurityAssessment, getApprovalScanStatus, summarizeApprovalScanErrors, type TokenApproval } from "./services/security";
import { getSecurityNavigationTarget } from "./services/securityNavigation";
import { ARC_USDC, BASE_ASSETS, BASE_SWAP_ASSETS } from "./data/tokens";
import { ARC_PRIMARY_NETWORK, ARC_TESTNET, CCTP_BRIDGE_NETWORKS, ETHEREUM_SEPOLIA, ORBIT_NETWORKS, getOrbitNetwork } from "./data/networks";
import { usePrices } from "./hooks/usePrices";
import { PORTFOLIO_PRICES } from "./services/prices";
import type { BridgeChain, BridgeQuote } from "./types/bridge";
import { QRCodeSVG } from "qrcode.react";
import {
  Activity,
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Bell,
  BookOpen,
  ChevronRight,
  CircleDollarSign,
  Compass,
  Copy,
  Crosshair,
  ExternalLink,
  Landmark,
  LayoutDashboard,
  LockKeyhole,
  Menu,
  Moon,
  MoreHorizontal,
  Network,
  Radar,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  TrendingUp,
  Wallet,
  X,
} from "lucide-react";
import {
  Card,
  Button,
  ChainLogo,
  Label,
  Pill,
  TokenIcon,
} from "./components/ui";
import { ArcPayPage } from "./components/ArcPayPage";
import { ArcSwapPage } from "./components/ArcSwapPage";
import { TransactionSuccessScreen } from "./components/TransactionSuccessScreen";
import { SlideToConfirm } from "./components/SlideToConfirm";
import { UnifiedBalancePage } from "./components/UnifiedBalancePage";
import { SecurityCenter } from "./components/SecurityCenter";
import { OrbitBrand } from "./components/OrbitBrand";
import type { ArcPaymentRequest } from "./services/arcPayment";
import { useDiscover } from "./hooks/useDiscover";
import { getPreferredConnector, supportedChains } from "./wallet";

type Page =
  | "home"
  | "portfolio"
  | "activity"
  | "settings"
  | "security"
  | "approvals"
  | "swap"
  | "unified-balance"
  | "bridge"
  | "discover"
  | "watchlist"
  | "send"
  | "receive"
  | "arc-pay"
  | "about";

type OrbitTheme = "dark" | "light";

function Space({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#020817] text-slate-100">
      <div className="space-shell">
        <div className="space-grid" />
        <div className="space-stars" />
        <div className="space-flow space-flow-a" />
        <div className="space-flow space-flow-b" />
        <div className="space-glow space-glow-left" />
        <div className="space-glow space-glow-right" />
        <div className="space-glow space-glow-bottom" />
        <div className="space-vignette" />
        {children}
      </div>
    </div>
  );
}

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      {compact ? (
        <OrbitBrand compact variant="light" className="h-8 w-8 shrink-0" />
      ) : (
        <OrbitBrand variant="light" className="h-8 w-auto shrink-0" />
      )}
    </div>
  );
}
function shortAddress(address?: string) {
  return address
    ? `${address.slice(0, 6)}...${address.slice(-4)}`
    : "Not connected";
}
export function bridgeExplorerUrl(chainId: number, hash: string) {
  const explorers: Record<number, string> = {
    1: "https://etherscan.io/tx/",
    10: "https://optimistic.etherscan.io/tx/",
    8453: "https://basescan.org/tx/",
    5042002: "https://testnet.arcscan.app/tx/",
    11155111: "https://sepolia.etherscan.io/tx/",
    84532: "https://sepolia.basescan.org/tx/",
    421614: "https://sepolia.arbiscan.io/tx/",
    11155420: "https://sepolia-optimism.etherscan.io/tx/",
    43113: "https://testnet.snowtrace.io/tx/",
    80002: "https://amoy.polygonscan.com/tx/",
    42161: "https://arbiscan.io/tx/",
  };
  return explorers[chainId] ? `${explorers[chainId]}${hash}` : null;
}

export function getBridgeRouteLabel(selectedRoute?: 'forwarding' | 'cctp') {
  return selectedRoute === 'forwarding' ? 'Circle Forwarding' : 'Standard CCTP V2';
}

export function isBridgeAllowanceVerifiedForAmount(allowance: bigint, requiredAmount: bigint, isAllowanceLoading: boolean) {
  if (isAllowanceLoading) return false;
  return allowance >= requiredAmount;
}
export function getBridgeSuccessDestinationHash(
  executionHash?: Hash,
  statusHash?: string,
  statusChainId?: number,
  expectedDestinationChainId?: number,
) {
  if (executionHash) return executionHash;
  return expectedDestinationChainId !== undefined &&
    statusChainId === expectedDestinationChainId &&
    /^0x[a-f\d]{64}$/i.test(statusHash ?? '')
    ? statusHash as Hash
    : undefined;
}

export function shouldShowBridgeApprovalAction(input: { status: BridgeExecutionStatus; sourceHash?: Hash; approvalRequired: boolean; sourceSubmissionAttempted?: boolean }) {
  if (!input.approvalRequired) return false;
  return !input.sourceSubmissionAttempted && !isBridgeExecutionStarted(input.status, input.sourceHash);
}

export function shouldShowBridgeReviewAction(input: { status: BridgeExecutionStatus; sourceHash?: Hash; approvalRequired: boolean; bridgeReady: boolean; sourceSubmissionAttempted?: boolean }) {
  return !input.approvalRequired && !input.sourceSubmissionAttempted && !isBridgeExecutionStarted(input.status, input.sourceHash) && input.bridgeReady;
}

function formatRefreshMode(mode: "manual" | "balanced" | "live") {
  return mode === "manual" ? "Manual" : mode === "balanced" ? "Balanced" : "Live";
}

function getWalletBrandIcon(name: string, id: string, icon?: string) {
  const normalizedName = name.toLowerCase();
  const normalizedId = id.toLowerCase();

  if (normalizedId === "coinbasewallet" || normalizedName.includes("coinbase")) {
    return `data:image/svg+xml;utf8,${encodeURIComponent(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">
        <defs>
          <linearGradient id="coinbaseGradient" x1="0%" x2="100%" y1="0%" y2="100%">
            <stop offset="0%" stop-color="#1A7FFF"/>
            <stop offset="100%" stop-color="#0052FF"/>
          </linearGradient>
        </defs>
        <circle cx="40" cy="40" r="32" fill="url(#coinbaseGradient)"/>
        <path d="M56 28.2c-6.2-5.7-15.9-6.2-23.4-1.9-6.1 3.5-10.1 10.2-10.1 17.7 0 11.4 9.3 20.7 20.7 20.7 8.5 0 15.7-5.6 18.6-13.3l-7.7-2.3c-1.9 3.9-6 6.5-10.6 6.2-6-.5-10.6-5.4-10.6-11.4 0-6.2 5.1-11.1 11.3-11.1 4.1 0 7.9 2.2 9.8 5.9l7.9-2.4Z" fill="#fff"/>
      </svg>
    `)}`;
  }

  if (normalizedId === "injected" || normalizedName.includes("injected")) {
    return `data:image/svg+xml;utf8,${encodeURIComponent(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">
        <rect x="16" y="18" width="48" height="42" rx="12" fill="#0F172A" stroke="#38BDF8" stroke-width="3"/>
        <path d="M25 30h30v22H25z" fill="#0EA5E9" opacity="0.18"/>
        <path d="M40 28v8m-4-4h8M30 42c0-5.5 4.5-10 10-10s10 4.5 10 10-4.5 10-10 10-10-4.5-10-10Z" fill="none" stroke="#E2E8F0" stroke-width="3" stroke-linecap="round"/>
        <path d="M40 42v10m-5-5h10" stroke="#E2E8F0" stroke-width="3" stroke-linecap="round"/>
      </svg>
    `)}`;
  }

  return icon;
}

function WalletButton({ className = "" }: { className?: string }) {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const [walletPickerOpen, setWalletPickerOpen] = useState(false);
  const connector = getPreferredConnector(connectors);

  const orderedConnectors = [...connectors].sort((a, b) => {
    const aInjected = a.id === "injected" ? 1 : 0;
    const bInjected = b.id === "injected" ? 1 : 0;
    return aInjected - bInjected;
  });
  const visibleConnectors = orderedConnectors.filter((candidate) => {
    const label = `${candidate.id} ${candidate.name}`.toLowerCase();
    return !label.includes('coinbase') && !label.includes('injected');
  });
  const popularConnectors = visibleConnectors.filter((candidate) => /metamask|phantom|okx|backpack/i.test(`${candidate.id} ${candidate.name}`));
  const installedConnectors = visibleConnectors.filter((candidate) => !popularConnectors.includes(candidate));

  const handleConnectClick = () => {
    if (isPending) return;

    if (!connectors.length) {
      setWalletPickerOpen(true);
      return;
    }

    if (connectors.length === 1) {
      connect({ connector: connectors[0] });
      return;
    }

    setWalletPickerOpen(true);
  };

  if (isConnected)
    return (
      <button
        onClick={() => disconnect()}
        className={`flex items-center gap-2 rounded-xl border border-emerald-300/20 bg-emerald-300/10 px-3 py-2.5 text-xs font-bold text-emerald-200 transition hover:bg-emerald-300/15 ${className}`}
      >
        {shortAddress(address)}
      </button>
    );

  return (
    <>
      <Button
        onClick={handleConnectClick}
        className={className}
        disabled={isPending}
      >
        {isPending ? "Connecting..." : "Connect Wallet"}
      </Button>

      {walletPickerOpen && createPortal(
        <div className="orbit-wallet-picker-overlay fixed inset-0 z-[3000] flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-sm" onClick={() => setWalletPickerOpen(false)}>
          <div className="orbit-wallet-picker-dialog grid w-full max-w-4xl overflow-hidden rounded-[2rem] border border-slate-700/80 bg-slate-950/95 shadow-[0_30px_100px_rgba(2,6,23,0.72)] lg:grid-cols-[1.05fr_0.95fr]" onClick={(event) => event.stopPropagation()}>
            <section className="p-6 sm:p-8">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">ORBIT wallet</p>
                  <h3 className="mt-2 text-2xl font-bold tracking-tight text-white">Connect a Wallet</h3>
                </div>
                <button type="button" onClick={() => setWalletPickerOpen(false)} className="rounded-xl border border-slate-700 bg-slate-900 p-2 text-slate-300 transition hover:border-sky-400/40 hover:bg-slate-800 hover:text-white" aria-label="Close wallet picker"><X size={16} /></button>
              </div>
              {visibleConnectors.length === 0 ? (
                <div className="mt-8 rounded-2xl border border-slate-700 bg-slate-900/70 p-4 text-sm leading-6 text-slate-300">No supported wallet was detected. Install a compatible wallet and refresh this page.</div>
              ) : (
                <div className="mt-8 space-y-7">
                  {[['Installed', installedConnectors], ['Popular', popularConnectors]].map(([title, candidates]) => (
                    <div key={title as string}>
                      <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">{title as string}</p>
                      {candidates.length > 0 ? (
                        <div className="space-y-2">
                          {(candidates as typeof visibleConnectors).map((candidate) => (
                            <button key={candidate.uid ?? candidate.id} type="button" onClick={() => { setWalletPickerOpen(false); connect({ connector: candidate }); }} className="flex w-full items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/75 px-4 py-3 text-left transition hover:border-sky-400/40 hover:bg-slate-800">
                              <span className="flex min-w-0 items-center gap-3">
                                <img src={getWalletBrandIcon(candidate.name, candidate.id, candidate.icon)} alt={candidate.name} className="h-9 w-9 rounded-xl object-cover" />
                                <span className="min-w-0"><span className="block truncate text-sm font-semibold text-white">{candidate.name}</span><span className="mt-0.5 block truncate font-mono text-[9px] uppercase tracking-[0.12em] text-slate-500">{candidate.id}</span></span>
                              </span>
                              {candidate.id === connector?.id && <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.8)]" />}
                            </button>
                          ))}
                        </div>
                      ) : <p className="text-xs text-slate-600">No additional wallets detected.</p>}
                    </div>
                  ))}
                </div>
              )}
            </section>
            <section className="border-t border-slate-800 bg-slate-900/55 p-6 sm:p-8 lg:border-l lg:border-t-0">
              <div className="flex h-full flex-col">
                <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">Wallet basics</p>
                <div className="mt-7 flex h-16 w-16 items-center justify-center rounded-2xl border border-sky-300/20 bg-sky-300/10 text-sky-200 shadow-[0_0_32px_rgba(56,189,248,0.14)]"><Wallet size={30} /></div>
                <h4 className="mt-6 text-2xl font-bold tracking-tight text-white">What is a Wallet?</h4>
                <p className="mt-3 text-sm leading-6 text-slate-400">A wallet is a secure home for your digital assets and the approvals that let you use them onchain.</p>
                <div className="mt-8 border-t border-slate-800 pt-6"><h5 className="text-lg font-semibold text-white">A New Way to Log In</h5><p className="mt-2 text-sm leading-6 text-slate-400">Use your wallet to sign in to ORBIT without sharing a password or private key.</p></div>
                <div className="mt-auto flex flex-wrap items-center gap-4 pt-8"><a href="https://ethereum.org/en/wallets/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center rounded-xl bg-sky-400 px-4 py-2.5 text-xs font-bold text-slate-950 transition hover:bg-sky-300">Get a Wallet</a><a href="https://ethereum.org/en/wallets/" target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-sky-300 underline underline-offset-4 hover:text-sky-200">Learn More</a></div>
              </div>
            </section>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
function NetworkWarning() {
  const { chainId, isConnected } = useAccount();
  const { switchChain, isPending } = useSwitchChain();
  const isSupportedNetwork = supportedChains.some((chain) => chain.id === chainId);
  if (!isConnected || isSupportedNetwork) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-300/15 bg-amber-300/[.06] px-5 py-3 text-xs lg:px-8">
      <div className="flex items-center gap-2 text-amber-200">
        <ShieldCheck size={15} />
        <span>
            ORBIT requires Arc Testnet. Your wallet is on an unsupported network. Please switch to Arc Testnet.
        </span>
      </div>
      <button
        onClick={() => switchChain({ chainId: arcTestnet.id })}
        className="rounded-lg border border-amber-300/20 bg-amber-300/10 px-3 py-1.5 font-bold text-amber-200 transition hover:bg-amber-300/15"
      >
        {isPending ? "Switching..." : "Switch to Arc Testnet"}
      </button>
    </div>
  );
}
export function WalletBalanceStat() {
  const { address } = useAccount();
  const { data: balance, isLoading } = useBalance({
    address,
    chainId: base.id,
    query: { enabled: Boolean(address) },
  });
  if (!address)
    return (
      <>
        <p className="mt-5 text-2xl font-extrabold text-slate-400">
          Connect wallet
        </p>
        <p className="mt-2 text-xs text-slate-500">
          Live Base balance appears here
        </p>
      </>
    );
  return (
    <>
      <p className="mt-5 text-3xl font-extrabold tracking-tight">
        {isLoading ? (
          <span className="inline-block h-7 w-32 animate-pulse rounded bg-white/10" />
        ) : (
          `${Number(balance ? formatEther(balance.value) : 0).toFixed(4)}`
        )}{" "}
        <span className="text-xl text-slate-500">
          {balance?.symbol ?? "ETH"}
        </span>
      </p>
      <p className="mt-2 text-xs font-semibold text-cyan-300">
        Live balance <span className="font-normal text-slate-500">on Base</span>
      </p>
    </>
  );
}

function Landing({ onLaunch, onNavigate, theme, onThemeChange }: { onLaunch: () => void; onNavigate: (page: Page) => void; theme: OrbitTheme; onThemeChange: (theme: OrbitTheme) => void }) {
  return (
    <Space>
      <header className="relative z-20 mx-auto max-w-7xl px-6 py-7">
        <div className="flex w-full items-center gap-4 md:gap-6">
          <Logo />
          <nav className="hidden items-center justify-center gap-8 text-sm text-slate-300 md:flex md:flex-1">
            <a className="transition hover:text-white" href="#platform">
              Features
            </a>
            <button className="transition hover:text-white" onClick={() => { onLaunch(); onNavigate("security"); }}>
              Security
            </button>
            <button className="transition hover:text-white" onClick={() => { onLaunch(); onNavigate("about"); }}>
              About
            </button>
          </nav>
          <div role="group" aria-label="Color theme" className="orbit-theme-toggle ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border p-1 shadow-sm transition-colors md:ml-0">
            <button type="button" aria-label="Light mode" aria-pressed={theme === "light"} onClick={() => onThemeChange("light")} className={`orbit-theme-toggle__option flex h-7 w-7 items-center justify-center rounded-full transition-colors ${theme === "light" ? "is-active is-light-active" : ""}`}>
              <Sun size={14} aria-hidden="true" />
            </button>
            <button type="button" aria-label="Dark mode" aria-pressed={theme === "dark"} onClick={() => onThemeChange("dark")} className={`orbit-theme-toggle__option flex h-7 w-7 items-center justify-center rounded-full transition-colors ${theme === "dark" ? "is-active" : ""}`}>
              <Moon size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>
      <main className="relative z-10">
        <section className="mx-auto grid max-w-7xl items-center gap-10 px-6 pb-24 pt-16 sm:gap-14 lg:grid-cols-[1.05fr_1.15fr] lg:gap-20 lg:pb-28 lg:pt-12">
          <motion.div
            initial={{ opacity: 0, y: 28, filter: "blur(8px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
          >
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.12, ease: [0.22, 1, 0.36, 1] }}
            >
              <Pill color="cyan">
                <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_10px_#67e8f9]" />
                ONCHAIN INTELLIGENCE ONLINE
              </Pill>
            </motion.div>
            <h1 aria-label="Control Your Onchain Universe." className="mt-7 max-w-xl text-5xl font-extrabold leading-[0.98] tracking-[-.06em] text-white sm:text-6xl lg:text-[5rem]">
              <span aria-hidden="true" className="hero-reveal-line hero-reveal-line--first" data-text="Control Your">Control Your</span>
              <span aria-hidden="true" className="hero-reveal-line hero-reveal-line--second" data-text="Onchain">Onchain</span>
              <span aria-hidden="true" className="hero-reveal-line hero-reveal-line--third" data-text="Universe.">Universe.</span>
            </h1>
            <motion.p
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.42, ease: [0.22, 1, 0.36, 1] }}
              className="mt-7 max-w-lg text-lg leading-8 text-slate-300"
            >
              Everything you need to stay on top of your onchain world, all in one place.
            </motion.p>
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.54, ease: [0.22, 1, 0.36, 1] }}
              className="mt-9 flex flex-wrap gap-3"
            >
              <Button onClick={onLaunch} icon>
                Launch ORBIT
              </Button>
              <Button
                variant="secondary"
                icon
                onClick={() => {
                  onNavigate("home");
                  onLaunch();
                }}
              >
                Explore Platform
              </Button>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 22 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.64, ease: [0.22, 1, 0.36, 1] }}
              className="mt-12 flex flex-wrap items-center gap-8 text-xs text-slate-500"
            >
              <span>
                <b className="text-white">Arc Testnet</b> primary network
              </span>
              <span>
                <b className="text-white">CCTP V2</b> bridge routes
              </span>
            </motion.div>
          </motion.div>
          <OrbitalVisual />
        </section>
        <section id="platform" className="mx-auto max-w-7xl px-6 pb-28">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.35 }}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
            className="mb-10"
          >
            <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Everything onchain, in one place
            </h2>
          </motion.div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {[
              [
                "SEE",
                "Understand your onchain world.",
                LayoutDashboard,
                "cyan",
                "portfolio",
              ],
              [
                "MOVE",
                "Move assets across your wallet.",
                ArrowLeftRight,
                "violet",
                "bridge",
              ],
              [
                "PROTECT",
                "Monitor approvals and wallet security.",
                ShieldCheck,
                "green",
                "security",
              ],
              [
                "CONTROL",
                "Manage your wallet from one command center.",
                Compass,
                "amber",
                "unified-balance",
              ],
            ].map(([title, text, Icon, color, destination], i) => (
              <motion.button
                type="button"
                onClick={() => { onLaunch(); onNavigate(destination as Page); }}
                key={title as string}
                initial={{ opacity: 0, y: 26 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.3 }}
                transition={{ duration: 0.6, delay: i * 0.08, ease: [0.22, 1, 0.36, 1] }}
                whileHover={{ y: -6, scale: 1.01 }}
                className="glass group block w-full rounded-2xl p-6 text-left transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70"
              >
                <div
                  className={`mb-12 flex h-10 w-10 items-center justify-center rounded-xl ${color === "cyan" ? "bg-cyan-400/10 text-cyan-300 shadow-[0_0_30px_rgba(34,211,238,0.16)]" : color === "violet" ? "bg-violet-400/10 text-violet-300 shadow-[0_0_30px_rgba(168,85,247,0.16)]" : color === "green" ? "bg-emerald-400/10 text-emerald-300 shadow-[0_0_30px_rgba(52,211,153,0.16)]" : "bg-amber-400/10 text-amber-300 shadow-[0_0_30px_rgba(251,191,36,0.14)]"}`}
                >
                  <Icon size={20} />
                </div>
                <p className="font-mono text-[10px] tracking-[.18em] text-slate-500">
                  0{i + 1} / {title as string}
                </p>
                <h3 className="mt-3 text-lg font-bold text-white">{text as string}</h3>
                <ChevronRight
                  size={17}
                  className="mt-5 text-slate-600 transition duration-300 group-hover:translate-x-1 group-hover:text-cyan-300"
                />
              </motion.button>
            ))}
          </div>
        </section>
      </main>
      <footer className="relative z-10 border-t border-white/[.08] bg-slate-950/35 backdrop-blur-sm">
        <div className="mx-auto max-w-7xl px-6 py-9 sm:py-10">
          <div className="grid gap-8 border-b border-white/[.08] pb-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] lg:items-start lg:gap-10">
            <div>
              <Logo />
              <p className="mt-4 text-sm font-medium text-slate-300">Web3 Onchain Command Center</p>
              <p className="mt-1 text-sm text-slate-500">Understand. Move. Stay in control.</p>
            </div>
            <nav aria-label="Footer navigation" className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
              <a href="#platform" className="w-fit rounded-sm text-sm text-slate-400 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70">Features</a>
              <button type="button" onClick={() => { onLaunch(); onNavigate("portfolio"); }} className="w-fit rounded-sm text-left text-sm text-slate-400 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70">Portfolio</button>
              <button type="button" onClick={() => { onLaunch(); onNavigate("activity"); }} className="w-fit rounded-sm text-left text-sm text-slate-400 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70">Activity</button>
              <button type="button" onClick={() => { onLaunch(); onNavigate("bridge"); }} className="w-fit rounded-sm text-left text-sm text-slate-400 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70">Bridge</button>
              <button type="button" onClick={() => { onLaunch(); onNavigate("swap"); }} className="w-fit rounded-sm text-left text-sm text-slate-400 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70">Swap</button>
              <button type="button" onClick={() => { onLaunch(); onNavigate("security"); }} className="w-fit rounded-sm text-left text-sm text-slate-400 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70">Security</button>
            </nav>
            <div className="flex flex-col gap-2 lg:items-end">
              <span className="inline-flex items-center gap-2 rounded-full border border-amber-200/15 bg-amber-200/[.04] px-3 py-1.5 font-mono text-[10px] font-semibold tracking-[.14em] text-amber-100/80">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-200/80" />
                TESTNET ONLY
              </span>
              <p className="text-sm text-slate-500">Built for supported EVM testnets.</p>
            </div>
          </div>
          <div className="flex flex-col gap-2 pt-5 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
            <span>© 2026 ORBIT</span>
            <span>Built for the onchain era.</span>
          </div>
        </div>
      </footer>
    </Space>
  );
}
function OrbitalVisual() {
  const nodes = [
    { t: "Ethereum", x: "50%", y: "9%", c: "#627EEA", radius: 196, speed: 38, direction: 1 },
    { t: "Base", x: "91%", y: "39%", c: "#4B8BFF", radius: 208, speed: 31, direction: -1 },
    { t: "Arbitrum", x: "76%", y: "87%", c: "#28A0F0", radius: 182, speed: 42, direction: 1 },
    { t: "Optimism", x: "17%", y: "83%", c: "#FF4A4A", radius: 204, speed: 35, direction: -1 },
    { t: "Polygon", x: "8%", y: "35%", c: "#A855F7", radius: 190, speed: 30, direction: 1 },
  ];

  return (
    <div className="relative mx-auto aspect-square w-full max-w-[620px]">
      <div className="orbit-background" />
      <div className="orbit-bloom orbit-bloom-left" />
      <div className="orbit-bloom orbit-bloom-right" />
      <div className="orbit-ring orbit-ring-outer" />
      <div className="orbit-ring orbit-ring-mid" />
      <div className="orbit-ring orbit-ring-inner" />
      <div className="orbit-ring orbit-ring-deep" />

      {nodes.map((n) => (
        <div
          key={n.t}
          className="orbit-path"
          style={{ width: n.radius * 2 + 90, height: n.radius * 2 + 90 }}
        >
          <motion.div
            animate={{ rotate: n.direction === 1 ? 360 : -360 }}
            transition={{ duration: n.speed, repeat: Infinity, ease: "linear" }}
            className="h-full w-full"
          >
            <div className="orbit-node" style={{ transform: `translate(-50%, -50%) translateX(${n.radius}px)` }}>
              <span className="orbit-node__dot" style={{ background: n.c, boxShadow: `0 0 12px ${n.c}` }} />
              <span className="orbit-node__label">{n.t}</span>
            </div>
          </motion.div>
        </div>
      ))}

      <div className="orbit-core-anchor">
        <div className="orbit-core-shell">
          <div className="orbit-core-shell__ring orbit-core-shell__ring-a" />
          <div className="orbit-core-shell__ring orbit-core-shell__ring-b" />
          <div className="orbit-core-shell__ring orbit-core-shell__ring-c" />
          <div className="orbit-core-mark">
            <OrbitBrand variant="light" className="h-20 w-auto max-w-[10rem] drop-shadow-[0_0_22px_rgba(16,61,50,0.18)]" />
          </div>
        </div>
      </div>
    </div>
  );
}

const navGroups = [
  {
    title: "CORE",
    items: [
      ["home", "Home", LayoutDashboard],
      ["portfolio", "Portfolio", Wallet],
      ["activity", "Activity", Activity],
    ],
  },
  {
    title: "ACTIONS",
    items: [
      ["send", "Send", Send],
      ["receive", "Receive", ArrowDownLeft],
      ["bridge", "Bridge", Network],
      ["swap", "Swap", ArrowLeftRight],
      ["unified-balance", "Unified Balance", CircleDollarSign],
    ],
  },
  {
    title: "SECURITY",
    items: [
      ["security", "Security Center", ShieldCheck],
      ["approvals", "Approvals & Revoke", LockKeyhole],
    ],
  },
  {
    title: "EXPLORE",
    items: [
      ["discover", "Discover", Compass],
      ["about", "About", BookOpen],
    ],
  },
];

function Sidebar({
  page,
  setPage,
  open,
  setOpen,
}: {
  page: Page;
  setPage: (p: Page) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const { address, isConnected, chainId } = useAccount();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const activeNetwork = supportedChains.find((network) => network.id === chainId);

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-40 flex h-screen w-64 shrink-0 flex-col border-r border-slate-700/80 bg-slate-950/95 px-4 py-5 shadow-[0_32px_80px_rgba(2,6,23,0.65)] backdrop-blur-xl transition-all duration-300 lg:sticky lg:top-0 lg:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}
    >
      <div className="flex items-center justify-between px-3 pb-2">
        <div className="flex items-center gap-2">
          <Logo />
        </div>
        <button
          className="rounded-xl border border-slate-700 bg-slate-900 p-1.5 text-slate-300 lg:hidden"
          onClick={() => setOpen(false)}
        >
          <X size={18} />
        </button>
      </div>
      <div className="mt-2 flex-1 min-h-0 overflow-y-auto pr-1">
        <div className="space-y-4">
          {navGroups.map((g) => (
            <div key={g.title}>
              <Label>{g.title}</Label>
              <div className="mt-1.5 space-y-1">
                {g.items.map(([id, name, Icon]) => (
                  <button
                    key={id as string}
                    onClick={() => {
                      setPage(id as Page);
                      setOpen(false);
                    }}
                    className={`group relative flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left text-xs font-semibold transition-all duration-200 ${page === id ? "bg-sky-500/15 text-white shadow-[0_16px_32px_rgba(14,165,233,0.18)]" : "text-slate-300 hover:bg-slate-800 hover:text-white"}`}
                  >
                    <span className={`flex h-7 w-7 items-center justify-center rounded-xl ${page === id ? "bg-sky-500/20 text-sky-200" : "bg-slate-800 text-slate-300 ring-1 ring-slate-700"}`}>
                      <Icon size={15} />
                    </span>
                    <span>{name as string}</span>
                    {page === id && (
                      <span className="ml-auto h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.7)]" />
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-auto border-t border-slate-800 pt-3">
        <div className="relative">
          <button
            type="button"
            onClick={() => setWalletMenuOpen((value) => !value)}
            className={`orbit-wallet-identity flex w-full items-center gap-3 rounded-2xl border border-slate-700 bg-slate-900/80 p-3 text-left shadow-sm transition hover:border-sky-400/40${isConnected ? ' is-connected' : ''}`}
          >
            <div className="orbit-wallet-identity__network flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-sky-500 via-blue-500 to-violet-500 text-[10px] font-bold text-white">
              <ChainLogo chainId={arcTestnet.id} className="h-5 w-5" />
            </div>
            <div className="orbit-wallet-identity__details min-w-0 flex-1">
              <p className="text-xs font-bold text-slate-100">{isConnected && address ? shortAddress(address) : "Wallet"}</p>
              <p className="orbit-wallet-identity__network-name font-mono text-[9px] text-slate-400">
                {isConnected ? activeNetwork?.name ?? `Chain ${chainId}` : 'Awaiting wallet'}
              </p>
            </div>
            <MoreHorizontal size={15} className="orbit-wallet-identity__menu text-slate-400" />
          </button>
          {walletMenuOpen && (
            <div className="absolute bottom-full left-0 right-0 z-20 mb-2 rounded-2xl border border-slate-700 bg-slate-900/95 p-3 shadow-[0_24px_64px_rgba(2,6,23,0.5)]">
              <div className="space-y-2 text-xs text-slate-300">
                <p className="font-semibold text-white">Wallet account</p>
                {isConnected && address ? (
                  <>
                    <p className="break-all font-mono text-[11px] text-slate-200">{address}</p>
                    <p className="text-[11px] text-slate-400">{activeNetwork?.name ?? `Chain ${chainId}`} connected</p>
                    <button
                      type="button"
                      className="w-full rounded-xl bg-slate-900 px-3 py-2 text-left font-medium text-white hover:bg-slate-800"
                      onClick={() => {
                        setPage("settings");
                        setWalletMenuOpen(false);
                        setOpen(false);
                      }}
                    >
                      Go to wallet settings
                    </button>
                    <button
                      type="button"
                      className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-left font-medium text-slate-100 hover:bg-slate-700"
                      onClick={() => {
                        if (chainId !== arcTestnet.id) switchChain({ chainId: arcTestnet.id });
                        setWalletMenuOpen(false);
                      }}
                    >
                      {chainId === arcTestnet.id ? 'Arc Testnet is active' : 'Switch to Arc Testnet'}
                    </button>
                    <button
                      type="button"
                      className="w-full rounded-xl bg-slate-900 px-3 py-2 text-left font-medium text-white hover:bg-slate-800"
                      onClick={() => {
                        disconnect();
                        setWalletMenuOpen(false);
                      }}
                    >
                      Disconnect wallet
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="w-full rounded-xl bg-slate-900 px-3 py-2 text-left font-medium text-white hover:bg-slate-800"
                    onClick={() => {
                      setPage("settings");
                      setWalletMenuOpen(false);
                      setOpen(false);
                    }}
                  >
                    Go to wallet settings
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
function FloatingPopover({
  open,
  anchorRef,
  onClose,
  children,
  width,
  className,
}: {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  children: React.ReactNode;
  width: number;
  className?: string;
}) {
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const panelRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;

    const updatePosition = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;

      const left = Math.min(Math.max(12, rect.right - width), window.innerWidth - width - 12);
      const top = Math.min(Math.max(12, rect.bottom + 10), window.innerHeight - 200);
      setPosition({ left, top });
    };

    const handleDocumentPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      const clickedOnAnchor = anchorRef.current?.contains(target);
      const clickedInsidePanel = panelRef.current?.contains(target);
      if (!clickedOnAnchor && !clickedInsidePanel) {
        onClose();
      }
    };

    updatePosition();
    document.addEventListener("mousedown", handleDocumentPointerDown);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      document.removeEventListener("mousedown", handleDocumentPointerDown);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchorRef, onClose, open, width]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[2000] pointer-events-none">
      <div
        ref={panelRef}
        className={className}
        style={{
          position: "fixed",
          left: position.left,
          top: position.top,
          width,
          zIndex: 2000,
          pointerEvents: "auto",
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

function NotificationPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { address, isConnected, chainId } = useAccount();
  const approvals = useApprovals();
  const txState = useTransactions(address, isConnected && chainId === arcTestnet.id && Boolean(address), chainId);

  const notifications = useMemo(() => {
    const next: Array<{ title: string; detail: string; tone: 'warning' | 'info' | 'danger' }> = [];
    if (!isConnected) {
      return next;
    }
    if (chainId !== arcTestnet.id) {
      next.push({ title: 'Wrong network', detail: 'Your wallet is not on Arc Testnet. Switch to Arc Testnet to keep ORBIT in sync.', tone: 'warning' });
    }
    const activeApprovals = (approvals.data?.approvals ?? []).filter((approval) => approval.allowance > 0n);
    if (activeApprovals.length > 0) {
      next.push({
        title: `${activeApprovals.length} active token allowance${activeApprovals.length === 1 ? '' : 's'} found`,
        detail: 'Review allowance amounts and spender verification before signing or moving funds.',
        tone: 'warning',
      });
    }
    const failedTxs = (txState.transactions ?? []).filter((tx) => tx.status === 'failed');
    if (failedTxs.length > 0) {
      next.push({ title: 'Failed transactions', detail: `${failedTxs.length} recent transaction${failedTxs.length === 1 ? '' : 's'} did not complete successfully.`, tone: 'danger' });
    }
    return next;
  }, [approvals.data?.approvals, chainId, isConnected, txState.transactions]);

  if (!open) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: -10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10, scale: 0.98 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="w-[340px] rounded-3xl border border-slate-700 bg-slate-950/95 p-4 shadow-[0_30px_80px_rgba(2,6,23,0.6)]"
    >
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">Notifications</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50">
          <X size={14} />
        </button>
      </div>
      {notifications.length === 0 ? (
        <div className="rounded-2xl border border-slate-700 bg-slate-900/80 p-5 text-center text-sm text-slate-300">
          No new notifications.
        </div>
      ) : (
        <div className="space-y-2">
          {notifications.map((notification) => (
            <div key={notification.title} className="rounded-2xl border border-slate-700 bg-slate-900/80 p-3">
              <div className="flex items-start gap-2">
                <span className={`mt-1 h-2.5 w-2.5 rounded-full ${notification.tone === 'danger' ? 'bg-rose-500' : notification.tone === 'warning' ? 'bg-amber-500' : 'bg-cyan-500'}`} />
                <div>
                  <p className="text-sm font-semibold text-slate-100">{notification.title}</p>
                  <p className="mt-1 text-xs leading-5 text-slate-300">{notification.detail}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </motion.div>
  );
}
const networkOptions = [
  { id: arcTestnet.id, name: "Arc Testnet", label: "NETWORK", shortName: "Arc" },
] as const;

function Topbar({ onMenu, page }: { onMenu: () => void; page: Page }) {
  const { chainId, isConnected } = useAccount();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [networkMenuOpen, setNetworkMenuOpen] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [requestedChainId, setRequestedChainId] = useState<number | null>(null);
  const networkButtonRef = useRef<HTMLButtonElement | null>(null);
  const notificationButtonRef = useRef<HTMLButtonElement | null>(null);
  const { switchChainAsync, isPending: isSwitchPending } = useSwitchChain();
  const { connectors, connect } = useConnect();
  const connector = getPreferredConnector(connectors);

  const activeNetwork = supportedChains.find((item) => item.id === chainId);
  const displayNetwork = activeNetwork ?? supportedChains[0];

  useEffect(() => {
    if (requestedChainId !== null && chainId === requestedChainId) {
      setRequestedChainId(null);
      setSwitchError(null);
      setNetworkMenuOpen(false);
    }
  }, [chainId, requestedChainId]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (networkMenuOpen && networkButtonRef.current && !networkButtonRef.current.contains(target)) {
        setNetworkMenuOpen(false);
      }
      if (notificationsOpen && notificationButtonRef.current && !notificationButtonRef.current.contains(target)) {
        setNotificationsOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [networkMenuOpen, notificationsOpen]);

  const handleNetworkSelect = async (nextChainId: number) => {
    if (!isConnected) {
      if (connector) {
        connect({ connector });
        setNetworkMenuOpen(false);
      } else {
        setSwitchError("No wallet connector is available.");
      }
      return;
    }

    if (nextChainId === chainId) {
      setNetworkMenuOpen(false);
      return;
    }

    setSwitchError(null);
    setRequestedChainId(nextChainId);
    try {
      await switchChainAsync({ chainId: nextChainId });
    } catch (error) {
      setRequestedChainId(null);
      setSwitchError(error instanceof Error ? error.message : "Failed to switch network.");
    }
  };

  return (
    <>
      <header className="flex h-20 shrink-0 items-center justify-between border-b border-slate-800 bg-slate-950/85 px-5 backdrop-blur-xl lg:px-8">
        <div className="flex items-center gap-3">
          <button onClick={onMenu} className="rounded-xl border border-slate-700 bg-slate-900 p-2 text-slate-300 shadow-sm lg:hidden">
            <Menu size={17} />
          </button>
          <div className="hidden items-center gap-2 text-xs text-slate-400 sm:flex">
            <span className="font-semibold text-slate-200">Command Center</span>
            <ChevronRight size={13} className="text-slate-500" />
            <span className="font-semibold text-white">
              {page === "security" ? "Security Center" : page === "about" ? "About" : "Overview"}
            </span>
          </div>
          <div className="sm:hidden">
            <Logo compact />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            ref={networkButtonRef}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setNotificationsOpen(false);
              setNetworkMenuOpen((value) => !value);
            }}
            className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-200 shadow-sm transition hover:border-sky-400/40 hover:bg-slate-800"
          >
            <ChainLogo chainId={displayNetwork.id} className="h-4 w-4 text-sky-300" />
            <span>{isConnected ? activeNetwork?.name ?? `Chain ${chainId}` : "Network"}</span>
            <ChevronRight size={12} className="text-slate-400" />
          </button>

          <button
            ref={notificationButtonRef}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setNetworkMenuOpen(false);
              setNotificationsOpen((value) => !value);
            }}
            className="relative rounded-xl border border-slate-700 bg-slate-900 p-2.5 text-slate-300 shadow-sm transition hover:border-sky-400/40 hover:bg-slate-800 hover:text-white"
            aria-label="Open notifications"
          >
            <Bell size={17} />
            <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-sky-500 shadow-[0_0_8px_rgba(14,165,233,0.8)]" />
          </button>

          <WalletButton className="hidden sm:flex" />
        </div>
      </header>

      <FloatingPopover
        open={networkMenuOpen}
        anchorRef={networkButtonRef}
        onClose={() => setNetworkMenuOpen(false)}
        width={256}
        className="z-[2000] rounded-2xl border border-slate-700 bg-slate-950/95 p-2 shadow-[0_28px_80px_rgba(2,6,23,0.72)] backdrop-blur-xl"
      >
        <div className="mb-2 px-2 pt-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Supported networks</div>
        <div className="space-y-1.5">
          {networkOptions.map((item) => {
            const selected = isConnected && chainId === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => void handleNetworkSelect(item.id)}
                disabled={isSwitchPending || (!isConnected && item.id !== displayNetwork.id)}
                className={`flex w-full items-center justify-between gap-2 rounded-xl border px-2.5 py-2 text-left transition ${selected ? "border-sky-400/30 bg-sky-500/10 text-white" : "border-slate-700 bg-slate-900/70 text-slate-200 hover:border-sky-400/30 hover:bg-slate-800"}`}
              >
                <div className="flex items-center gap-2.5">
                  <div className={`flex h-7 w-7 items-center justify-center rounded-xl ${selected ? "bg-sky-500/15 text-sky-200" : "bg-slate-800 text-slate-300"}`}>
                    <ChainLogo chainId={item.id} className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="text-xs font-semibold">{item.name}</div>
                    <div className="text-[9px] uppercase tracking-[0.12em] text-slate-500">Network</div>
                  </div>
                </div>
                {selected && <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.8)]" />}
              </button>
            );
          })}
        </div>
        {switchError && <div className="mt-2 rounded-xl border border-amber-300/20 bg-amber-300/[.06] px-2.5 py-2 text-[10px] text-amber-200">{switchError}</div>}
      </FloatingPopover>

      <FloatingPopover
        open={notificationsOpen}
        anchorRef={notificationButtonRef}
        onClose={() => setNotificationsOpen(false)}
        width={340}
        className="z-[2000] rounded-3xl border border-slate-700 bg-slate-950/95 p-4 shadow-[0_30px_80px_rgba(2,6,23,0.6)]"
      >
        <NotificationPanel open={notificationsOpen} onClose={() => setNotificationsOpen(false)} />
      </FloatingPopover>

      <NetworkWarning />
    </>
  );
}

export function NetworkIcon({ chainId, className = "" }: { chainId: number; className?: string }) {
  return <ChainLogo chainId={chainId} className={`h-4 w-4 ${className}`} />;
}

function LiveBalanceValue({ children, valueKey }: { children: ReactNode; valueKey: number | string }) {
  const reduceMotion = useReducedMotion();
  const previousValue = useRef(valueKey);
  const previousDisplay = useRef(children);
  const [isUpdating, setIsUpdating] = useState(false);
  const [outgoingDisplay, setOutgoingDisplay] = useState<ReactNode>(null);

  useEffect(() => {
    if (previousValue.current === valueKey) {
      previousDisplay.current = children;
      if (reduceMotion) {
        setIsUpdating(false);
        setOutgoingDisplay(null);
      }
      return;
    }

    previousValue.current = valueKey;
    const previousChildren = previousDisplay.current;
    previousDisplay.current = children;
    if (reduceMotion) {
      setIsUpdating(false);
      setOutgoingDisplay(null);
      return;
    }

    setOutgoingDisplay(previousChildren);
    setIsUpdating(true);
    const timeout = window.setTimeout(() => {
      setIsUpdating(false);
      setOutgoingDisplay(null);
    }, 780);
    return () => window.clearTimeout(timeout);
  }, [children, reduceMotion, valueKey]);

  return (
    <span className={`orbit-live-balance-value${isUpdating ? " orbit-live-balance-value--updating" : ""}`}>
      {isUpdating && outgoingDisplay !== null && (
        <span className="orbit-live-balance-value__previous" aria-hidden="true">
          {outgoingDisplay}
        </span>
      )}
      <span className={`orbit-live-balance-value__current${isUpdating ? " orbit-live-balance-value__current--updating" : ""}`}>
        {children}
      </span>
    </span>
  );
}

function Chart({ portfolio }: { portfolio: ReturnType<typeof usePortfolio> }) {
  const reduceMotion = useReducedMotion();
  const { address, chainId } = useAccount();
  const historyStorageKey = address
    ? `orbit-portfolio-balance-history:${chainId ?? 'unknown'}:${address.toLowerCase()}`
    : `orbit-portfolio-balance-history:${chainId ?? 'unknown'}:disconnected`;
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [chartHistory, setChartHistory] = useState<Array<{ timestamp: number; value: number }>>(() => {
    if (typeof window === 'undefined') {
      return [];
    }

    try {
      const stored = window.localStorage.getItem(historyStorageKey);
      if (!stored) {
        return [];
      }

      const parsed = JSON.parse(stored) as Array<{ timestamp?: number; value?: number }>;
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .filter((point) => {
          const numericValue = Number(point?.value);
          return Number.isFinite(point?.timestamp) && Number.isFinite(numericValue) && numericValue > 0;
        })
        .map((point) => ({
          timestamp: Number(point.timestamp),
          value: Number(point.value),
        }))
        .slice(-120);
    } catch {
      return [];
    }
  });

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const stored = window.localStorage.getItem(historyStorageKey);
      if (!stored) {
        setChartHistory([]);
        return;
      }

      const parsed = JSON.parse(stored) as Array<{ timestamp?: number; value?: number }>;
      if (!Array.isArray(parsed)) {
        setChartHistory([]);
        return;
      }

      const nextHistory = parsed
        .filter((point) => {
          const numericValue = Number(point?.value);
          return Number.isFinite(point?.timestamp) && Number.isFinite(numericValue) && numericValue > 0;
        })
        .map((point) => ({
          timestamp: Number(point.timestamp),
          value: Number(point.value),
        }))
        .slice(-120);

      setChartHistory(nextHistory);
    } catch {
      setChartHistory([]);
    }
  }, [historyStorageKey]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      window.localStorage.setItem(historyStorageKey, JSON.stringify(chartHistory));
    } catch {
      // localStorage can be unavailable; ignore to keep the chart functional without blocking the app.
    }
  }, [chartHistory, historyStorageKey]);

  useEffect(() => {
    if (!Number.isFinite(portfolio.totalValueUsd) || portfolio.totalValueUsd <= 0) {
      return;
    }

    setChartHistory((previous) => {
      const nextObservation = { timestamp: Date.now(), value: Number(portfolio.totalValueUsd) };
      const lastObservation = previous[previous.length - 1];
      if (lastObservation && Math.abs(lastObservation.value - nextObservation.value) < 0.0001) {
        return previous;
      }

      return [...previous, nextObservation].slice(-120);
    });
  }, [portfolio.totalValueUsd]);

  if (portfolio.isLoading) {
    return (
      <div className="space-y-3 py-4">
        <div className="h-28 animate-pulse rounded-xl bg-white/[0.06]" />
        <div className="flex gap-2">
          {[...Array(5)].map((_, index) => (
            <div key={index} className="h-3 flex-1 animate-pulse rounded bg-white/[0.05]" />
          ))}
        </div>
      </div>
    );
  }

  if (portfolio.hasUnavailablePrices) {
    return (
      <div className="orbit-chart-empty flex min-h-[180px] items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-900/40 text-center text-sm text-slate-400">
        Historical market data unavailable. Live portfolio value remains available.
      </div>
    );
  }

  const currentPortfolioValue = Number.isFinite(portfolio.totalValueUsd) ? portfolio.totalValueUsd : 0;
  if (!Number.isFinite(currentPortfolioValue) || currentPortfolioValue <= 0) {
    return (
      <div className="orbit-chart-empty flex min-h-[180px] items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-900/40 text-center text-sm text-slate-400">
        No wallet balance available for a portfolio chart.
      </div>
    );
  }

  const svgWidth = 760;
  const svgHeight = 220;
  const leftPad = 52;
  const rightPad = 12;
  const topPad = 18;
  const bottomPad = 24;
  const usableWidth = svgWidth - leftPad - rightPad;
  const usableHeight = svgHeight - topPad - bottomPad;
  const normalizedPoints = chartHistory.length > 0 ? chartHistory : [{ timestamp: Date.now(), value: currentPortfolioValue }];
  const minValue = Math.min(...normalizedPoints.map((point) => point.value));
  const maxValue = Math.max(...normalizedPoints.map((point) => point.value));
  const valueRange = maxValue - minValue || 1;
  const points = normalizedPoints.map((point, index) => {
    const x = normalizedPoints.length === 1
      ? leftPad + usableWidth * 0.5
      : leftPad + (index / (normalizedPoints.length - 1)) * usableWidth;
    const y = topPad + usableHeight - ((point.value - minValue) / valueRange) * usableHeight;
    return { ...point, x, y };
  });

  const linePath = points.length > 1
    ? points.reduce((path, point, index) => {
        if (index === 0) {
          return `M ${point.x} ${point.y}`;
        }

        const previous = points[index - 1];
        const cp1x = previous.x + (point.x - previous.x) * 0.35;
        const cp1y = previous.y;
        const cp2x = point.x - (point.x - previous.x) * 0.35;
        const cp2y = point.y;
        return `${path} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${point.x} ${point.y}`;
      }, '')
    : '';
  const areaPath = points.length > 1 ? `${linePath} L ${points[points.length - 1].x} ${svgHeight - bottomPad} L ${points[0].x} ${svgHeight - bottomPad} Z` : '';
  const latestPoint = points[points.length - 1];
  const currentLabel = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const currentTime = new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const xAxisPoints = [...new Set([
    points[0],
    points[Math.floor((points.length - 1) / 2)],
    latestPoint,
  ])];
  const currentValueLabel = `$${latestPoint.value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
  const currentValueLabelWidth = Math.min(118, currentValueLabel.length * 6 + 12);
  const currentValueLabelX = latestPoint.x > svgWidth * 0.72
    ? latestPoint.x - currentValueLabelWidth - 8
    : latestPoint.x + 8;
  const currentValueLabelY = Math.max(2, latestPoint.y - 28);
  const hoverPoint = hoverIndex === null ? null : points[hoverIndex] ?? null;
  const handleChartMouseMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0 || points.length === 0) {
      return;
    }

    const scale = Math.min(bounds.width / svgWidth, bounds.height / svgHeight);
    const renderedWidth = svgWidth * scale;
    const horizontalOffset = (bounds.width - renderedWidth) / 2;
    const pointerX = Math.max(
      leftPad,
      Math.min(svgWidth - rightPad, ((event.clientX - bounds.left - horizontalOffset) / renderedWidth) * svgWidth),
    );
    const nearestIndex = points.reduce((nearest, point, index) => (
      Math.abs(point.x - pointerX) < Math.abs(points[nearest].x - pointerX) ? index : nearest
    ), 0);
    setHoverIndex(nearestIndex);
  };

  return (
    <div className="space-y-4 pt-2">
      <div className="orbit-chart-label-row flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-slate-400">
        <span>Portfolio value</span>
        <span>{`$${currentPortfolioValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}</span>
      </div>

      <motion.div
        className="orbit-chart-surface relative overflow-hidden rounded-2xl border border-slate-800 p-3"
        initial={reduceMotion ? false : { opacity: 0, y: 5 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.38, ease: "easeOut" }}
      >
        <div className="orbit-chart-grid-wash absolute inset-0 opacity-60 [background-image:linear-gradient(to_right,rgba(148,163,184,0.08)_1px,transparent_1px),linear-gradient(to_top,rgba(148,163,184,0.08)_1px,transparent_1px)] [background-size:28px_28px]" />

        <div className="relative z-10">
          <div className="orbit-chart-timestamp mb-2 flex items-center justify-between text-[10px] text-slate-400">
            <span>{points.length > 1 ? 'Balance history' : 'Current balance'}</span>
            <span>{currentLabel} · {currentTime}</span>
          </div>

          <svg
            viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            className="orbit-chart-plot h-64 w-full"
            role="img"
            aria-label="Wallet balance chart"
            onMouseMove={handleChartMouseMove}
            onMouseLeave={() => setHoverIndex(null)}
          >
            <defs>
              <linearGradient id="orbit-portfolio-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#a4c3aa" stopOpacity="0.19" />
                <stop offset="62%" stopColor="#a4c3aa" stopOpacity="0.055" />
                <stop offset="100%" stopColor="#a4c3aa" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0, 1, 2, 3].map((line) => {
              const y = topPad + (usableHeight / 3) * line;
              const axisValue = maxValue - (valueRange / 3) * line;
              return (
                <g key={line}>
                  <line className="orbit-chart-grid-line" x1={leftPad} x2={svgWidth - rightPad} y1={y} y2={y} />
                  {points.length > 1 && (
                    <text className="orbit-chart-axis-label" x={leftPad - 8} y={y + 3} textAnchor="end">
                      {axisValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </text>
                  )}
                </g>
              );
            })}

            {points.length > 1 && (
              <>
                <motion.path
                  className="orbit-chart-area"
                  d={areaPath}
                  fill="url(#orbit-portfolio-area)"
                  initial={reduceMotion ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.5, ease: "easeOut" }}
                />
                <motion.path
                  className="orbit-chart-line"
                  d={linePath}
                  fill="none"
                  stroke="#a4c3aa"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  initial={reduceMotion ? false : { pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 0.75, ease: "easeOut" }}
                />
              </>
            )}

            {hoverPoint && (
              <line className="orbit-chart-crosshair" x1={hoverPoint.x} x2={hoverPoint.x} y1={topPad} y2={svgHeight - bottomPad} />
            )}

            {points.map((point, index) => (
              <circle
                key={`${point.timestamp}-${index}`}
                className={`orbit-chart-point${index === points.length - 1 ? ' orbit-chart-point--latest' : ''}${index === hoverIndex ? ' orbit-chart-point--hovered' : ''}`}
                cx={point.x}
                cy={point.y}
                r={index === hoverIndex ? 4 : index === points.length - 1 ? 3 : 1.35}
              />
            ))}

            {points.length > 1 && xAxisPoints.map((point, index) => (
              <text
                key={`time-${point.timestamp}`}
                className="orbit-chart-axis-label"
                x={point.x}
                y={svgHeight - 4}
                textAnchor={index === 0 ? "start" : index === xAxisPoints.length - 1 ? "end" : "middle"}
              >
                {new Date(point.timestamp).toLocaleTimeString(undefined, {
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </text>
            ))}

            {latestPoint && (
              <g className="orbit-chart-current-marker">
                <rect
                  x={currentValueLabelX}
                  y={currentValueLabelY}
                  width={currentValueLabelWidth}
                  height={20}
                  rx={6}
                />
                <text x={currentValueLabelX + currentValueLabelWidth / 2} y={currentValueLabelY + 13} textAnchor="middle">
                  {currentValueLabel}
                </text>
              </g>
            )}
          </svg>

          {hoverPoint && (
            <div
              className="orbit-chart-tooltip pointer-events-none absolute z-20 rounded-xl border border-slate-700 bg-slate-950/95 px-2.5 py-1.5 text-[10px] text-slate-200 shadow-[0_16px_30px_rgba(2,6,23,0.45)]"
              style={{
                left: `${((hoverPoint.x - leftPad) / usableWidth) * 100}%`,
                top: `${Math.max(18, hoverPoint.y - 100)}px`,
                transform: `translateX(${hoverPoint.x < svgWidth * 0.24 ? '0' : hoverPoint.x > svgWidth * 0.76 ? '-100%' : '-50%'})`,
              }}
            >
              <div className="font-semibold text-white">${hoverPoint.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
              <div className="mt-0.5 whitespace-nowrap text-[9px] text-slate-400">
                {new Date(hoverPoint.timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
              </div>
            </div>
          )}

          <p className="mt-2 text-[10px] leading-5 text-slate-400">
            {points.length > 1 ? 'Real wallet snapshots collected from the live portfolio value.' : 'Collecting balance history...'}
          </p>
        </div>
      </motion.div>
    </div>
  );
}
function formatHomeUsdcAmount(amount: string): string {
  const numericAmount = Number(amount);
  return Number.isFinite(numericAmount)
    ? numericAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : amount;
}

function StatCards({
  setPage,
  securityAssessment,
  approvalCoverage,
}: {
  setPage: (page: Page) => void;
  securityAssessment: ReturnType<typeof getSecurityAssessment>;
  approvalCoverage: string | null;
}) {
  const { chainId } = useAccount();
  const portfolio = usePortfolio();
  const isArcTestnet = chainId === arcTestnet.id;
  const displayAsset = portfolio.assets.find((asset) => asset.symbol === (isArcTestnet ? "USDC" : "ETH")) ?? portfolio.assets[0];
  const heldAssets = portfolio.assets.filter((asset) => asset.valueUsd !== null && asset.valueUsd > 0 && asset.raw > 0n);
  const displayAssetError = !portfolio.isDisconnected && !portfolio.isWrongNetwork && !portfolio.isLoading && displayAsset?.isError && displayAsset.raw === 0n;

  return (
    <div className="orbit-stat-panel grid gap-4 md:grid-cols-3">
      <Card className="orbit-home-stat-card orbit-home-stat-card--balance p-5" glow>
        <div className="orbit-home-stat-heading flex items-center justify-between">
          <Label>Arc USDC Balance</Label>
          <span className="orbit-home-stat-icon orbit-home-stat-icon--balance rounded-xl bg-sky-100 p-2 text-sky-700 ring-1 ring-sky-200" aria-hidden="true">
            <Wallet size={16} />
          </span>
        </div>
        <div className="orbit-balance-stage">
          <div className="orbit-balance-field" aria-hidden="true">
            <svg viewBox="0 0 240 170" fill="none" xmlns="http://www.w3.org/2000/svg">
              <g className="orbit-balance-field-grid">
                <path d="M80 4V166M112 4V166M144 4V166M176 4V166M208 4V166M49 34H236M49 66H236M49 98H236M49 130H236" />
              </g>
              <g className="orbit-balance-field-orbits">
                <ellipse cx="154" cy="91" rx="85" ry="34" transform="rotate(-24 154 91)" />
                <ellipse cx="154" cy="91" rx="69" ry="23" transform="rotate(18 154 91)" />
                <path d="M65 122C98 73 142 59 230 76" />
                <path d="M88 150C127 111 176 103 236 111" />
              </g>
              <g className="orbit-balance-field-points">
                <circle cx="91" cy="64" r="2" />
                <circle cx="202" cy="58" r="2.5" />
                <circle cx="169" cy="124" r="1.75" />
                <circle cx="222" cy="112" r="1.5" />
              </g>
            </svg>
          </div>
          <div className="orbit-balance-copy">
            {portfolio.isDisconnected ? (
              <>
                <p className="orbit-balance-connect mt-5 text-2xl font-extrabold text-slate-400">
                  Connect wallet
                </p>
                <p className="mt-2 text-xs text-slate-500">
                  Live Arc ERC-20 balance appears here
                </p>
              </>
            ) : portfolio.isWrongNetwork ? (
              <>
                <p className="orbit-balance-amount mt-5 text-2xl font-extrabold tracking-[-0.06em]">
                  Unavailable
                </p>
                <p className="mt-2 text-xs text-slate-500">
                  Switch to Arc Testnet to view this balance
                </p>
              </>
            ) : displayAsset?.isLoading ? (
              <>
                <p className="mt-5 h-7 w-32 animate-pulse rounded bg-white/10" />
                <p className="mt-2 h-3 w-24 animate-pulse rounded bg-white/10" />
              </>
            ) : (
              <>
                <p className="orbit-balance-amount mt-5 text-3xl font-extrabold tracking-[-0.06em]">
                  <span className="orbit-balance-number">
                    {displayAsset?.isError
                      ? "Unavailable"
                      : displayAsset
                        ? (
                          <LiveBalanceValue valueKey={`${displayAsset.symbol}:${displayAsset.raw.toString()}`}>
                            {isArcTestnet
                              ? formatHomeUsdcAmount(displayAsset.formatted ?? "0")
                              : displayAsset.formatted ?? "0"}
                          </LiveBalanceValue>
                        )
                        : "0"}
                  </span>
                  <span className="orbit-balance-currency text-xl text-slate-500">{isArcTestnet ? "USDC" : "ETH"}</span>
                </p>
                <p className="orbit-balance-live mt-2 text-xs font-semibold text-cyan-300">
                  <span className="orbit-balance-live-dot" aria-hidden="true" />
                  <span>Live balance</span>
                  <span className="orbit-balance-live-separator" aria-hidden="true">·</span>
                  <span className="orbit-balance-network font-normal text-slate-500">on Arc Testnet</span>
                </p>
              </>
            )}
            <div className="orbit-balance-footer">
              {isArcTestnet ? (
                <p className="orbit-balance-note mt-2 text-xs text-cyan-300">
                  Arc Testnet connected. USDC is read through its ERC-20 interface.
                </p>
              ) : portfolio.isWrongNetwork ? (
                <p className="orbit-balance-note orbit-balance-note--warning mt-2 text-xs text-amber-300">
                  Wrong network — switch to Arc Testnet
                </p>
              ) : null}
              {displayAssetError && (
                <div className="orbit-balance-error mt-3 flex items-center justify-between gap-2 rounded-xl border border-rose-400/20 bg-rose-500/5 p-2.5">
                  <p className="text-[11px] text-rose-200">Arc USDC balance could not be read.</p>
                  <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className="rounded-lg border border-rose-400/20 bg-rose-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-rose-200 transition hover:bg-rose-500/15"
                  >
                    Retry
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </Card>
      <Card className="orbit-home-stat-card orbit-home-stat-card--mix p-5">
        <div className="orbit-home-stat-heading flex items-center justify-between">
          <Label>Portfolio mix</Label>
          <div className="orbit-mix-header-meta">
            <span className="orbit-mix-count-value">{heldAssets.length}</span>
            <span className="orbit-mix-count-label">active asset{heldAssets.length === 1 ? "" : "s"}</span>
            <div className="orbit-mix-avatars flex -space-x-1">
            {heldAssets.slice(0, 4).map((a) => (
              <span
                key={a.symbol}
                className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-[#101725] text-[9px] font-extrabold text-white"
                style={{ background: a.color }}
              >
                {a.symbol === "ETH" ? "Ξ" : a.symbol === "USDC" ? "$" : a.symbol === "cbBTC" ? "₿" : a.symbol.slice(0, 1)}
              </span>
            ))}
            </div>
          </div>
        </div>
        <div className="orbit-mix-distribution">
          <div className="orbit-mix-allocation-readout">
            {heldAssets.length === 1 ? (
              <>
                <strong>{heldAssets[0].allocationPercent.toFixed(1)}%</strong>
                <span>allocated</span>
              </>
            ) : (
              <span>Asset allocation</span>
            )}
          </div>
          <div className="orbit-mix-progress flex h-1.5 overflow-hidden rounded-full bg-slate-900/80">
            {heldAssets.length === 0 ? (
              <div className="h-full w-full rounded-full bg-gradient-to-r from-slate-700 to-slate-800" />
            ) : (
              heldAssets.map((a) => {
                const total = heldAssets.reduce((sum, item) => sum + (item.valueUsd ?? 0), 0);
                const pct = total > 0 && a.valueUsd !== null ? (a.valueUsd / total) * 100 : 0;
                return (
                  <div
                    key={a.symbol}
                    className="h-full"
                    style={{ width: `${Math.max(8, pct)}%`, background: a.color }}
                  />
                );
              })
            )}
          </div>
        </div>
        <div className="orbit-mix-assets mt-4 space-y-2">
          {heldAssets.length === 0 ? (
            <p className="text-xs text-slate-500">No Arc asset balances are currently detected.</p>
          ) : (
            heldAssets.map((asset) => (
              <div key={asset.symbol} className="orbit-mix-asset-row flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/40 px-2.5 py-2">
                <div className="orbit-mix-asset-identity flex items-center gap-2.5 min-w-0">
                  <span className="orbit-mix-token-shell"><TokenIcon symbol={asset.symbol} color={asset.color} /></span>
                  <div className="min-w-0">
                    <p className="orbit-mix-asset-name truncate text-sm font-semibold text-slate-100">{asset.name}</p>
                    <p className="orbit-mix-asset-symbol text-[10px] uppercase tracking-[0.12em] text-slate-500">{asset.symbol}</p>
                  </div>
                </div>
                <div className="orbit-mix-asset-value text-right">
                  <p className="orbit-mix-asset-amount text-xs font-semibold text-slate-200">{asset.valueUsd !== null ? `$${asset.valueUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : 'N/A'}</p>
                  <p className="orbit-mix-asset-allocation text-[10px] text-slate-500">{asset.allocationPercent.toFixed(1)}%</p>
                </div>
              </div>
            ))
          )}
        </div>
      </Card>
      <Card className="orbit-home-stat-card orbit-home-stat-card--security orbit-home-security-score-card">
        <div className="orbit-home-security-card__layout">
          <span
            className="orbit-home-security-card__icon"
            aria-hidden="true"
          >
            <ShieldCheck size={18} strokeWidth={1.8} />
          </span>
          <div className="orbit-home-security-card__content">
            <p className="orbit-home-security-card__title">Security Score</p>
            <p className="orbit-home-security-card__status">Not scored</p>
            <p className="orbit-home-security-card__description">
              <span>
                {securityAssessment.status}: {securityAssessment.description}
              </span>
              {approvalCoverage && (
                <span className="orbit-home-security-card__coverage">
                  {approvalCoverage}
                </span>
              )}
              <span className="orbit-home-security-card__limitation">
                Configured tokens only; this is not complete wallet history.
              </span>
            </p>
            <button
              type="button"
              onClick={() => setPage(getSecurityNavigationTarget("view-security-details"))}
              className="orbit-home-security-card__link"
            >
              View security details
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
function QuickActions({ setPage }: { setPage: (p: Page) => void }) {
  const reduceMotion = useReducedMotion();
  const items = [
    ["Send", "Transfer to any wallet", Send, "send"],
    ["Receive", "Fund your wallet", ArrowDownLeft, "receive"],
    ["Bridge", "Move across networks", Network, "bridge"],
    ["Swap", "Exchange stablecoins", ArrowLeftRight, "swap"],
    ["Unified Balance", "Manage cross-network USDC", CircleDollarSign, "unified-balance"],
  ];
  return (
    <motion.div
      className="orbit-actions"
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: "easeOut" }}
    >
      <div className="mb-4 flex items-center justify-between">
        <div>
          <Label>Quick Actions</Label>
          <h2 className="mt-2 text-2xl font-extrabold tracking-[-0.05em] text-white sm:text-3xl">Make a move</h2>
        </div>
      </div>
      <div className="orbit-action-grid grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {items.map(([name, desc, Icon, id], index) => (
          <motion.button
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.04, duration: 0.18, ease: "easeOut" }}
            whileHover={reduceMotion ? undefined : { y: -2 }}
            whileTap={reduceMotion ? undefined : { scale: 0.985 }}
            onClick={() => setPage(id as Page)}
            key={name as string}
            className={`orbit-quick-action orbit-quick-action--${id as string} group rounded-2xl border border-slate-700/80 bg-slate-900/80 p-4 text-left shadow-[0_18px_40px_rgba(2,6,23,0.22)] transition-all duration-200 hover:border-sky-400/40 hover:bg-slate-900`}
          >
            <div className="orbit-quick-action__icon mb-7 flex h-11 w-11 items-center justify-center rounded-2xl border border-sky-400/20 bg-gradient-to-br from-sky-500/12 to-violet-500/10 text-slate-100 shadow-[0_0_18px_rgba(125,211,252,0.12)] transition duration-200 group-hover:-translate-y-0.5 group-hover:border-sky-300/40 group-hover:bg-sky-500/10 group-hover:text-sky-200">
              <Icon size={17} />
            </div>
            <p className="text-sm font-bold text-white">{name as string}</p>
            <p className="mt-1 text-[10px] leading-4 text-slate-400">
              {desc as string}
            </p>
          </motion.button>
        ))}
      </div>
    </motion.div>
  );
}
function txIcon(cat: string) {
  switch (cat) {
    case "Send":
      return ArrowUpRight;
    case "Receive":
      return ArrowDownLeft;
    case "Swap":
      return ArrowLeftRight;
    case "Approval":
      return LockKeyhole;
    case "Contract Interaction":
      return Crosshair;
    case "Bridge":
      return Network;
    case "Lending":
      return Landmark;
    default:
      return Activity;
  }
}

function formatTxValue(value: string | number | undefined, symbol = 'ETH', fallback = '—') {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  if (numeric === 0) return `0 ${symbol}`;
  const precision = numeric >= 1 ? 4 : 6;
  const trimmed = numeric.toFixed(precision).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return `${trimmed} ${symbol}`;
}

function formatTransactionAmount(transaction: ChainTransaction): string {
  if (transaction.tokenTransfers.length > 0) {
    return transaction.tokenTransfers
      .slice(0, 2)
      .map((transfer) => `${transfer.amount} ${transfer.symbol}`)
      .join(' + ');
  }
  return formatTxValue(transaction.value, transaction.nativeSymbol);
}

function getStatusLabel(status: TxStatus): string {
  switch (status) {
    case 'success':
      return 'SUCCESS';
    case 'failed':
      return 'FAILED';
    case 'pending':
      return 'PENDING';
    default:
      return 'STATUS UNAVAILABLE';
  }
}

function getStatusClasses(status: TxStatus): string {
  switch (status) {
    case 'success':
      return 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300';
    case 'failed':
      return 'border-rose-400/30 bg-rose-500/10 text-rose-300';
    case 'pending':
      return 'border-amber-400/30 bg-amber-500/10 text-amber-200';
    default:
      return 'border-slate-500/30 bg-slate-500/10 text-slate-300';
  }
}

export function RecentActivity({ setPage }: { setPage: (p: Page) => void }) {
  const { address, isConnected, chainId } = useAccount();
  const { transactions, isLoading, isError } = useTransactions(
    address,
    isConnected && chainId === arcTestnet.id,
    chainId,
  );
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <div>
          <Label>Onchain Activity</Label>
          <h2 className="mt-2 text-xl font-bold">Recent activity</h2>
        </div>
        <button
          onClick={() => setPage("activity")}
          className="text-xs text-cyan-300 transition hover:text-cyan-200"
        >
          View all
        </button>
      </div>
      {!isConnected ? (
        <p className="mt-5 py-6 text-center text-xs text-slate-500">
          Connect wallet to view onchain activity
        </p>
      ) : chainId === arcTestnet.id ? (
        <p className="mt-5 py-6 text-center text-xs text-slate-500">
          Arc transaction history is not part of this portfolio step.
        </p>
      ) : isLoading ? (
        <div className="mt-5 space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="flex items-center gap-3 py-2">
              <div className="h-9 w-9 animate-pulse rounded-lg bg-white/10" />
              <div className="flex-1 space-y-2">
                <div className="h-3 w-24 animate-pulse rounded bg-white/10" />
                <div className="h-2 w-32 animate-pulse rounded bg-white/10" />
              </div>
            </div>
          ))}
        </div>
      ) : isError ? (
        <p className="mt-5 py-6 text-center text-xs text-rose-300">
          Failed to load transactions
        </p>
      ) : transactions.length === 0 ? (
        <p className="mt-5 py-6 text-center text-xs text-slate-500">
          No recent transactions found
        </p>
      ) : (
        <div className="mt-5 divide-y divide-white/[.06]">
          {transactions.slice(0, 5).map((tx) => {
            const Icon = txIcon(tx.category);
            return (
              <div
                className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
                key={tx.hash}
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/[.05] text-slate-400">
                  <Icon size={15} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold">{tx.category}</p>
                  <a
                    href={explorerTxUrl(tx.hash, chainId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-0.5 block truncate text-[10px] text-cyan-400 hover:text-cyan-300"
                  >
                    {shortAddr(tx.hash)}
                  </a>
                </div>
                <div className="text-right">
                  <p className="font-mono text-xs text-slate-300">
                    {tx.value !== "0.000000" ? `${tx.value} ${tx.nativeSymbol ?? "ETH"}` : "—"}
                  </p>
                  <p className="mt-1 text-[9px] text-slate-600">
                    {getTimeAgo(tx.timestamp)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
function Home({ setPage }: { setPage: (p: Page) => void }) {
  const reduceMotion = useReducedMotion();
  const portfolio = usePortfolio();
  const { address, chainId, isConnected } = useAccount();
  const approvalsQuery = useApprovals(true);
  const transactionsQuery = useTransactions(
    address,
    isConnected && chainId === arcTestnet.id && Boolean(address),
    chainId,
    false,
    true,
  );
  const isArcConnected = isConnected && chainId === ARC_TESTNET.id && Boolean(address);
  const providerPauseUntil = Math.max(
    approvalsQuery.cooldownUntil ?? 0,
    approvalsQuery.data?.retryAfterAt ?? 0,
  );
  const [assessmentClock, setAssessmentClock] = useState(Date.now());
  useEffect(() => {
    if (providerPauseUntil <= assessmentClock) return;
    const timer = window.setTimeout(
      () => setAssessmentClock(Date.now()),
      Math.max(0, providerPauseUntil - Date.now() + 20),
    );
    return () => window.clearTimeout(timer);
  }, [assessmentClock, providerPauseUntil]);
  const securityAssessment = getSecurityAssessment({
    walletConnected: isConnected && Boolean(address),
    supportedNetwork: chainId === ARC_TESTNET.id,
    isScanning: isArcConnected && (approvalsQuery.isFetching || transactionsQuery.isFetching),
    providerRateLimited: isArcConnected &&
      !approvalsQuery.data?.isComplete &&
      providerPauseUntil > assessmentClock,
    approvalScanStarted: approvalsQuery.data !== undefined,
    approvalWindowComplete: Boolean(approvalsQuery.data?.isComplete),
    approvalHistoryStartsAtGenesis: approvalsQuery.data?.scannedFromBlock === 0n,
    approvalDataUnavailable: approvalsQuery.isError || Boolean(approvalsQuery.data?.errors.length),
    activityScanStarted: transactionsQuery.lastScannedAt !== null,
    activityDataUnavailable: transactionsQuery.isError,
    activityHasUnresolvedTransactions: transactionsQuery.transactions.some(
      (transaction) => transaction.status !== "success" && transaction.status !== "failed",
    ),
  });
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const networkLabel = supportedChains.find((item) => item.id === chainId)?.name ?? "Current network";
  const hasRealPortfolioValue = Number.isFinite(portfolio.totalValueUsd) && portfolio.totalValueUsd > 0;
  const shouldAnimatePortfolioValue = !portfolio.isDisconnected
    && !portfolio.isWrongNetwork
    && !portfolio.isLoading
    && !portfolio.isError
    && !portfolio.hasUnavailablePrices
    && Number.isFinite(portfolio.totalValueUsd);
  const value = portfolio.isDisconnected
    ? "Connect wallet"
    : portfolio.isWrongNetwork
      ? "Switch to Arc Testnet"
      : portfolio.isLoading
        ? "Loading..."
          : portfolio.isError
            ? "Balance unavailable"
        : hasRealPortfolioValue
          ? `$${portfolio.totalValueUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          : portfolio.hasUnavailablePrices
            ? "Price data unavailable"
            : "$0.00";
  const valueDetail = portfolio.isDisconnected
    ? 'Awaiting wallet connection'
    : portfolio.isWrongNetwork
      ? `Your wallet is on ${networkLabel}. Switch to Arc Testnet to view your ORBIT portfolio.`
      : portfolio.isLoading
        ? 'Loading portfolio balance'
          : portfolio.isError
            ? 'Live balance read failed'
        : hasRealPortfolioValue
          ? 'Current Arc USDC value'
          : portfolio.hasUnavailablePrices
            ? 'Partial pricing data is unavailable for some holdings'
            : 'No wallet balances are currently detected';
  const lastSync = portfolio.isDisconnected
    ? "WALLET NOT CONNECTED"
    : portfolio.isLoading
      ? "UPDATING"
      : portfolio.isError
        ? "DEGRADED"
        : "LIVE";
  const topHoldings = portfolio.assets
    .filter((asset) => asset.raw > 0n)
    .sort((left, right) => (right.valueUsd ?? -1) - (left.valueUsd ?? -1))
    .slice(0, 4);

  return (
    <div className="orbit-home">
      <main className="orbit-home-main">
      <div className="orbit-home-primary-grid">
        <motion.div
          initial={reduceMotion ? false : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
          className="orbit-home-hero page-shell relative overflow-hidden rounded-[28px] p-6 sm:p-8 lg:p-10"
        >
        <div className="orbit-home-hero__wash absolute inset-0" />
        <div className="orbit-home-hero__ornaments absolute inset-0 opacity-80">
          <div className="absolute left-10 top-10 h-40 w-40 rounded-full border border-sky-400/20 bg-sky-400/5 blur-2xl" />
          <div className="absolute right-10 top-20 h-56 w-56 rounded-full border border-violet-400/20 bg-violet-500/10 blur-3xl" />
          <div className="absolute bottom-8 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full border border-cyan-300/10" />
        </div>
        <div className="orbit-home-hero__top relative z-10 flex flex-wrap items-end justify-between gap-5">
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: 'easeOut' }}
          >
            <p className="orbit-home-greeting text-sm font-semibold uppercase tracking-[0.18em]">
              {greeting}
            </p>
          </motion.div>
          <div className="orbit-sync-status rounded-full border border-sky-400/20 bg-sky-500/10 px-3 py-1.5 shadow-[0_0_24px_rgba(34,211,238,0.12)]">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-300">
              {portfolio.isDisconnected ? (
                <span className="text-slate-400">{lastSync}</span>
              ) : (
                <>Last sync <span className="text-sky-200">{lastSync}</span></>
              )}
            </p>
          </div>
        </div>

        <div className="orbit-home-hero__body relative z-10 mt-8 grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
          <div className="orbit-primary-metric rounded-3xl border border-slate-700/80 bg-slate-900/70 p-6 shadow-[0_22px_50px_rgba(2,6,23,0.45)] backdrop-blur-sm">
            <div className="orbit-value-field" aria-hidden="true">
              <svg viewBox="0 0 260 210" fill="none" xmlns="http://www.w3.org/2000/svg">
                <g className="orbit-value-field__grid">
                  <path d="M18 40H242M18 76H242M18 112H242M18 148H242M42 22V184M78 22V184M114 22V184M150 22V184M186 22V184M222 22V184" />
                </g>
                <g className="orbit-value-field__fixed">
                  <ellipse cx="130" cy="105" rx="111" ry="48" transform="rotate(-28 130 105)" />
                  <circle cx="130" cy="105" r="82" />
                  <circle cx="130" cy="105" r="59" strokeDasharray="2 7" />
                  <circle cx="130" cy="105" r="43" className="orbit-value-field__coin" />
                  <circle cx="130" cy="105" r="35" className="orbit-value-field__coin-inner" />
                  <text x="130" y="119" textAnchor="middle" className="orbit-value-field__coin-mark">$</text>
                  <circle cx="42" cy="125" r="3" className="orbit-value-field__point" />
                  <circle cx="225" cy="82" r="3.5" className="orbit-value-field__point" />
                  <circle cx="174" cy="40" r="2.5" className="orbit-value-field__point" />
                  <circle cx="83" cy="172" r="2" className="orbit-value-field__point" />
                </g>
                <g className="orbit-value-field__moving">
                  <circle cx="130" cy="105" r="96" strokeDasharray="32 145 18 410" />
                  <circle cx="130" cy="9" r="2.5" className="orbit-value-field__point" />
                </g>
                <g className="orbit-value-field__counter">
                  <circle cx="130" cy="105" r="69" strokeDasharray="1 10" />
                  <circle cx="62" cy="93" r="2.2" className="orbit-value-field__point" />
                </g>
              </svg>
            </div>
            <div className="orbit-primary-metric__header flex items-center justify-between gap-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-slate-300">Portfolio value</p>
              {!portfolio.isDisconnected && (
                <span className="orbit-live-badge"><Pill color="green">{lastSync}</Pill></span>
              )}
            </div>
            <div className="orbit-primary-metric__values mt-4">
              <div className="orbit-primary-metric__copy">
                <p className="orbit-primary-value text-4xl font-extrabold tracking-[-0.08em] text-white md:text-5xl">
                  {shouldAnimatePortfolioValue ? <LiveBalanceValue valueKey={portfolio.totalValueUsd}>{value}</LiveBalanceValue> : value}
                </p>
                <p className="mt-2 text-sm text-slate-300">{valueDetail}</p>
                {portfolio.isDisconnected && (
                  <WalletButton className="orbit-home-connect" />
                )}
              </div>
            </div>
          </div>

        </div>
        </motion.div>
        <QuickActions setPage={setPage} />
      </div>

      <div className="orbit-home-chart-section grid gap-4">
        <motion.div
          initial={reduceMotion ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.25, delay: reduceMotion ? 0 : 0.05 }}
        >
          <Card className="orbit-chart-card p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="orbit-chart-heading">
                <span className="orbit-chart-heading-icon" aria-hidden="true">
                  <Activity size={16} strokeWidth={1.8} />
                </span>
                <div>
                  <Label>Portfolio history</Label>
                </div>
              </div>
              <div className="orbit-chart-status flex items-center gap-1 rounded-xl border border-slate-700/80 bg-slate-900/80 p-1.5">
                <span className={`rounded-md px-2 py-1 font-mono text-[9px] font-bold tracking-[0.16em] ${portfolio.isDisconnected ? 'bg-slate-500/10 text-slate-400' : 'bg-cyan-300/15 text-cyan-200'}`}>
                  {portfolio.isDisconnected ? 'WALLET NOT CONNECTED' : 'LIVE'}
                </span>
              </div>
            </div>
            <div className="orbit-chart-frame mt-6 rounded-2xl border border-slate-800/80 bg-slate-950/30 px-0 pb-0 pt-3">
              {portfolio.isLoading ? (
                <div className="space-y-3 py-4">
                  <div className="h-28 animate-pulse rounded-xl bg-white/[0.06]" />
                  <div className="flex gap-2">
                    {[...Array(5)].map((_, index) => (
                      <div key={index} className="h-3 flex-1 animate-pulse rounded bg-white/[0.05]" />
                    ))}
                  </div>
                </div>
              ) : portfolio.hasUnavailablePrices ? (
                <div className="flex min-h-[150px] items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-900/40 text-center text-sm text-slate-400">
                  Price data is temporarily unavailable. The wallet balance remains available once pricing recovers.
                </div>
              ) : (
                <Chart portfolio={portfolio} />
              )}
            </div>
          </Card>
        </motion.div>
      </div>
      </main>

      <aside className="orbit-home-sidebar">
      <StatCards
        setPage={setPage}
        securityAssessment={securityAssessment}
        approvalCoverage={approvalsQuery.data
          ? `${approvalsQuery.data.historyWindowBlocks.toLocaleString()}-block window · ${getApprovalCoveragePercent(
            approvalsQuery.data.coveredBlocks,
            approvalsQuery.data.totalBlocks,
          ).toFixed(1)}% covered`
          : null}
      />

        <div className="orbit-home-data-stack">
          <Card className="orbit-home-data-card orbit-home-holdings-card p-5">
            <div className="orbit-home-data-card__header">
              <div>
                <Label>Portfolio</Label>
                <h2>Top Holdings</h2>
              </div>
              <button type="button" className="orbit-home-data-card__link" onClick={() => setPage("portfolio")}>
                View all
              </button>
            </div>
            {portfolio.isDisconnected ? (
              <p className="orbit-home-data-card__message">Connect your wallet to see current holdings.</p>
            ) : portfolio.isWrongNetwork ? (
              <p className="orbit-home-data-card__message">Switch to Arc Testnet to view these holdings.</p>
            ) : portfolio.isLoading ? (
              <div className="orbit-home-data-list" aria-label="Loading holdings">
                {[...Array(3)].map((_, index) => <div key={index} className="orbit-home-data-skeleton" />)}
              </div>
            ) : portfolio.isError ? (
              <p className="orbit-home-data-card__message orbit-home-data-card__message--error">Holdings could not be loaded. Try again later.</p>
            ) : portfolio.assets.some((asset) => asset.isLoading) ? (
              <div className="orbit-home-data-list" aria-label="Loading holdings">
                {[...Array(3)].map((_, index) => <div key={index} className="orbit-home-data-skeleton" />)}
              </div>
            ) : (
              <>
                {portfolio.assets.some((asset) => asset.isError) && (
                  <p className="orbit-home-data-card__notice">Some asset balances are temporarily unavailable.</p>
                )}
                {topHoldings.length > 0 ? (
                  <div className="orbit-home-data-list">
                    {topHoldings.slice(0, 3).map((asset) => (
                        <div className="orbit-home-holding-row" key={asset.symbol}>
                          <span className="orbit-home-holding-row__icon" style={{ background: asset.color }} aria-hidden="true">
                            {asset.symbol.slice(0, 1)}
                          </span>
                          <span className="orbit-home-holding-row__asset">
                            <strong>{asset.symbol}</strong>
                            <span>{asset.symbol === "USDC" ? formatHomeUsdcAmount(asset.formatted) : asset.formatted}</span>
                          </span>
                          <span className="orbit-home-holding-row__value">
                            {asset.valueUsd === null
                              ? 'Unavailable'
                              : `$${asset.valueUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                          </span>
                        </div>
                    ))}
                  </div>
                ) : (
                  <p className="orbit-home-data-card__message">No funded holdings are currently detected.</p>
                )}
              </>
            )}
          </Card>

          <Card className="orbit-home-data-card orbit-home-activity-card p-5">
            <div className="orbit-home-data-card__header">
              <div>
                <Label>Wallet</Label>
                <h2>Recent Activity</h2>
              </div>
              <button type="button" className="orbit-home-data-card__link" onClick={() => setPage("activity")}>
                View all
              </button>
            </div>
            {transactionsQuery.isLoading ? (
              <div className="orbit-home-data-list" aria-label="Loading recent activity">
                {[...Array(3)].map((_, index) => <div key={index} className="orbit-home-data-skeleton" />)}
              </div>
            ) : transactionsQuery.isError ? (
              <p className="orbit-home-data-card__message orbit-home-data-card__message--error">Recent activity could not be loaded.</p>
            ) : transactionsQuery.transactions.length > 0 ? (
              <div className="orbit-home-data-list">
                {transactionsQuery.transactions.slice(0, 3).map((transaction) => (
                  <div className="orbit-home-activity-row" key={transaction.hash}>
                    <span className={`orbit-home-activity-row__marker orbit-home-activity-row__marker--${transaction.status}`} aria-hidden="true" />
                    <span className="orbit-home-activity-row__details">
                      <strong>{transaction.category}</strong>
                      <span>{formatTransactionDate(transaction.timestamp)} · {transaction.status}</span>
                    </span>
                    <a
                      className="orbit-home-activity-row__link"
                      href={explorerTxUrl(transaction.hash, arcTestnet.id)}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={transaction.hash}
                    >
                      {shortAddr(transaction.hash)}
                    </a>
                  </div>
                ))}
              </div>
            ) : (
              <p className="orbit-home-data-card__message">
                {isArcConnected
                  ? 'No recent Arc Testnet activity was found for this wallet.'
                  : 'Connect on Arc Testnet to view recent activity.'}
              </p>
            )}
          </Card>
        </div>
      </aside>

    </div>
  );
}

function Portfolio() {
  const { address, chainId } = useAccount();
  const portfolio = usePortfolio();
  const isArcTestnet = chainId === arcTestnet.id;
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const portfolioNetwork = !address ? 'wallet disconnected' : isArcTestnet ? 'Arc Testnet' : 'unsupported network';
  const transactionsQuery = useTransactions(address, isArcTestnet && Boolean(address), chainId);
  const hasBalanceReadError = portfolio.isError || portfolio.assets.some((asset) => asset.isError);
  const portfolioUnavailable = portfolio.isDisconnected || portfolio.isWrongNetwork || hasBalanceReadError;
  const unavailableLabel = hasBalanceReadError ? 'Unavailable' : 'Not assessed';
  const analytics = getPortfolioAnalytics(
    portfolioUnavailable ? [] : portfolio.assets,
    transactionsQuery.transactions,
    portfolioNetwork,
  );
  const secondaryValue = (value: string) =>
    portfolioUnavailable ? unavailableLabel : analytics.valuationUnavailable ? 'Unavailable' : value;
  const assetCountState = getPortfolioAssetCountState(
    portfolio.assets.some((asset) => asset.isLoading),
    portfolioUnavailable,
    portfolio.connectedAssets,
  );

  const formatUsd = (value: number | null, fallback = 'N/A') =>
    value === null || !Number.isFinite(value) ? fallback : `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const hasLivePortfolioValue = Number.isFinite(portfolio.totalValueUsd) && portfolio.totalValueUsd > 0;
  const value = portfolio.isDisconnected
    ? 'Connect wallet'
    : portfolio.isLoading
      ? 'Loading...'
      : portfolio.isWrongNetwork
        ? 'Switch to Arc Testnet'
        : portfolio.isError || hasBalanceReadError
          ? 'Balance unavailable'
        : portfolio.hasUnavailablePrices
          ? 'Price data unavailable'
          : hasLivePortfolioValue
            ? formatUsd(portfolio.totalValueUsd, '$0.00')
            : 'No balances';

  const allocationSegments = analytics.allocation
    .filter((asset) =>
      !analytics.valuationUnavailable &&
      asset.valueUsd !== null &&
      asset.valueUsd > 0 &&
      asset.allocationPercent !== null &&
      asset.allocationPercent > 0,
    )
    .map((asset) => `${asset.color} ${asset.allocationPercent}%`)
    .join(', ');

  return (
    <div className="space-y-6">
      <PageTitle
        label={`Manage / Portfolio / ${portfolioNetwork}`}
        title="Your assets, in focus."
        action={
          <Button
            variant="secondary"
            onClick={() => {
              if (isRefreshing) return;
              const startedAt = Date.now();
              setIsRefreshing(true);
              setRefreshError(null);
              void Promise.all([portfolio.refetch(), transactionsQuery.refetch()])
                .catch((error: unknown) => {
                  setRefreshError(error instanceof Error ? error.message : 'Portfolio refresh failed.');
                })
                .finally(() => {
                  const remainingFeedbackMs = Math.max(0, 350 - (Date.now() - startedAt));
                  window.setTimeout(() => setIsRefreshing(false), remainingFeedbackMs);
                });
            }}
            disabled={isRefreshing}
            className="gap-2"
          >
            <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
            {isRefreshing ? 'Refreshing...' : 'Refresh'}
          </Button>
        }
      />
      {refreshError && (
        <Card className="flex items-center gap-3 p-4 text-sm text-rose-200">
          <ShieldCheck size={16} />
          {refreshError}
        </Card>
      )}
      {portfolio.isDisconnected && (
        <Card className="flex items-center gap-3 p-4 text-sm text-slate-400">
          <Wallet size={16} className="text-cyan-300" />
          Connect your wallet to view live portfolio data.
        </Card>
      )}
      {portfolio.isWrongNetwork && (
        <Card className="flex items-center gap-3 p-4 text-sm text-amber-300">
          <ShieldCheck size={16} />
          Switch to Arc Testnet to view your portfolio.
        </Card>
      )}
      {portfolio.hasUnavailablePrices && !portfolio.isLoading && (
        <Card className="flex items-center gap-3 p-4 text-sm text-amber-300">
          <CircleDollarSign size={16} />
          Current USD valuation is unavailable because a funded asset has no usable price.
        </Card>
      )}
      {(portfolio.isError || hasBalanceReadError) && !portfolio.isLoading && !portfolio.isDisconnected && !portfolio.isWrongNetwork && (
        <Card className="flex items-center gap-3 p-4 text-sm text-rose-200">
          <ShieldCheck size={16} />
          The live {portfolioNetwork} balance could not be read. Try refreshing.
        </Card>
      )}
      {transactionsQuery.isError && !transactionsQuery.isLoading && isArcTestnet && (
        <Card className="flex items-center gap-3 p-4 text-sm text-amber-200">
          <Activity size={16} />
          Arc activity is temporarily unavailable. Your live balance remains available; try refreshing to load activity again.
        </Card>
      )}
      {analytics.zeroBalance && !portfolioUnavailable && !portfolio.isLoading && !portfolio.isError && (
        <Card className="flex items-center gap-3 p-4 text-sm text-slate-300">
          <Wallet size={16} className="text-cyan-300" />
          No supported asset balance is currently detected on {portfolioNetwork} for this wallet.
        </Card>
      )}
      <div className="grid items-start gap-4 lg:grid-cols-[1.35fr_1fr]">
        <Card className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Label>Total net worth</Label>
              <p className="mt-3 text-4xl font-extrabold tracking-[-0.06em]">{value}</p>
              <p className="mt-2 text-xs text-slate-500">
                USD value <span className="text-cyan-300">
                  {getPortfolioUsdStatusLabel(portfolio.isDisconnected, portfolio.isWrongNetwork)}
                </span>
              </p>
            </div>
            <div
              className="flex h-28 w-28 shrink-0 items-center justify-center rounded-full border border-slate-700/80 shadow-[0_18px_45px_rgba(125,211,252,0.12)]"
              style={{ background: allocationSegments ? `conic-gradient(${allocationSegments})` : '#182236' }}
            >
              <div className="flex h-[74%] w-[74%] items-center justify-center rounded-full bg-[#101725] text-center">
                <span className="font-mono text-[10px] text-slate-500">
                  {assetCountState.value}
                  <br />
                  {assetCountState.label}
                </span>
              </div>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-3 text-xs">
            {[
              ['Largest position', secondaryValue(analytics.topAsset ? `${analytics.topAsset.symbol} • ${analytics.topAsset.allocationPercent?.toFixed(1) ?? 'Unavailable'}%` : 'N/A')],
              ['Volatile exposure', secondaryValue(analytics.volatileExposurePercent === null ? 'Unavailable' : `${analytics.volatileExposurePercent.toFixed(1)}%`)],
              ['Stablecoin', secondaryValue(analytics.stablecoinExposurePercent === null ? 'Unavailable' : `${analytics.stablecoinExposurePercent.toFixed(1)}%`)],
            ].map(([label, valueText]) => (
              <div key={label} className="data-card rounded-xl px-3 py-2">
                <span className="text-slate-500">{label}</span>
                <p className="mt-1 font-semibold text-slate-200">{valueText}</p>
              </div>
            ))}
          </div>
          <div className="mt-5 rounded-2xl border border-dashed border-slate-700/80 bg-slate-950/40 p-4">
                <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-slate-500">{portfolioNetwork} snapshot</p>
            <p className="mt-2 text-sm text-slate-300">
              {analytics.history.available
                ? 'Historical portfolio snapshots are available for this wallet.'
                : 'ORBIT currently does not have a reliable historical portfolio snapshot or cost-basis record for this wallet, so this section intentionally avoids fabricated P&L.'}
            </p>
          </div>
        </Card>
        <Card className="h-fit p-5">
          <Label>Allocation</Label>
          <h2 className="mt-2 text-xl font-bold">By asset</h2>
          <div className="mt-4 space-y-3">
            {portfolio.assets.map((a) => (
              <div key={a.symbol} className="rounded-xl border border-white/[.06] bg-white/[.02] p-3">
                <div className="flex min-w-0 items-center justify-between gap-4">
                  <span className="flex min-w-0 items-center gap-2 font-semibold text-slate-200">
                    <i className="h-2.5 w-2.5 rounded-full" style={{ background: a.color }} />
                    <span className="truncate">{a.symbol}</span>
                  </span>
                  <div className="min-w-0 text-right">
                    <p className="truncate font-mono text-xs tabular-nums text-slate-200" title={`${a.formatted} ${a.symbol}`}>
                      {portfolioUnavailable ? unavailableLabel : `${a.formatted} ${a.symbol}`}
                    </p>
                    <p className="mt-1 font-mono text-[10px] tabular-nums text-slate-400">
                      {portfolioUnavailable ? unavailableLabel : analytics.valuationUnavailable ? 'Unavailable' : a.isLoading ? '...' : `${a.allocationPercent.toFixed(1)}%`}
                    </p>
                  </div>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-900/80">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${portfolioUnavailable || analytics.valuationUnavailable ? 0 : Math.max(4, a.allocationPercent)}%`, background: a.color }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <Card className="p-5">
          <Label>Performance</Label>
          <h2 className="mt-2 text-xl font-bold">Portfolio analytics</h2>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {[
              ['Current value', secondaryValue(formatUsd(portfolio.totalValueUsd, 'N/A'))],
              ['Top allocation', secondaryValue(analytics.topAsset ? `${analytics.topAsset.allocationPercent?.toFixed(1) ?? 'Unavailable'}%` : '0.0%')],
              ['USDC exposure', secondaryValue(analytics.stablecoinExposurePercent === null ? 'Unavailable' : `${analytics.stablecoinExposurePercent.toFixed(1)}%`)],
              ['Volatile exposure', secondaryValue(analytics.volatileExposurePercent === null ? 'Unavailable' : `${analytics.volatileExposurePercent.toFixed(1)}%`)],
            ].map(([label, metric]) => (
              <div key={label} className="data-card rounded-xl p-3">
                <p className="font-mono text-[9px] uppercase tracking-[0.15em] text-slate-500">{label}</p>
                <p className="mt-2 text-xl font-extrabold tracking-[-0.04em] text-white">{metric}</p>
              </div>
            ))}
          </div>
          <div className="mt-5 rounded-2xl border border-amber-300/15 bg-amber-300/[.05] p-4 text-sm text-amber-100">
            <p className="font-semibold">Performance methodology</p>
            <p className="mt-1 text-amber-100/80">
              {portfolioUnavailable
                ? portfolio.isDisconnected
                  ? 'Connect your wallet to assess current portfolio value and performance.'
                  : portfolio.isWrongNetwork
                    ? 'Switch to Arc Testnet to assess your portfolio.'
                    : 'The latest balance read failed; current portfolio value is unavailable until a successful refresh.'
                : analytics.performance.note}
            </p>
          </div>
        </Card>
        <Card className="p-5">
          <Label>Risk / exposure</Label>
          <h2 className="mt-2 text-xl font-bold">Portfolio signals</h2>
          <div className="mt-5 space-y-3">
            {portfolioUnavailable ? (
              <p className="text-sm text-slate-400">
                {portfolio.isDisconnected
                  ? 'Connect your wallet to assess portfolio risk.'
                  : portfolio.isWrongNetwork
                    ? 'Switch to Arc Testnet to assess portfolio risk.'
                    : 'Portfolio risk is unavailable because the latest balance read failed.'}
              </p>
            ) : analytics.valuationUnavailable ? (
              <p className="text-sm text-slate-400">Portfolio risk is unavailable because current asset pricing is incomplete.</p>
            ) : analytics.riskSignals.length === 0 ? (
              <p className="text-sm text-slate-400">No live risk signals available.</p>
            ) : (
              analytics.riskSignals.map((signal: { label: string; value: number; tone: string; detail: string }) => (
                <div key={signal.label} className="data-card rounded-xl p-3">
                  <div className="flex items-center justify-between">
                    <p className="font-semibold text-slate-200">{signal.label}</p>
                    <span className={`rounded-full border px-2 py-0.5 text-[9px] uppercase tracking-[.1em] ${signal.tone === 'warning' ? 'border-amber-300/30 bg-amber-300/10 text-amber-200' : 'border-cyan-300/30 bg-cyan-300/10 text-cyan-200'}`}>
                      {signal.value.toFixed(1)}%
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-slate-400">{signal.detail}</p>
                </div>
              ))
            )}
          </div>
          <p className="mt-4 text-[11px] text-slate-500">
            Informational only. These signals reflect current allocation and wallet activity, not financial advice.
          </p>
        </Card>
      </div>
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between p-5">
          <div>
            <Label>Portfolio history</Label>
            <h2 className="mt-2 text-xl font-bold">Recent portfolio signals</h2>
          </div>
          <button type="button" disabled title="Asset filtering is unavailable" className="cursor-not-allowed rounded-lg border border-white/10 p-2 text-slate-500 opacity-50" aria-label="Open asset filters">
            <SlidersHorizontal size={16} />
          </button>
        </div>
        <div className="border-t border-white/[.06] p-5">
          <div className="mb-4 rounded-xl border border-dashed border-slate-700/80 bg-slate-950/30 p-4 text-sm text-slate-300">
            <p className="font-semibold text-slate-200">{analytics.history.title}</p>
            <p className="mt-1 text-slate-400">{analytics.history.note}</p>
          </div>
          {transactionsQuery.isLoading ? (
            <div className="space-y-3">
              {[...Array(3)].map((_, index) => <div key={index} className="h-14 animate-pulse rounded-xl bg-white/[.04]" />)}
            </div>
          ) : transactionsQuery.isError ? (
            <div className="rounded-xl border border-dashed border-amber-300/20 bg-amber-300/[.04] p-4 text-sm text-amber-100">
              Arc activity could not be loaded.
            </div>
          ) : transactionsQuery.transactions.length > 0 ? (
            <div className="space-y-3">
              {transactionsQuery.transactions.slice(0, 5).map((transaction) => (
                <div key={transaction.hash} className="data-card flex items-center justify-between gap-3 rounded-xl p-3">
                  <div>
                    <p className="font-semibold text-slate-200">{transaction.category}</p>
                    <p className="mt-1 text-xs text-slate-400">{formatTransactionDate(transaction.timestamp)} on Arc Testnet</p>
                  </div>
                  <div className="text-right">
                    <a href={explorerTxUrl(transaction.hash, arcTestnet.id)} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-cyan-300 hover:text-cyan-200">{shortAddr(transaction.hash)}</a>
                    <p className="mt-1 text-[10px] text-slate-500">{transaction.status}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/30 p-4 text-sm text-slate-400">
              {isArcTestnet ? 'No recent Arc Testnet activity was found for this wallet.' : `No recent wallet signals were found for this account on ${portfolioNetwork}.`}
            </div>
          )}
        </div>
      </Card>
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between p-5">
          <div>
            <Label>Holdings</Label>
            <h2 className="mt-2 text-xl font-bold">All assets</h2>
          </div>
          <button type="button" disabled title="Holdings filtering is unavailable" className="cursor-not-allowed rounded-lg border border-white/10 p-2 text-slate-500 opacity-50" aria-label="Filter holdings">
            <SlidersHorizontal size={16} />
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="border-y border-white/[.06] font-mono text-[9px] uppercase tracking-widest text-slate-600">
              <tr>
                <th className="px-5 py-3">Asset</th>
                <th className="px-5 py-3">Balance</th>
                <th className="px-5 py-3">Value</th>
                <th className="px-5 py-3">Allocation</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[.05]">
              {portfolio.assets.map((a) => (
                <tr key={a.symbol} className="text-xs hover:bg-white/[.025]">
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-3">
                      <TokenIcon symbol={a.symbol} color={a.color} />
                      <div>
                        <p className="font-bold">{a.symbol}</p>
                        <p className="text-[10px] text-slate-500">{a.name}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-4 font-mono text-slate-300">
                    {portfolio.isDisconnected || portfolio.isWrongNetwork ? (
                      'Not assessed'
                    ) : a.isError ? (
                      'Unavailable'
                    ) : a.isLoading ? (
                      <span className="inline-block h-4 w-16 animate-pulse rounded bg-white/10" />
                    ) : a.raw > 0n ? (
                      a.formatted
                    ) : (
                      '0.000000'
                    )}
                  </td>
                  <td className="px-5 py-4 font-mono font-semibold text-slate-300">
                    {portfolioUnavailable ? unavailableLabel : analytics.valuationUnavailable ? 'Unavailable' : a.isLoading ? '...' : a.valueUsd === null ? 'N/A' : formatUsd(a.valueUsd, 'N/A')}
                  </td>
                  <td className="px-5 py-4 font-mono text-slate-500">
                    {portfolioUnavailable ? unavailableLabel : analytics.valuationUnavailable ? 'Unavailable' : a.isLoading ? '...' : `${a.allocationPercent.toFixed(1)}%`}
                  </td>
                  <td className="px-5 py-4 text-right">
                    <MoreHorizontal size={16} className="text-slate-500" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
function PageTitle({
  label,
  title,
  action,
}: {
  label: string;
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-shell flex flex-wrap items-end justify-between gap-4 rounded-2xl px-4 py-3 sm:px-5">
      <div>
        <Label>{label}</Label>
        <h1 className="mt-2 text-2xl font-extrabold tracking-[-0.04em] text-white sm:text-3xl">{title}</h1>
      </div>
      {action}
    </div>
  );
}
export function Security({ setPage }: { setPage: (p: Page) => void }) {
  const { address, isConnected, chainId } = useAccount();
  const approvalsQuery = useApprovals(true);
  const transactionsQuery = useTransactions(address, isConnected && chainId === arcTestnet.id && Boolean(address), chainId, false, true);
  const approvals = approvalsQuery.data?.approvals ?? [];
  const transactions = transactionsQuery.transactions ?? [];
  const isArcConnected = isConnected && chainId === ARC_TESTNET.id && Boolean(address);
  const isLoading = isArcConnected && (approvalsQuery.isFetching || transactionsQuery.isFetching);
  const scanErrors = approvalsQuery.data?.errors ?? [];
  const approvalsAvailable = approvalsQuery.data !== undefined && !approvalsQuery.isError;
  const activityAvailable = transactionsQuery.lastScannedAt !== null && !transactionsQuery.isError;
  const assessment = getSecurityAssessment({
    walletConnected: isConnected && Boolean(address),
    supportedNetwork: chainId === ARC_TESTNET.id,
    isScanning: isArcConnected && (approvalsQuery.isFetching || transactionsQuery.isFetching),
    providerRateLimited: !approvalsQuery.data?.isComplete && Boolean(
      (approvalsQuery.data?.retryAfterAt ?? 0) > Date.now() ||
      (approvalsQuery.cooldownUntil ?? 0) > Date.now(),
    ),
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
  const score = assessment.canCalculateScore && address
    ? calculateSecurityScore({
        approvals,
        transactions,
        walletAddress: address,
        isComplete: true,
      })
    : null;
  const scoreColor = score === null ? 'purple' : score >= 70 ? 'green' : score >= 40 ? 'amber' : 'red';
  const activeApprovals = approvals.filter((approval) => approval.allowance > 0n);
  const unlimitedCount = activeApprovals.filter((approval) => approval.isUnlimited).length;
  const highAllowanceCount = activeApprovals.filter((approval) => approval.risk === 'Medium').length;
  const failedTransactionCount = transactions.filter((transaction) => transaction.status === 'failed').length;
  const largeOutgoingCount = address ? countLargeOutgoingTransfers(transactions, address) : 0;
  const walletAddress = address?.toLowerCase();
  const knownTokenAddresses = new Set([ARC_USDC.address.toLowerCase()]);
  const unknownContractCount = new Set(
    transactions
      .filter((transaction) => ['Contract Interaction', 'Approval', 'Swap', 'Bridge', 'Lending'].includes(transaction.category))
      .map((transaction) => transaction.contractAddress || transaction.to)
      .filter((target) =>
        target &&
        target !== '0x' &&
        target.toLowerCase() !== walletAddress &&
        !knownTokenAddresses.has(target.toLowerCase()),
      ),
  ).size;
  const explorerUrl = ARC_TESTNET.blockExplorers.default.url;
  const refreshDisabled = !isArcConnected || approvalsQuery.isFetching || transactionsQuery.isFetching;

  return (
    <div className="space-y-6">
      <PageTitle
        label="Protect / Security Center"
        title="On-chain security scan"
        action={
          <Button
            variant="secondary"
            onClick={() => { void approvalsQuery.refetch(); void transactionsQuery.refetch(); }}
            disabled={refreshDisabled}
          >
            <RefreshCw size={15} className={approvalsQuery.isFetching || transactionsQuery.isFetching ? 'animate-spin' : ''} />
            {approvalsQuery.isFetching || transactionsQuery.isFetching ? 'Scanning...' : 'Refresh'}
          </Button>
        }
      />

      {!isConnected && (
        <Card className="p-6 text-sm text-slate-400" glow>
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-amber-400/10 p-2 text-amber-300"><Wallet size={18} /></div>
            <div>
              <p className="font-bold text-slate-200">Connect a wallet</p>
              <p className="mt-1">Connect a wallet to read its Arc Testnet approvals and recent activity.</p>
            </div>
          </div>
        </Card>
      )}

      {isConnected && chainId !== arcTestnet.id && (
        <Card className="border border-amber-300/20 bg-amber-300/[.06] p-4 text-sm text-amber-200" glow>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <ShieldCheck size={18} />
              <span>Scan unavailable: this Security Center currently supports Arc Testnet only.</span>
            </div>
            <Button variant="secondary" onClick={() => setPage('home')}>
              Switch to Arc Testnet
            </Button>
          </div>
        </Card>
      )}

      {isLoading && (
        <Card className="p-6" glow>
          <div className="space-y-3">
            {[...Array(5)].map((_, index) => (
              <div key={index} className="h-4 animate-pulse rounded bg-white/10" />
            ))}
          </div>
        </Card>
      )}
      {isArcConnected && !isLoading && (approvalsQuery.isError || transactionsQuery.isError) && (
        <Card className="border border-rose-400/20 bg-rose-400/[.04] p-4 text-sm text-rose-200" glow>
          <p className="font-bold">Scan incomplete: one or more data sources failed.</p>
          {approvalsQuery.error && <p className="mt-2">Approval RPC: {approvalsQuery.error.message}</p>}
          {transactionsQuery.error && <p className="mt-2">ArcScan activity: {transactionsQuery.error.message}</p>}
        </Card>
      )}
      {isArcConnected && scanErrors.length > 0 && (
        <Card className="border border-amber-300/20 bg-amber-300/[.04] p-4 text-sm text-amber-100">
          <p className="font-bold">Partial approval data</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {summarizeApprovalScanErrors(scanErrors).map((error) => <li key={error}>{error}</li>)}
          </ul>
          <details className="mt-3 text-xs text-amber-100/80">
            <summary className="cursor-pointer">Technical details ({scanErrors.length})</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {scanErrors.map((error, index) => <li key={`${index}:${error}`}>{error}</li>)}
            </ul>
          </details>
        </Card>
      )}

      {isArcConnected && !isLoading && (
        <>
          <Card className="relative overflow-hidden p-6" glow>
            <div className="relative flex flex-wrap items-center gap-6">
              <div className={`grid h-12 w-12 shrink-0 place-items-center text-[#d2b779] ${score === null ? 'rounded-xl border border-[#c6a76a]/25 bg-[#c6a76a]/[.07]' : `rounded-full border-4 ${score >= 70 ? 'border-emerald-400' : score >= 40 ? 'border-amber-400' : 'border-rose-400'}`}`}>
                {score === null
                  ? <ShieldCheck size={22} strokeWidth={1.7} aria-hidden="true" />
                  : <span className="font-mono text-base font-semibold tabular-nums">{score}</span>}
              </div>
              <div className="min-w-[240px] flex-1">
                <Pill color={scoreColor}>{score === null ? assessment.status : 'Limited risk indicator'}</Pill>
                <h2 className="mt-3 text-xl font-bold">Arc Testnet · {address ? shortAddr(address) : ''}</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
                  {score === null
                    ? assessment.description
                    : 'This deterministic score reflects only the completed checks and observed data window; it is not a guarantee that the wallet is safe.'}
                </p>
                <p className="mt-3 text-xs text-slate-500">
                  Last activity refresh: {transactionsQuery.lastScannedAt ? new Date(transactionsQuery.lastScannedAt).toLocaleString() : 'Not scanned'}
                  {' · '}Approval snapshot block: {approvalsQuery.data?.scannedToBlock.toString() ?? 'Not scanned'}
                  {approvalsQuery.data && ` · Approval scan attempt: ${new Date(approvalsQuery.data.lastScanAttemptAt).toLocaleString()}`}
                </p>
              </div>
            </div>
          </Card>

          <Card className="p-5">
            <Label>Scoring method and coverage</Label>
            <p className="mt-2 text-sm leading-6 text-slate-300">
              If every required check is complete, the model starts at 100 and subtracts 25 per unlimited allowance (maximum 60); 15 per verified finite allowance of at least 1,000,000 token units (maximum 30); 5 per failed recent transaction (maximum 20); and 10 per successful transaction with at least one outgoing native Arc USDC or supported USDC transfer of at least 100 units (maximum 20). The result is clamped at 0. Unrecognized contracts and spenders are informational only and never treated as malicious. A numeric score is withheld unless supported approval history begins at block 0 and every required data source is available.
            </p>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              Approval source: Arc Testnet RPC Approval logs and allowance() at one snapshot block, limited to configured tokens. The default recent-history window is 50,000 blocks, configurable up to 250,000; successful ranges are cached locally and resumed incrementally. The exact covered boundary is blocks {approvalsQuery.data?.scannedFromBlock.toString() ?? '—'}–{approvalsQuery.data?.scannedToBlock.toString() ?? '—'} per token. A scan beginning after block 0 is a selected-window assessment, not a lifetime audit or complete security guarantee. Activity source: ArcScan recent transactions and token transfers (up to 20 items each).
            </p>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <Card className="p-5">
              <Label>Observed approval findings</Label>
              <h2 className="mt-2 text-xl font-bold">
                {!approvalsAvailable
                  ? 'Approval state Unknown'
                  : approvalsQuery.data?.isComplete
                    ? `${activeApprovals.length} active · ${approvals.length - activeApprovals.length} zero in window`
                    : approvals.length === 0
                      ? 'Approval count Unknown'
                      : `${activeApprovals.length} active found · partial scan`}
              </h2>
              <p className="mt-2 text-xs text-slate-500">
                Current allowance values were read at block {approvalsQuery.data?.scannedToBlock.toString() ?? '—'}.
              </p>
              {approvalsQuery.isError ? (
                <p className="mt-4 text-sm text-rose-200">Approval data is unavailable for this scan.</p>
              ) : !approvalsQuery.data ? (
                <p className="mt-4 text-sm text-slate-400">Approval scan has not completed.</p>
              ) : approvals.length === 0 ? (
                <p className="mt-4 text-sm text-slate-400">
                  {approvalsQuery.data.isComplete
                    ? `No Approval events were found in the configured token set and block window ${approvalsQuery.data.scannedFromBlock.toString()}–${approvalsQuery.data.scannedToBlock.toString()}; older approvals may not be included.`
                    : 'No approvals were returned in the successfully scanned ranges, but coverage is incomplete. Do not interpret this as zero approvals.'}
                </p>
              ) : (
                <div className="mt-4 space-y-3">
                  {approvals.map((approval) => (
                    <div key={approval.id} className="rounded-xl border border-white/10 bg-white/[.02] p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <a className="font-bold text-slate-200 hover:text-cyan-300" href={`${explorerUrl}/address/${approval.token.address}`} target="_blank" rel="noreferrer">
                            {approval.token.symbol} contract <ExternalLink className="inline" size={12} />
                          </a>
                          <a className="mt-1 block break-all font-mono text-[10px] text-slate-500 hover:text-cyan-300" href={`${explorerUrl}/address/${approval.spenderAddress}`} target="_blank" rel="noreferrer">
                            Spender {approval.spenderAddress}
                          </a>
                          <p className="mt-1 text-[10px] text-slate-500">
                            Event block {approval.lastSeenBlock.toString()} · Token {approval.tokenVerified === true ? 'verified by ArcScan' : approval.tokenVerified === false ? 'not verified by ArcScan' : 'verification unavailable'}
                          </p>
                          <p className="text-[10px] text-slate-500">
                            Spender {approval.spenderVerified === true ? 'verified by ArcScan' : approval.spenderVerified === false ? 'not verified by ArcScan' : 'verification unavailable'}
                          </p>
                        </div>
                        <Pill color={approval.allowance === 0n ? 'purple' : approval.isUnlimited ? 'red' : approval.risk === 'Medium' ? 'amber' : 'green'}>
                          {approval.allowance === 0n ? 'Revoked / zero' : approval.isUnlimited ? 'Unlimited' : approval.risk === 'Medium' ? 'High allowance' : 'Limited'}
                        </Pill>
                      </div>
                      <p className="mt-2 break-all font-mono text-xs text-slate-300">Allowance: {approval.allowanceFormatted} {approval.token.symbol}</p>
                    </div>
                  ))}
                </div>
              )}
              <Button className="mt-4 w-full" variant="secondary" onClick={() => setPage('approvals')}>
                Review approval details
              </Button>
            </Card>

            <Card className="p-5">
              <Label>Recent activity signals</Label>
              <h2 className="mt-2 text-xl font-bold">Observed transactions</h2>
              <div className="mt-4 space-y-3 text-sm">
                <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[.02] p-3">
                  <span className="text-slate-400">Unlimited active allowances</span>
                  <strong className="text-slate-200">{approvalsAvailable ? unlimitedCount : 'Unknown'}</strong>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[.02] p-3">
                  <span className="text-slate-400">High finite allowances</span>
                  <strong className="text-slate-200">{approvalsAvailable ? highAllowanceCount : 'Unknown'}</strong>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[.02] p-3">
                  <span className="text-slate-400">Failed transactions in recent page</span>
                  <strong className="text-slate-200">{activityAvailable ? failedTransactionCount : 'Unknown'}</strong>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[.02] p-3">
                  <span className="text-slate-400">Outgoing transfers ≥ 100 USDC units</span>
                  <strong className="text-slate-200">{activityAvailable ? largeOutgoingCount : 'Unknown'}</strong>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[.02] p-3">
                  <span className="text-slate-400">Unrecognized contract interactions</span>
                  <strong className="text-slate-200">{activityAvailable ? unknownContractCount : 'Unknown'}</strong>
                </div>
              </div>
              <p className="mt-4 text-xs leading-5 text-slate-500">
                “Unrecognized” means the address is not in ORBIT’s small configured token set. It is not a maliciousness verdict.
              </p>
            </Card>
          </div>

          <Card className="p-5" glow>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div>
                <Label>ArcScan · latest page</Label>
                <h2 className="mt-2 text-xl font-bold">Transactions and token transfers</h2>
              </div>
              <Pill color={transactions.length === 0 ? 'purple' : 'green'}>{transactions.length} transactions</Pill>
            </div>
            {transactionsQuery.isError ? (
              <p className="py-8 text-center text-sm text-rose-200">Recent activity is unavailable from ArcScan.</p>
            ) : transactionsQuery.lastScannedAt === null ? (
              <p className="py-8 text-center text-sm text-slate-400">Recent activity scan has not completed.</p>
            ) : transactions.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-400">No transactions or token transfers were returned for this wallet.</p>
            ) : (
              <div className="space-y-3">
                {transactions.map((transaction) => (
                  <div key={transaction.hash} className="rounded-xl border border-white/10 bg-white/[.02] p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <a className="font-mono text-xs text-cyan-300 hover:underline" href={`${explorerUrl}/tx/${transaction.hash}`} target="_blank" rel="noreferrer">
                          {shortAddr(transaction.hash)} <ExternalLink className="inline" size={12} />
                        </a>
                        <p className="mt-1 text-xs text-slate-400">{transaction.category} · {transaction.status} · {formatTransactionDate(transaction.timestamp)}</p>
                      </div>
                      {transaction.blockNumber !== null && <span className="font-mono text-[10px] text-slate-500">Block {transaction.blockNumber}</span>}
                    </div>
                    <p className="mt-2 break-all font-mono text-[10px] text-slate-500">To {transaction.to}</p>
                    {transaction.tokenTransfers.length > 0 && (
                      <div className="mt-2 space-y-1 border-t border-white/[.06] pt-2">
                        {transaction.tokenTransfers.map((transfer, index) => (
                          <p key={`${transfer.hash}:${transfer.contractAddress}:${index}`} className="text-xs text-slate-300">
                            {transfer.direction === 'sent' ? 'Sent' : 'Received'} {transfer.amount} {transfer.symbol}
                            {' · '}
                            <a className="font-mono text-cyan-300 hover:underline" href={`${explorerUrl}/address/${transfer.contractAddress}`} target="_blank" rel="noreferrer">
                              token contract {shortAddr(transfer.contractAddress)}
                            </a>
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
function Approvals() {
  const { address, isConnected, chainId } = useAccount();
  const approvalsQuery = useApprovals(true);
  const { revoke, activeApprovalId, status, transactionHash, error, retryRevokeCheck } = useRevokeApproval();
  const [cooldownClock, setCooldownClock] = useState(Date.now());
  const [approvalToConfirm, setApprovalToConfirm] = useState<TokenApproval | null>(null);
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [riskFilter, setRiskFilter] = useState('all');
  const [copiedApprovalAddress, setCopiedApprovalAddress] = useState<string | null>(null);
  const [approvalCopyError, setApprovalCopyError] = useState<string | null>(null);
  const approvals = approvalsQuery.data?.approvals ?? [];
  const copyApprovalAddress = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedApprovalAddress(value);
      setApprovalCopyError(null);
    } catch (caughtError) {
      setApprovalCopyError(caughtError instanceof Error ? caughtError.message : 'Unable to copy address.');
    }
  };
  const filteredApprovals = approvals.filter((approval) => {
    const query = searchText.trim().toLowerCase();
    const matchesSearch = !query || [
      approval.token.name,
      approval.token.symbol,
      approval.token.address,
      approval.spenderAddress,
    ].some((value) => value.toLowerCase().includes(query));
    const matchesStatus = statusFilter === 'all' ||
      (statusFilter === 'active' ? approval.allowance > 0n : approval.allowance === 0n);
    return matchesSearch && matchesStatus && (riskFilter === 'all' || approval.risk === riskFilter);
  });
  const activeAllowanceCount = approvals.filter((approval) => approval.allowance > 0n).length;
  const approvalCoverage = approvalsQuery.data
    ? getApprovalCoveragePercent(approvalsQuery.data.coveredBlocks, approvalsQuery.data.totalBlocks)
    : 0;
  const cooldownActive = approvalsQuery.cooldownUntil !== null &&
    approvalsQuery.cooldownUntil > cooldownClock;
  const approvalScanStatus = getApprovalScanStatus({
    isFetching: approvalsQuery.isFetching,
    isError: approvalsQuery.isError,
    data: approvalsQuery.data,
    now: cooldownClock,
  });
  const providerLimitEncountered = !approvalsQuery.data?.isComplete && (
    approvalScanStatus === 'Partial scan — provider limit' || cooldownActive
  );
  const approvalScanStatusLabel = approvalScanStatus ?? (
    providerLimitEncountered
      ? 'Partial scan — provider limit'
      : !isConnected ? 'Connect wallet' : chainId !== arcTestnet.id ? 'Assessment unavailable' : 'Scan required'
  );
  useEffect(() => {
    if (!cooldownActive || approvalsQuery.cooldownUntil === null) return;
    const timer = window.setTimeout(
      () => setCooldownClock(Date.now()),
      Math.max(0, approvalsQuery.cooldownUntil - Date.now() + 20),
    );
    return () => window.clearTimeout(timer);
  }, [approvalsQuery.cooldownUntil, cooldownActive]);
  const explorerUrl = ARC_TESTNET.blockExplorers.default.url;
  return (
    <div className="space-y-6">
      <PageTitle
        label="Protect / Approvals & Revoke"
        title="Take back control."
        action={
          <Button variant="secondary" onClick={approvalsQuery.refetch} disabled={!isConnected || chainId !== arcTestnet.id || approvalsQuery.isFetching || cooldownActive || status === "pending" || status === 'checking' || status === 'confirmation-pending' || status === 'verification-pending'}>
            <RefreshCw size={15} className={approvalsQuery.isFetching ? 'animate-spin' : ''} />
            {approvalsQuery.isFetching ? "Scanning..." : cooldownActive ? "Provider cooldown" : "Refresh scan"}
          </Button>
        }
      />
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[.06] p-5">
          <div>
            <Label>Approval scanner</Label>
            <p className="mt-2 text-sm text-slate-400">
              {!isConnected
                ? "Connect your wallet to scan approvals."
                : approvalsQuery.isFetching && !approvalsQuery.data
                  ? "Scanning configured Arc Testnet token Approval events..."
                  : approvalsQuery.isError && !approvalsQuery.data
                    ? "Approval scan unavailable."
                    : approvalsQuery.data === undefined
                      ? "Waiting for the connected Arc Testnet wallet scan."
                      : `${approvals.length} discovered spender records; ${activeAllowanceCount} currently have nonzero allowance among those checked records. Blocks ${approvalsQuery.data.scannedFromBlock.toString()}–${approvalsQuery.data.scannedToBlock.toString()}.`}
            </p>
            {approvalsQuery.data && (
              <p className="mt-1 text-xs text-slate-500">
                Last successful log range {approvalsQuery.data.lastSuccessfulAt === null
                  ? 'not yet recorded'
                  : new Date(approvalsQuery.data.lastSuccessfulAt).toLocaleString()}.
                {approvalsQuery.data.historyWindowBlocks.toLocaleString()}-block configured-token window, blocks {approvalsQuery.data.scannedFromBlock.toString()}–{approvalsQuery.data.scannedToBlock.toString()}; this is not a lifetime inventory.
              </p>
            )}
            {cooldownActive && approvalsQuery.cooldownUntil !== null && (
              <p className="mt-1 text-xs text-amber-200">
                Provider cooldown until {new Date(approvalsQuery.cooldownUntil).toLocaleTimeString()}; refresh is disabled and no log requests will be sent before then.
              </p>
            )}
          </div>
          <Pill color={approvalScanStatusLabel === 'Window complete' ? 'green' : approvalScanStatusLabel === 'Scanning' ? 'cyan' : 'amber'}>
            {approvalScanStatusLabel}
          </Pill>
        </div>
        {approvalsQuery.data && (
          <div className="border-b border-white/[.06] px-5 py-3 text-xs text-slate-400">
            <p>{approvalCoverage.toFixed(2)}% of the selected {approvalsQuery.data.historyWindowBlocks.toLocaleString()}-block window checked · {activeAllowanceCount} active allowance{activeAllowanceCount === 1 ? '' : 's'} among {approvals.length} discovered spender records whose current allowance was checked. A 0 count is limited to these records; this is not full historical wallet coverage.</p>
            {approvalsQuery.isFetching && <p className="mt-1 text-cyan-200">Continuing scan; previous successful results remain visible.</p>}
            {approvalsQuery.isError && <p role="alert" className="mt-1 text-amber-200">Refresh failed; showing the last successful scan. Retry with Refresh scan.</p>}
          </div>
        )}
        {approvalsQuery.isError && !approvalsQuery.data && (
          <div role="alert" className="border-b border-rose-300/10 px-5 py-3 text-xs text-rose-200">
            Approval scan unavailable. <details className="mt-1"><summary className="cursor-pointer">Technical diagnostics</summary>{approvalsQuery.error?.message}</details>
          </div>
        )}
        <p className="border-b border-white/[.06] px-5 py-3 text-xs leading-5 text-slate-400">
          Approval coverage is always bounded to the selected block range and configured tokens; it is not full historical wallet coverage. Revoke is enabled only when ArcScan reports both the configured token and spender as verified contracts; that explorer metadata is not an independent audit or a safety guarantee. “UNKNOWN” risk is separate from ArcScan verification: even a contract marked verified can have UNKNOWN risk when its allowance is zero and not risk-rated, or when the paired token/spender verification is incomplete or unavailable. “Already zero” means a current allowance read returned zero before any revoke was sent; it is not a confirmed revoke transaction. A revoke is confirmed only after a successful receipt and a post-transaction zero-allowance check.
        </p>
        {approvalsQuery.data && (
          <div className="flex flex-col gap-2 border-b border-white/[.06] px-5 py-3 sm:flex-row">
            <input
              type="search"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="Search token or spender"
              aria-label="Search approval records"
              className="h-9 min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[.03] px-3 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-emerald-300/40"
            />
            <select aria-label="Filter allowance status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="h-9 rounded-lg border border-white/10 bg-[#0b1212] px-3 text-xs text-slate-300">
              <option value="all">All allowance states</option>
              <option value="active">Nonzero / active</option>
              <option value="zero">Zero / revoked</option>
            </select>
            <select aria-label="Filter approval risk" value={riskFilter} onChange={(event) => setRiskFilter(event.target.value)} className="h-9 rounded-lg border border-white/10 bg-[#0b1212] px-3 text-xs text-slate-300">
              <option value="all">All risk labels</option>
              <option value="High">High</option>
              <option value="Medium">Medium</option>
              <option value="Low">Low</option>
              <option value="Unknown">Unassessed</option>
            </select>
          </div>
        )}
        {approvalsQuery.data && approvalsQuery.data.errors.length > 0 && (
          <div className="border-b border-white/[.06] px-5 py-3 text-xs text-amber-200">
            {summarizeApprovalScanErrors(approvalsQuery.data.errors).map((scanError) => <p key={scanError}>{scanError}</p>)}
            <details className="mt-2 text-slate-400">
              <summary className="cursor-pointer">Technical details ({approvalsQuery.data.errors.length})</summary>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {approvalsQuery.data.errors.map((scanError, index) => <li key={`${index}:${scanError}`}>{scanError}</li>)}
              </ul>
            </details>
          </div>
        )}
        {status === "success" && transactionHash && (
          <p className="border-b border-white/[.06] px-5 py-3 text-xs text-emerald-300">
            Revoke receipt confirmed and a fresh on-chain read verified zero allowance. <a href={explorerTxUrl(transactionHash)} target="_blank" rel="noopener noreferrer" className="underline">View on ArcScan</a>
          </p>
        )}
        {status === 'already-zero' && <p role="status" className="border-b border-white/[.06] px-5 py-3 text-xs text-slate-300">A fresh on-chain read found zero allowance; no transaction was submitted.</p>}
        {(status === 'confirmation-pending' || status === 'verification-pending') && error && (
          <div role="status" className="flex flex-wrap items-center gap-2 border-b border-amber-300/10 px-5 py-3 text-xs text-amber-200">
            <span>{error.message}</span>
            {transactionHash && <a href={explorerTxUrl(transactionHash)} target="_blank" rel="noopener noreferrer" className="underline">View on ArcScan</a>}
            <button type="button" onClick={() => void retryRevokeCheck()} className="underline">
              {status === 'confirmation-pending' ? 'Retry confirmation check' : 'Retry allowance check'}
            </button>
          </div>
        )}
        {status === "error" && error && <p className="border-b border-white/[.06] px-5 py-3 text-xs text-rose-300">{error.message}</p>}
        {!isConnected ? (
          <p className="p-12 text-center text-xs text-slate-500">Connect your wallet to scan token approvals.</p>
        ) : chainId !== arcTestnet.id ? (
          <p className="p-12 text-center text-xs text-amber-300">Switch to Arc Testnet to view Arc approvals.</p>
        ) : approvalsQuery.isFetching && !approvalsQuery.data ? (
          <p className="p-12 text-center text-xs text-slate-500">Scanning Arc token approvals...</p>
        ) : approvalsQuery.isError && !approvalsQuery.data ? (
          <p className="p-12 text-center text-xs text-rose-300">Unable to scan approvals. Try refreshing.</p>
        ) : approvalsQuery.data === undefined ? (
          <p className="p-12 text-center text-xs text-slate-400">Run a scan to check your approvals.</p>
        ) : approvals.length === 0 ? (
          <p className="p-12 text-center text-xs text-slate-400">
            {approvalsQuery.data.isComplete
              ? `No Approval event records found for configured tokens in the selected block window ${approvalsQuery.data.scannedFromBlock.toString()}–${approvalsQuery.data.scannedToBlock.toString()}. Allowances predating that window may not be represented.`
              : 'Approval scan coverage is incomplete. No approval events were returned in the successful ranges, so this is not a definitive zero-approval result.'}
          </p>
        ) : filteredApprovals.length === 0 ? (
          <p className="p-10 text-center text-xs text-slate-400">No observed spender records match these filters.</p>
        ) : <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-left">
            <thead className="border-b border-white/[.06] font-mono text-[9px] uppercase tracking-widest text-slate-600">
              <tr>
                <th className="px-5 py-3">Token</th>
                <th className="px-5 py-3">Spender</th>
                <th className="px-5 py-3">Allowance</th>
                <th className="px-5 py-3">Risk</th>
                <th className="px-5 py-3">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[.05]">
              {filteredApprovals.map((a) => (
                <tr
                  key={a.id}
                  className="text-xs hover:bg-white/[.025]"
                >
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-2">
                      <TokenIcon symbol={a.token.symbol} color={a.token.color} />
                      <div>
                        <b>{a.token.name}</b>
                        <p className="font-mono text-[9px] text-slate-600">{a.token.symbol}</p>
                        <p className="text-[9px] text-slate-500">Arc Testnet</p>
                        <a className="font-mono text-[8px] text-cyan-300 hover:underline" href={`${explorerUrl}/address/${a.token.address}`} target="_blank" rel="noreferrer">
                          {shortAddr(a.token.address)} <ExternalLink className="inline" size={10} />
                        </a>
                        <button type="button" onClick={() => void copyApprovalAddress(a.token.address)} className="ml-2 text-[9px] text-slate-500 underline">
                          {copiedApprovalAddress === a.token.address ? 'Copied' : 'Copy'}
                        </button>
                        <p className="text-[9px] text-slate-500">
                          {a.tokenVerified === true ? 'Verified on ArcScan' : a.tokenVerified === false ? 'Not verified on ArcScan' : 'Verification unavailable'}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-4 font-semibold">
                    <a className="font-mono text-[10px] text-cyan-300 hover:underline" href={`${explorerUrl}/address/${a.spenderAddress}`} target="_blank" rel="noreferrer">
                      {shortAddr(a.spenderAddress)} <ExternalLink className="inline" size={10} />
                    </a>
                    <button type="button" onClick={() => void copyApprovalAddress(a.spenderAddress)} className="ml-2 text-[9px] text-slate-500 underline">
                      {copiedApprovalAddress === a.spenderAddress ? 'Copied' : 'Copy'}
                    </button>
                    <p className="break-all font-mono text-[9px] text-slate-600">{a.spenderAddress}</p>
                    <p className="mt-1 text-[9px] text-slate-500">
                      {a.spenderVerified === true
                        ? 'Verified on ArcScan'
                        : a.spenderVerified === false
                          ? 'Not verified on ArcScan'
                          : 'Verification unavailable'}
                    </p>
                  </td>
                  <td className="px-5 py-4 font-mono text-slate-400">
                    {a.allowance === 0n ? '0' : a.isUnlimited ? 'Unlimited' : a.allowanceFormatted}
                    <p className="mt-1 text-[9px] text-slate-500">{a.status} · {a.allowance === 0n ? 'zero / revoked' : 'current allowance'}</p>
                    <p className="mt-1 text-[9px] text-slate-600">Verified at block {a.allowanceCheckedBlock.toString()} · {new Date(a.allowanceCheckedAt).toLocaleString()}</p>
                  </td>
                  <td className="px-5 py-4">
                    <span title={a.risk === 'Unknown' ? 'UNKNOWN can mean the allowance is zero and not risk-rated, or token/spender verification is incomplete or unavailable. This is separate from whether ArcScan marks either contract verified.' : a.status}>
                      <Pill
                        color={
                        a.risk === "High"
                          ? "red"
                          : a.risk === "Medium"
                            ? "amber"
                            : a.risk === "Low" ? "green" : "purple"
                        }
                      >
                        {a.risk}
                      </Pill>
                    </span>
                  </td>
                  <td className="px-5 py-4 text-right">
                    <Button
                      variant="secondary"
                      onClick={() => setApprovalToConfirm(a)}
                      disabled={status === "pending" || status === 'checking' || status === 'confirmation-pending' || status === 'verification-pending' || !canRevokeApproval(a)}
                    >
                      {status === "checking" && activeApprovalId === a.id
                        ? "Checking allowance..."
                        : status === "pending" && activeApprovalId === a.id
                        ? "Confirm in wallet..."
                        : a.allowance === 0n
                          ? "Already zero"
                          : canRevokeApproval(a)
                            ? "Revoke"
                            : a.tokenVerified === null || a.spenderVerified === null
                              ? "Verify unavailable"
                              : "Not verified"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>}
        {approvalToConfirm && <div className="space-y-3 border-t border-rose-300/10 bg-rose-300/[.025] p-5" aria-label="Review approval revocation"><div><p className="text-sm font-semibold text-slate-100">Review permission change</p><p className="mt-1 text-xs leading-5 text-slate-400">This transaction sets the allowance to zero. Your wallet will still request its own signature.</p></div><dl className="grid gap-3 text-xs sm:grid-cols-3"><div><dt className="text-slate-500">Token</dt><dd className="mt-1 text-slate-200">{approvalToConfirm.token.symbol}</dd></div><div><dt className="text-slate-500">Current permission</dt><dd className="mt-1 text-slate-200">{approvalToConfirm.isUnlimited ? 'Unlimited' : `${approvalToConfirm.allowanceFormatted} ${approvalToConfirm.token.symbol}`}</dd></div><div><dt className="text-slate-500">Spender</dt><dd className="mt-1 break-all font-mono text-slate-200">{approvalToConfirm.spenderAddress}</dd></div></dl>{activeApprovalId === approvalToConfirm.id && status === "already-zero" && <p role="status" className="text-xs text-slate-300">A fresh on-chain read found zero allowance. No transaction was submitted.</p>}{activeApprovalId === approvalToConfirm.id && error && <p role="alert" className="text-xs text-rose-200">{error.message}</p>}<SlideToConfirm label="Slide to revoke" confirmationKey={`${address?.toLowerCase() ?? ''}:${chainId ?? ''}:${approvalToConfirm.id}:${approvalToConfirm.allowance.toString()}`} phase={activeApprovalId !== approvalToConfirm.id ? 'idle' : status === 'checking' || status === 'confirmation-pending' ? 'submitting' : status === 'pending' || status === 'verification-pending' ? 'pending' : status === 'success' ? 'success' : status === 'error' ? 'failed' : 'idle'} disabled={!canRevokeApproval(approvalToConfirm) || (activeApprovalId === approvalToConfirm.id && Boolean(transactionHash))} onConfirm={() => revoke(approvalToConfirm)} /><Button variant="secondary" className="w-full" disabled={status === 'checking' || status === 'confirmation-pending' || status === 'pending' || status === 'verification-pending'} onClick={() => setApprovalToConfirm(null)}>Cancel</Button></div>}
        {approvalCopyError && <p role="status" className="border-t border-white/[.06] px-5 py-2 text-[10px] text-amber-200">{approvalCopyError}</p>}
      </Card>
    </div>
  );
}
function calculateMinimumReceived(amountOut: bigint | null, slippageBps: number): bigint | null {
  if (amountOut === null || amountOut <= 0n) return null;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) return null;
  return amountOut * BigInt(10_000 - slippageBps) / 10_000n;
}

function formatPercent(label: number | null | undefined): string {
  if (label === null || label === undefined || !Number.isFinite(label) || label < 0) return 'Not provided by route';
  return `${label.toFixed(2)}%`;
}

function BridgeBalanceHasEnough(raw: bigint | null, requested: bigint | null): boolean {
  return Boolean(raw !== null && requested !== null && raw >= requested);
}

export function ActionPage({ type }: { type: "swap" | "bridge" }) {
  const isSwap = type === "swap";
  const isBridge = type === "bridge";
  const reduceMotion = useReducedMotion();
  const { address, isConnected, chainId, connector } = useAccount();
  const { switchChainAsync, isPending: bridgeNetworkSwitchPending } = useSwitchChain();
  const portfolio = usePortfolio();
  const [fromSymbol, setFromSymbol] = useState("ETH");
  const [toSymbol, setToSymbol] = useState("USDC");
  const [swapAmount, setSwapAmount] = useState("");
  const fromAsset = BASE_SWAP_ASSETS.find((asset) => asset.symbol === fromSymbol) ?? BASE_SWAP_ASSETS[0];
  const toAsset = BASE_SWAP_ASSETS.find((asset) => asset.symbol === toSymbol) ?? BASE_SWAP_ASSETS[1];
  const fromBalance = portfolio.assets.find((asset) => asset.symbol === fromAsset.symbol);
  let rawSwapAmount: bigint | null = null;
  try { rawSwapAmount = swapAmount ? parseUnits(swapAmount, fromAsset.decimals) : null; } catch { rawSwapAmount = null; }
  const swapAmountValid = rawSwapAmount !== null && rawSwapAmount > 0n;
  const swapAmountError = swapAmount && rawSwapAmount === null ? "Invalid amount" : rawSwapAmount !== null && fromBalance && rawSwapAmount > fromBalance.raw ? "Insufficient balance" : null;
  const { quote, isLoading: isQuoteLoading, isFetching: isQuoteFetching, isError: isQuoteError, error: quoteError, provider: quoteProvider } = useSwapQuote(fromAsset, toAsset, isSwap && swapAmountValid && fromSymbol !== toSymbol ? rawSwapAmount : null, address);
  const swapApproval = useSwapApproval(fromAsset, address, quote?.routerAddress ?? null, rawSwapAmount);
  const swapExecution = useSwapExecution();
  const [slippageBps, setSlippageBps] = useState(50);
  useEffect(() => {
    swapExecution.reset();
  }, [fromSymbol, toSymbol, swapAmount, swapExecution]);
  const [showSwapConfirmation, setShowSwapConfirmation] = useState(false);
  const swapDirection = () => { setFromSymbol(toSymbol); setToSymbol(fromSymbol); setSwapAmount(""); };
  const quoteFresh = Boolean(quote && Date.now() - quote.quotedAt <= 15_000);
  const minimumReceived = quoteFresh ? calculateMinimumReceived(quote?.amountOut ?? null, slippageBps) : null;
  const swapReady = Boolean(isConnected && chainId === base.id && quote && quoteFresh && quote.amountIn === rawSwapAmount && swapAmountValid && !swapAmountError && !swapApproval.isApprovalRequired && !swapApproval.isLoading);
  const allBridgeNetworks: BridgeChain[] = ORBIT_NETWORKS.map((network) => ({ id: network.id, name: network.name }));
  const [bridgeFromChainId, setBridgeFromChainId] = useState(ARC_PRIMARY_NETWORK.id); // Bidirectional: any supported network can be source
  const [bridgeToChainId, setBridgeToChainId] = useState(CCTP_BRIDGE_NETWORKS.find((network) => network.id !== ARC_PRIMARY_NETWORK.id)?.id ?? ARC_PRIMARY_NETWORK.id);
  const bridgeSymbol = "USDC";
  const [bridgeAmount, setBridgeAmount] = useState("");
  const [showBridgeConfirmation, setShowBridgeConfirmation] = useState(false);
  const [reviewedBridgeQuote, setReviewedBridgeQuote] = useState<BridgeQuote | null>(null);
  const bridgeTimingRef = useRef<ArcForwardingTiming>();
  const [bridgeNetworkSwitchError, setBridgeNetworkSwitchError] = useState<Error | null>(null);
  const bridgeFromChain: BridgeChain = { id: bridgeFromChainId, name: getOrbitNetwork(bridgeFromChainId)?.name ?? "Unknown" };
  const bridgeToChain: BridgeChain = { id: bridgeToChainId, name: getOrbitNetwork(bridgeToChainId)?.name ?? "Unknown" };
  const bridgeRouteSelectable = bridgeFromChainId === ARC_PRIMARY_NETWORK.id && bridgeToChainId === ETHEREUM_SEPOLIA.id;
  const bridgeRoutePreference = bridgeRouteSelectable ? "auto" : undefined;
  const bridgeSameNetwork = bridgeFromChainId === bridgeToChainId; // Prevent same-network bridging
  const bridgeTokensQuery = useBridgeTokens();
  const bridgeFromToken = bridgeTokensQuery.tokens.find((token) => token.chainId === bridgeFromChainId && token.symbol === bridgeSymbol);
  const bridgeToToken = bridgeTokensQuery.tokens.find((token) => token.chainId === bridgeToChainId && token.symbol === bridgeSymbol);
  let rawBridgeAmount: bigint | null = null;
  try { rawBridgeAmount = bridgeAmount && bridgeFromToken ? parseUnits(bridgeAmount, bridgeFromToken.decimals) : null; } catch { rawBridgeAmount = null; }
  const bridgeBalance = useBridgeBalance(bridgeFromToken, address, isConnected);
  const bridgeAmountError = bridgeAmount && rawBridgeAmount === null ? "Invalid amount" : rawBridgeAmount !== null && rawBridgeAmount <= 0n ? "Amount must be greater than zero" : rawBridgeAmount !== null && !bridgeBalance.isWrongNetwork && BridgeBalanceHasEnough(bridgeBalance.raw, rawBridgeAmount) === false ? "Insufficient balance" : null;
  const bridgeHasPositiveAmount = rawBridgeAmount !== null && rawBridgeAmount > 0n;
  const bridgeExecutionStartedRef = useRef(false);
  const bridgeQuoteState = useBridgeQuote(bridgeFromChain, bridgeToChain, bridgeFromToken, bridgeToToken, isBridge && rawBridgeAmount && rawBridgeAmount > 0n && !bridgeAmountError && !bridgeSameNetwork ? rawBridgeAmount : null, address, undefined, false, connector, bridgeExecutionStartedRef.current, bridgeRoutePreference);
  const selectedBridgeRoute = bridgeRouteSelectable
    ? bridgeQuoteState.quote?.selectedRoute
    : undefined;
  const { data: destinationNativeBalance, isLoading: destinationBalanceLoading, isError: destinationBalanceError } = useBalance({
    address,
    chainId: bridgeToChainId,
    query: { enabled: Boolean(isConnected && selectedBridgeRoute === "cctp" && address) },
  });
  const { data: sourceNativeBalance, isLoading: sourceBalanceLoading, isError: sourceBalanceError, refetch: refetchSourceNativeBalance } = useBalance({
    address,
    chainId: bridgeFromChainId,
    query: { enabled: Boolean(isConnected && address && bridgeQuoteState.quote?.selectedRoute && bridgeFromChainId === ARC_PRIMARY_NETWORK.id) },
  });
  const standardMintGasEstimate = bridgeQuoteState.quote?.gasEstimates
    ?.filter((gas) => gas.chainId === bridgeToChainId && gas.step.toLowerCase() === "mint")
    .reduce((total, gas) => total + gas.amount, 0n);
  const standardMintGasDecimals = bridgeQuoteState.quote?.gasEstimates
    ?.find((gas) => gas.chainId === bridgeToChainId && gas.step.toLowerCase() === "mint")
    ?.decimals;
  const standardDestinationGasReady = selectedBridgeRoute !== "cctp" || Boolean(
    standardMintGasEstimate !== undefined &&
    !destinationBalanceLoading &&
    !destinationBalanceError &&
    destinationNativeBalance &&
    destinationNativeBalance.value >= standardMintGasEstimate,
  );
  const standardDestinationGasError = selectedBridgeRoute !== "cctp" || !bridgeQuoteState.quote
    ? null
    : destinationBalanceLoading
      ? "Checking Sepolia native gas balance..."
      : destinationBalanceError
        ? "Unable to verify Sepolia native gas balance. Retry the balance check before starting."
        : standardMintGasEstimate === undefined
          ? "Circle did not provide the Standard CCTP destination mint gas estimate."
          : !destinationNativeBalance || destinationNativeBalance.value < standardMintGasEstimate
            ? `Insufficient ${getOrbitNetwork(bridgeToChainId)?.nativeCurrency.symbol ?? "destination gas"} for the estimated destination mint.`
            : null;
  const bridgeTiming = getBridgeQuoteTiming(bridgeQuoteState.quote);
  const bridgeQuoteCurrent = isBridgeQuoteCurrent({
    quote: bridgeQuoteState.quote,
    sourceChainId: bridgeFromChainId,
    destinationChainId: bridgeToChainId,
    sourceToken: bridgeFromToken,
    destinationToken: bridgeToToken,
    recipientAddress: address,
    amount: rawBridgeAmount,
    selectedRoute: selectedBridgeRoute,
    now: bridgeQuoteState.freshnessNow,
  });
  const bridgeApprovalRequest = getBridgeApprovalRequest(bridgeQuoteState.quote, bridgeQuoteCurrent);
  const bridgeApproval = useBridgeApproval(bridgeFromToken, address, bridgeApprovalRequest.spender, bridgeApprovalRequest.amount, bridgeTiming);
  const sourceGasRequirement = getBridgeNativeGasRequirement(bridgeQuoteState.quote, bridgeFromChainId, bridgeApproval.required);
  const sourceNativeGasReady = isBridgeNativeGasReady({
    applicable: bridgeFromChainId === ARC_PRIMARY_NETWORK.id && Boolean(bridgeQuoteState.quote),
    quoteCurrent: bridgeQuoteCurrent,
    loading: sourceBalanceLoading,
    balance: sourceNativeBalance?.value ?? null,
    error: sourceBalanceError,
    requirement: sourceGasRequirement,
  });
  const sourceNativeGasError = bridgeFromChainId !== ARC_PRIMARY_NETWORK.id || !bridgeQuoteState.quote
    ? null
    : !bridgeQuoteCurrent
      ? "Arc gas estimate is stale. Refresh the quote before bridging."
      : "error" in sourceGasRequirement
        ? sourceGasRequirement.error
        : sourceBalanceLoading
          ? `Checking available native ${sourceGasRequirement.tokenSymbol} gas balance...`
          : sourceBalanceError
            ? `Unable to verify native ${sourceGasRequirement.tokenSymbol} gas balance. Retry the balance check before bridging.`
            : !sourceNativeBalance || sourceNativeBalance.value < sourceGasRequirement.amount
              ? `Insufficient native ${sourceGasRequirement.tokenSymbol} gas balance. Estimated source fee: ${formatUnits(sourceGasRequirement.amount, sourceGasRequirement.decimals)} ${sourceGasRequirement.tokenSymbol}; available: ${sourceNativeBalance ? formatUnits(sourceNativeBalance.value, sourceGasRequirement.decimals) : "unavailable"} ${sourceGasRequirement.tokenSymbol}.`
              : null;
  const bridgeQuoteFreshnessState = getBridgeQuoteFreshnessState({
    hasQuote: Boolean(bridgeQuoteState.quote),
    quoteCurrent: bridgeQuoteCurrent,
    isLoading: bridgeQuoteState.isLoading,
    isFetching: bridgeQuoteState.isFetching,
    isError: bridgeQuoteState.isError,
  });
  const bridgeApprovalAction = getBridgeApprovalActionState({
    required: bridgeApproval.required,
    isReady: bridgeApproval.isReady,
    sourceNetworkReady: isConnected && chainId === bridgeFromChainId,
    status: bridgeApproval.status,
  });
  const bridgeExecution = useBridgeExecution(bridgeQuoteState.quote);
  const bridgeExecutionStarted = isBridgeExecutionStarted(bridgeExecution.status, bridgeExecution.sourceHash);
  const bridgeExecutionWalletMatches = Boolean(
    address &&
    bridgeExecution.executionWalletAddress &&
    address.toLowerCase() === bridgeExecution.executionWalletAddress.toLowerCase(),
  );
  bridgeExecutionStartedRef.current = bridgeExecutionStarted;
  const restoredBridgeKey = bridgeExecutionWalletMatches && bridgeExecution.sourceHash && bridgeExecution.quote?.id.startsWith("recovered-cctp-")
    ? `${address?.toLowerCase() ?? ""}:${bridgeExecution.sourceHash.toLowerCase()}`
    : null;
  const hydratedBridgeRecoveryRef = useRef<string | null>(null);
  useEffect(() => {
    const recoveredQuote = bridgeExecution.quote;
    if (!restoredBridgeKey || !recoveredQuote || hydratedBridgeRecoveryRef.current === restoredBridgeKey) return;
    hydratedBridgeRecoveryRef.current = restoredBridgeKey;
    setBridgeFromChainId(recoveredQuote.fromChain.id);
    setBridgeToChainId(recoveredQuote.toChain.id);
    setBridgeAmount(formatUnits(recoveredQuote.fromAmount, recoveredQuote.fromToken.decimals));
    setShowBridgeConfirmation(false);
    setReviewedBridgeQuote(null);
  }, [bridgeExecution.quote, restoredBridgeKey]);
  const bridgeInputsLocked = bridgeExecutionStarted || bridgeExecution.isSubmitting || bridgeExecution.sourceSubmissionAttempted || bridgeApproval.status === "checking" || bridgeApproval.status === "confirmation" || bridgeApproval.status === "pending";
  const resetBridgeExecution = bridgeExecution.reset;
  const previousBridgeAddressRef = useRef(address);
  useEffect(() => {
    const accountChanged = previousBridgeAddressRef.current !== address;
    previousBridgeAddressRef.current = address;
    if (shouldResetBridgeExecution({
      status: bridgeExecution.status,
      sourceHash: bridgeExecution.sourceHash,
      sourceSubmissionAttempted: bridgeExecution.sourceSubmissionAttempted,
      routeChanged: false,
      amountChanged: false,
      accountChanged,
      sourceNetworkChanged: false,
    })) resetBridgeExecution();
  }, [address, bridgeExecution.sourceHash, bridgeExecution.sourceSubmissionAttempted, bridgeExecution.status, resetBridgeExecution]);
  const bridgeLifecycleQuote = bridgeExecution.quote ?? bridgeQuoteState.quote;
  const bridgeDisplayQuote = bridgeExecutionStarted
    ? bridgeLifecycleQuote
    : bridgeQuoteCurrent ? bridgeQuoteState.quote : undefined;
  const bridgeHasLiveQuote = Boolean(bridgeDisplayQuote);
  const displaySourceGasRequirement = getBridgeNativeGasRequirement(bridgeDisplayQuote, bridgeFromChainId);
  const bridgeProgressSteps = getCompactBridgeProgressSteps(bridgeExecution.status, bridgeLifecycleQuote?.selectedRoute, {
    sourceHash: Boolean(bridgeExecution.sourceHash),
    destinationHash: Boolean(bridgeExecution.destinationHash),
    destinationVerified: bridgeExecution.destinationVerified,
  });
  const bridgeLifecycleTiming = getBridgeQuoteTiming(bridgeLifecycleQuote);
  const bridgeStatus = { status: bridgeExecution.bridgeStatus };
  const finalDestinationHash = getBridgeSuccessDestinationHash(
    bridgeExecution.destinationHash,
    bridgeStatus.status?.receiving?.txHash,
    bridgeStatus.status?.receiving?.chainId,
    bridgeLifecycleQuote?.toChain.id,
  );
  const bridgeIsComplete = canShowBridgeSuccess({
    status: bridgeExecution.status,
    sourceHash: bridgeExecution.sourceHash,
    destinationHash: finalDestinationHash,
    destinationVerified: bridgeExecution.destinationVerified,
  });
  useLayoutEffect(() => {
    if (bridgeIsComplete) markArcForwardingTiming(bridgeTimingRef.current, "success popup rendered");
  }, [bridgeIsComplete]);
  const bridgeSourceActionReady = Boolean(
    isConnected &&
    bridgeQuoteCurrent &&
    !bridgeQuoteState.isLoading &&
    !bridgeQuoteState.isFetching &&
    !bridgeQuoteState.isError &&
    !bridgeAmountError &&
    !bridgeSameNetwork &&
    bridgeFromToken &&
    bridgeToToken &&
    bridgeApproval.isReady,
  );
  const requiredBridgeChainId = getRequiredBridgeChainId({
    status: bridgeExecution.status,
    sourceChainId: bridgeFromChainId,
    destinationChainId: bridgeToChainId,
    selectedRoute: getBridgeSelectedRoute(bridgeLifecycleQuote),
    sourceHash: bridgeExecution.sourceHash,
    destinationHash: bridgeExecution.destinationHash,
    verifiedComplete: bridgeIsComplete,
    sourceActionReady: bridgeSourceActionReady,
  });
  const requiredBridgeChain = requiredBridgeChainId === bridgeToChainId ? bridgeToChain : bridgeFromChain;
  const bridgeWrongNetwork = !bridgeIsComplete && shouldShowBridgeWrongNetwork({ isConnected, walletChainId: chainId, requiredChainId: requiredBridgeChainId });
  useEffect(() => {
    if (!bridgeWrongNetwork || chainId === requiredBridgeChainId) setBridgeNetworkSwitchError(null);
  }, [bridgeWrongNetwork, chainId, requiredBridgeChainId]);
  const queryClient = useQueryClient();
  const bridgeSuccessResetKeyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!shouldResetBridgeAmount({
      status: bridgeExecution.status,
      sourceHash: bridgeExecution.sourceHash,
      destinationHash: finalDestinationHash,
      destinationVerified: bridgeExecution.destinationVerified,
    })) return;
    const resetKey = `${bridgeExecution.sourceHash}:${finalDestinationHash}`;
    if (bridgeSuccessResetKeyRef.current === resetKey) return;
    bridgeSuccessResetKeyRef.current = resetKey;
    setBridgeAmount("");
    setShowBridgeConfirmation(false);
    setBridgeNetworkSwitchError(null);
    queryClient.removeQueries({ queryKey: ["bridge-quote"] });
    queryClient.removeQueries({ queryKey: ["bridge-simulation"] });
    markArcForwardingTiming(bridgeTimingRef.current, "verified success amount and quote reset");
  }, [bridgeExecution.destinationVerified, bridgeExecution.sourceHash, bridgeExecution.status, finalDestinationHash, queryClient]);
  const resetBridgeRouteState = useCallback(() => {
    bridgeExecutionStartedRef.current = false;
    resetBridgeExecution();
    queryClient.removeQueries({ queryKey: ['bridge-quote'] });
    setBridgeAmount("");
    setShowBridgeConfirmation(false);
    setReviewedBridgeQuote(null);
    setBridgeNetworkSwitchError(null);
  }, [queryClient, resetBridgeExecution]);
  useEffect(() => {
    if (!bridgeIsComplete) return;
    const timer = window.setTimeout(resetBridgeRouteState, 5_000);
    return () => window.clearTimeout(timer);
  }, [bridgeIsComplete, resetBridgeRouteState]);
  const bridgeRouteSelectionRef = useRef(`${bridgeFromChainId}:${bridgeToChainId}`);
  useEffect(() => {
    const routeKey = `${bridgeFromChainId}:${bridgeToChainId}`;
    if (bridgeRouteSelectionRef.current === routeKey) return;
    bridgeRouteSelectionRef.current = routeKey;
    resetBridgeRouteState();
  }, [address, bridgeFromChainId, bridgeToChainId, resetBridgeRouteState]);
  const bridgeReady = isBridgeReviewable({
    isConnected,
    wrongNetwork: bridgeWrongNetwork,
    sameNetwork: bridgeSameNetwork,
    hasSourceToken: Boolean(bridgeFromToken),
    hasDestinationToken: Boolean(bridgeToToken),
    hasQuote: bridgeQuoteCurrent && !bridgeQuoteState.isLoading && !bridgeQuoteState.isFetching,
    hasAmount: Boolean(rawBridgeAmount),
    hasAmountError: Boolean(bridgeAmountError),
    quoteFresh: bridgeQuoteCurrent,
    feeValid: !bridgeQuoteState.quote?.feeError,
  }) && bridgeApproval.isReady && !bridgeApproval.required && standardDestinationGasReady && sourceNativeGasReady;
  const reviewedBridgeQuoteCurrent = Boolean(
    reviewedBridgeQuote &&
    bridgeQuoteCurrent &&
    !bridgeQuoteState.isLoading &&
    !bridgeQuoteState.isFetching &&
    !bridgeQuoteState.isError &&
    !reviewedBridgeQuote.feeError &&
    isSameBridgeQuoteSnapshot(bridgeQuoteState.quote, reviewedBridgeQuote) &&
    isBridgeQuoteCurrent({
      quote: reviewedBridgeQuote,
      sourceChainId: bridgeFromChainId,
      destinationChainId: bridgeToChainId,
      sourceToken: bridgeFromToken,
      destinationToken: bridgeToToken,
      recipientAddress: address,
      amount: rawBridgeAmount,
      selectedRoute: reviewedBridgeQuote.selectedRoute,
      now: bridgeQuoteState.freshnessNow,
    }),
  );
  const bridgeStatusMessage = bridgeExecution.error?.message
    ?? (bridgeApproval.status === "failed" ? `Approval failed: ${bridgeApproval.error?.message ?? "wallet approval was not completed"}` : null)
    ?? (bridgeApproval.isError ? "Unable to verify USDC allowance. Retry the allowance check." : null)
    ?? (bridgeQuoteState.simulationError ? `CCTP burn simulation failed: ${bridgeQuoteState.simulationError.message}` : null)
    ?? (bridgeQuoteState.isError && bridgeQuoteFreshnessState !== "refresh-failed" ? `Circle quote unavailable: ${bridgeQuoteState.error instanceof Error ? bridgeQuoteState.error.message : "provider unavailable"}` : null)
    ?? (bridgeTokensQuery.isError ? "Circle token catalog unavailable. Retry after the network recovers." : null)
    ?? bridgeNetworkSwitchError?.message
    ?? (bridgeSameNetwork ? "Choose two different networks." : null)
    ?? bridgeAmountError
    ?? (bridgeWrongNetwork ? `Switch to ${requiredBridgeChain.name} to continue.` : null)
    ?? bridgeQuoteState.quote?.feeError
    ?? (bridgeExecutionStarted
      ? getCompactBridgeStatus(bridgeExecution.status, getBridgeSelectedRoute(bridgeLifecycleQuote) === "forwarding", {
            source: Boolean(bridgeExecution.sourceHash),
            destination: Boolean(bridgeExecution.destinationHash),
            destinationVerified: bridgeExecution.destinationVerified,
          }) ?? "Bridge is processing."
        : bridgeApproval.required
          ? `Approve ${formatUnits(bridgeApprovalRequest.amount ?? 0n, bridgeFromToken?.decimals ?? 6)} USDC to continue.`
          : ["refreshing", "refresh-failed", "stale"].includes(bridgeQuoteFreshnessState)
            ? ""
            : bridgeQuoteCurrent
              ? "Quote ready to review."
                : bridgeHasPositiveAmount && bridgeQuoteState.isFetching
                  ? "Getting a live quote…"
                  : null);
  const switchBridgeNetwork = async () => {
    if (requiredBridgeChainId === undefined) return;
    setBridgeNetworkSwitchError(null);
    try {
      await switchChainAsync({ chainId: requiredBridgeChainId });
    } catch (caughtError) {
      setBridgeNetworkSwitchError(caughtError instanceof Error ? caughtError : new Error("Unable to switch wallet network"));
    }
  };
  return (
    <div className={`orbit-action-page ${isBridge ? "orbit-action-page--bridge mx-auto max-w-4xl space-y-7" : "orbit-action-page--swap mx-auto max-w-5xl space-y-8"}`}>
      <PageTitle
        label={`${isSwap ? "Move / Swap" : "Move / Bridge"}`}
        title={
          isSwap
            ? "Move with confidence."
            : "Cross-chain, simplified."
        }
      />
      <div className={`grid gap-5 ${isSwap ? "lg:grid-cols-[1fr_1fr]" : ""}`}>
        <Card className={isBridge ? "orbit-bridge-card p-[18px]" : "p-5"} glow>
          {isSwap ? (
            <>
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <Label>Swap assets</Label>
                  <h2 className="mt-2 text-xl font-bold">Exchange tokens</h2>
                </div>
                <button className="rounded-lg p-2 text-slate-500 hover:bg-white/5">
                  <SlidersHorizontal size={17} />
                </button>
              </div>
              <SwapBox label="You pay" token={fromAsset.symbol} color={fromAsset.color} asset={fromAsset} value={swapAmount} onTokenChange={(symbol) => { if (symbol !== toSymbol) { setFromSymbol(symbol); setSwapAmount(""); } }} onAmountChange={setSwapAmount} onMax={() => setSwapAmount(formatUnits(fromBalance?.raw ?? 0n, fromAsset.decimals))} disabled={isQuoteFetching} />
              <div className="relative z-10 -my-3 flex justify-center">
                <button onClick={swapDirection} className="rounded-lg border border-white/10 bg-[#141d2e] p-2.5 text-cyan-300 shadow-xl">
                  <ArrowDownLeft size={16} />
                </button>
              </div>
              <SwapBox label="You receive" token={toAsset.symbol} color={toAsset.color} asset={toAsset} onTokenChange={(symbol) => { if (symbol !== fromSymbol) setToSymbol(symbol); }} disabled={isQuoteFetching} />
              <div className="mt-4 space-y-2 rounded-xl bg-white/[.03] p-4 text-xs">
                <div className="flex justify-between">
                  <span className="text-slate-500">Best route</span>
                  <span className="font-semibold">{isQuoteLoading ? "Loading..." : quote ? `${quoteProvider} route` : "Unavailable"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Expected output</span>
                  <span className="font-mono text-slate-300">{quote ? `${formatUnits(quote.amountOut, toAsset.decimals)} ${toAsset.symbol}` : "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Minimum received</span>
                  <span className="font-mono text-slate-300">{quote && minimumReceived !== null ? `${formatUnits(minimumReceived, toAsset.decimals)} ${toAsset.symbol}` : quote ? "Not available from quote" : "Quote unavailable"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Network fee</span>
                  <span className="font-mono text-slate-300">{quote?.gasUsd !== null && quote?.gasUsd !== undefined ? `$${quote.gasUsd.toFixed(2)}` : "Not provided by route"}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Slippage</span>
                  <select value={slippageBps} onChange={(event) => setSlippageBps(Number(event.target.value))} disabled={isQuoteFetching || swapExecution.status === "pending"} className="rounded border border-white/10 bg-[#101725] px-2 py-1 font-mono text-[10px] text-slate-300"><option value={10}>0.1%</option><option value={50}>0.5%</option><option value={100}>1%</option></select>
                </div>
              </div>
              <p className={`mt-4 text-xs ${swapAmountError || isQuoteError || swapExecution.status === "failed" ? "text-rose-300" : swapExecution.status === "confirmed" ? "text-emerald-300" : "text-slate-500"}`}>{swapAmountError ?? swapExecution.error?.message ?? (fromSymbol === toSymbol ? "Select two different assets." : !swapAmountValid ? "Enter an amount to request a quote." : isQuoteError ? `${quoteProvider} quote error: ${quoteError instanceof Error ? quoteError.message : "provider unavailable"}` : swapApproval.isApprovalRequired ? "Approval required for this router." : !quote ? "Quote unavailable." : !quoteFresh ? "Quote expired. Refresh the quote." : "Ready to review route.")}</p>
              {swapApproval.isApprovalRequired ? <div className="mt-4 space-y-3 rounded-xl border border-amber-300/15 bg-amber-300/[.04] p-3"><p className="text-xs text-slate-300">Approve {fromAsset.symbol} for spender <span className="break-all font-mono text-slate-200">{quote?.routerAddress ?? "Unavailable"}</span>, up to {quote ? formatUnits(quote.amountIn, fromAsset.decimals) : "Unavailable"} {fromAsset.symbol}.</p><SlideToConfirm label="Slide to approve" confirmationKey={`${address?.toLowerCase() ?? ""}:${chainId ?? ""}:${fromAsset.address ?? fromAsset.symbol}:${quote?.routerAddress ?? ""}:${quote?.amountIn.toString() ?? ""}`} phase={swapApproval.approvalStatus === "confirmation" ? "submitting" : swapApproval.approvalStatus === "pending" ? "pending" : swapApproval.approvalStatus === "confirmed" ? "success" : swapApproval.approvalStatus === "failed" ? "failed" : "idle"} disabled={!quote || Boolean(swapApproval.approvalHash)} onConfirm={swapApproval.approve} /></div> : <Button className="mt-4 w-full" onClick={() => setShowSwapConfirmation(true)} icon disabled={!swapReady || swapExecution.status === "pending" || swapExecution.status === "confirmation"}>{swapExecution.status === "pending" ? "Swap pending..." : swapExecution.status === "confirmed" ? "Swap confirmed" : "Review swap"}</Button>}
              {swapApproval.approvalStatus === "failed" && swapApproval.approvalError && <p className="mt-3 text-xs text-rose-300">Approval failed: {swapApproval.approvalError.message}</p>}
              {swapApproval.approvalHash && <p className="mt-2 text-xs text-cyan-300">Approval transaction submitted.</p>}
              {swapExecution.transactionHash && <p className="mt-2 text-xs text-emerald-300">Swap hash: <a className="underline" href={explorerTxUrl(swapExecution.transactionHash)} target="_blank" rel="noopener noreferrer">{shortAddr(swapExecution.transactionHash)}</a></p>}
              {showSwapConfirmation && quote && <div className="mt-4 rounded-xl border border-cyan-300/20 bg-cyan-300/[.05] p-4"><Label>Final confirmation</Label><div className="mt-3 space-y-2 text-xs"><div className="flex justify-between"><span className="text-slate-500">Input</span><span>{formatUnits(quote.amountIn, fromAsset.decimals)} {fromAsset.symbol}</span></div><div className="flex justify-between"><span className="text-slate-500">Expected output</span><span>{formatUnits(quote.amountOut, toAsset.decimals)} {toAsset.symbol}</span></div><div className="flex justify-between"><span className="text-slate-500">Minimum received</span><span>{minimumReceived !== null ? `${formatUnits(minimumReceived, toAsset.decimals)} ${toAsset.symbol}` : "Not available from quote"}</span></div><div className="flex justify-between gap-3"><span className="text-slate-500">Route</span><span className="text-right">{quote.routeLabel}</span></div><div className="flex justify-between"><span className="text-slate-500">Price impact</span><span>{formatPercent(quote.priceImpact)}</span></div><div className="flex justify-between"><span className="text-slate-500">Network</span><span>Base Mainnet</span></div><div className="flex justify-between"><span className="text-slate-500">Network fee</span><span>{quote.gasUsd !== null ? `$${quote.gasUsd.toFixed(2)}` : "Not provided by route"}</span></div><div className="flex justify-between"><span className="text-slate-500">Deadline</span><span>5 minutes</span></div></div><p className="mt-3 text-[10px] leading-4 text-amber-300">Review the route and transaction in your wallet before signing. Digital assets can lose value.</p><div className="mt-4 space-y-3"><Button variant="secondary" className="w-full" onClick={() => setShowSwapConfirmation(false)}>Cancel</Button><SlideToConfirm label="Slide to swap" confirmationKey={`${address?.toLowerCase() ?? ""}:${chainId ?? ""}:${quote.routerAddress}:${quote.amountIn}:${quote.amountOut}:${slippageBps}:${quote.quotedAt}`} phase={swapExecution.status === "preparing" || swapExecution.status === "confirmation" ? "submitting" : swapExecution.status === "pending" ? "pending" : swapExecution.status === "confirmed" ? "success" : swapExecution.status === "failed" ? "failed" : "idle"} disabled={!swapReady || Boolean(swapExecution.transactionHash)} onConfirm={() => swapExecution.execute(quote, address as Address, slippageBps)} /></div></div>}
            </>
          ) : isBridge ? (
            <>
              <div className="mb-4">
                <Label>Bridge assets</Label>
                <h2 className="mt-2 text-xl font-bold">Bridge USDC</h2>
              </div>
              <div className="orbit-bridge-route-grid grid grid-cols-2 gap-[11px]">
                <div className="orbit-bridge-network-card orbit-bridge-network-card--from rounded-xl border border-white/10 bg-white/[.04] p-3.5">
                  <Label>From</Label>
                  <div className="orbit-bridge-network-current mt-2.5 flex items-center gap-2 text-xs text-slate-400"><ChainLogo chainId={bridgeFromChainId} className="h-5 w-5" /><span className="orbit-bridge-network-name">{bridgeFromChain.name}</span></div>
                  <BridgeNetworkPicker label="Bridge source network" value={bridgeFromChainId} options={allBridgeNetworks.filter((chain) => chain.id !== bridgeToChainId)} onChange={setBridgeFromChainId} disabled={bridgeInputsLocked} />
                </div>
                <div className="orbit-bridge-network-card orbit-bridge-network-card--to rounded-xl border border-white/10 bg-white/[.04] p-3.5">
                  <Label>To</Label>
                  <div className="orbit-bridge-network-current mt-2.5 flex items-center gap-2 text-xs text-slate-400"><ChainLogo chainId={bridgeToChainId} className="h-5 w-5" /><span className="orbit-bridge-network-name">{bridgeToChain.name}</span></div>
                  <BridgeNetworkPicker label="Bridge destination network" value={bridgeToChainId} options={allBridgeNetworks.filter((chain) => chain.id !== bridgeFromChainId)} onChange={setBridgeToChainId} disabled={bridgeInputsLocked} />
                </div>
              </div>
              {bridgeHasPositiveAmount && bridgeSameNetwork && <div className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/[.06] p-4 text-xs text-amber-200"><span>Source and destination networks must be different.</span></div>}
              {bridgeHasPositiveAmount && bridgeWrongNetwork && requiredBridgeChainId !== undefined && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300/20 bg-amber-300/[.06] p-4 text-xs text-amber-200"><span>Wrong network. Switch to {requiredBridgeChain.name} to continue the current Bridge action.</span><Button variant="secondary" onClick={() => void switchBridgeNetwork()} disabled={bridgeNetworkSwitchPending}>{bridgeNetworkSwitchPending ? `Switching to ${requiredBridgeChain.name}...` : `Switch to ${requiredBridgeChain.name}`}</Button>{bridgeNetworkSwitchError && <span className="basis-full text-rose-300">{bridgeNetworkSwitchError.message}</span>}</div>}
              <div className="orbit-bridge-asset-card mt-3.5 rounded-xl border border-white/10 bg-white/[.03] p-3.5">
                <Label>Asset</Label>
                <div className="orbit-bridge-asset-header mt-2.5 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="orbit-bridge-asset-token rounded-lg border border-white/10 bg-[#101725] p-2 font-bold text-white">USDC</div>
                  </div>
                  {bridgeHasPositiveAmount && <span className="orbit-bridge-asset-balance font-mono text-xs text-slate-500">
                    Balance {bridgeBalance.isDisconnected ? 'Connect wallet' : bridgeBalance.isLoading ? "..." : bridgeFromToken && bridgeBalance.raw !== null ? formatUnits(bridgeBalance.raw, bridgeFromToken.decimals) : "Unavailable"}
                  </span>}
                </div>
                <div className="orbit-bridge-amount-control mt-3.5 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[.04] px-3.5"><input value={bridgeAmount} onChange={(event) => setBridgeAmount(event.target.value)} disabled={bridgeInputsLocked} inputMode="decimal" placeholder="0.00" className="min-w-0 flex-1 bg-transparent py-2.5 text-lg font-bold text-white outline-none placeholder:text-slate-600 disabled:opacity-60" /><button type="button" onClick={() => bridgeFromToken && bridgeBalance.raw !== null && setBridgeAmount(formatUnits(bridgeBalance.raw, bridgeFromToken.decimals))} disabled={bridgeInputsLocked} className="orbit-form-max font-mono text-[10px] font-bold disabled:opacity-50">MAX</button><span className="font-mono text-xs text-slate-500">{bridgeSymbol}</span></div>
                {Boolean(bridgeAmount) && bridgeAmountError && rawBridgeAmount !== 0n && <p role="alert" className="mt-2 text-xs text-rose-300">{bridgeAmountError}</p>}
              </div>
              {bridgeHasLiveQuote && (
                <motion.div
                  className="orbit-bridge-live-quote overflow-hidden"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  transition={{ duration: reduceMotion ? 0 : 0.24 }}
                >
              <div className="orbit-bridge-quote-summary mt-3.5 rounded-xl border border-white/10 bg-white/[.025] px-3.5 py-1.5 text-xs">
                <div className="flex items-center justify-between gap-3 border-b border-white/[.06] py-2.5">
                  <span className="text-slate-400">You send</span>
                  <span className="font-mono font-semibold text-slate-100">{rawBridgeAmount !== null && bridgeFromToken ? `${formatUnits(rawBridgeAmount, bridgeFromToken.decimals)} ${bridgeFromToken.symbol}` : "—"}</span>
                </div>
                <div className="flex items-center justify-between gap-3 border-b border-white/[.06] py-2.5">
                  <span className="text-slate-400">You receive <span className="text-slate-600">(estimated)</span></span>
                  <span className="font-mono font-semibold text-slate-100">{bridgeDisplayQuote?.toAmount !== null && bridgeDisplayQuote?.toAmount !== undefined ? `${formatUnits(bridgeDisplayQuote.toAmount, bridgeDisplayQuote.toToken.decimals)} ${bridgeDisplayQuote.toToken.symbol}` : bridgeQuoteState.isFetching ? "Quoting…" : "—"}</span>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <span className="text-slate-400">Circle / bridge fee</span>
                  <span className="font-mono font-semibold text-slate-100">{bridgeDisplayQuote?.feeAmount !== null && bridgeDisplayQuote?.feeAmount !== undefined && bridgeFromToken ? `${formatUnits(bridgeDisplayQuote.feeAmount, bridgeFromToken.decimals)} ${bridgeFromToken.symbol}` : bridgeQuoteState.isFetching ? "Quoting…" : "—"}</span>
                </div>
                {bridgeDisplayQuote && bridgeFromChainId === ARC_PRIMARY_NETWORK.id && (
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[.06] py-2.5">
                    <span className="text-slate-400">Estimated Arc gas (native USDC)</span>
                    <span className="font-mono text-right text-slate-300">
                      {"error" in displaySourceGasRequirement
                        ? "Estimate unavailable"
                        : `${formatUnits(displaySourceGasRequirement.amount, displaySourceGasRequirement.decimals)} ${displaySourceGasRequirement.tokenSymbol}${sourceNativeBalance ? ` · ${formatUnits(sourceNativeBalance.value, displaySourceGasRequirement.decimals)} available` : sourceBalanceLoading ? " · checking balance…" : " · balance unavailable"}`}
                    </span>
                  </div>
                )}
                {bridgeDisplayQuote && (
                  <details className="orbit-bridge-disclosure border-t border-white/[.06] py-2">
                    <summary className="cursor-pointer py-1 text-[11px] text-slate-400 transition-colors hover:text-slate-200">Fee breakdown</summary>
                    <div className="space-y-2 pb-2 pt-1 text-[11px]">
                      {bridgeDisplayQuote.forwardingFeeAmount !== null && bridgeDisplayQuote.forwardingFeeAmount !== undefined && (
                        <div className="flex justify-between gap-3"><span className="text-slate-500">Circle forwarding fee</span><span className="font-mono text-slate-300">{formatUnits(bridgeDisplayQuote.forwardingFeeAmount, bridgeFromToken?.decimals ?? 6)} USDC</span></div>
                      )}
                      {bridgeDisplayQuote.protocolFeeAmount !== null && bridgeDisplayQuote.protocolFeeAmount !== undefined && (
                        <div className="flex justify-between gap-3"><span className="text-slate-500">Circle protocol fee</span><span className="font-mono text-slate-300">{formatUnits(bridgeDisplayQuote.protocolFeeAmount, bridgeFromToken?.decimals ?? 6)} USDC</span></div>
                      )}
                      <p className="text-[10px] leading-4 text-slate-500">Source and destination gas are paid separately in each network’s native token.</p>
                    </div>
                  </details>
                )}
              </div>
              {bridgeDisplayQuote && (
                <details className="orbit-bridge-disclosure mt-2 rounded-xl border border-white/[.07] px-4 py-1">
                  <summary className="cursor-pointer py-2 text-[11px] font-medium text-slate-400 transition-colors hover:text-slate-200">Transaction details</summary>
                  <div className="space-y-2 border-t border-white/[.06] py-3 text-[11px]">
                    <div className="flex justify-between gap-3"><span className="text-slate-500">Route</span><span className="text-right text-slate-300">{getBridgeRouteLabel(bridgeDisplayQuote.selectedRoute)} · {bridgeFromChain.name} to {bridgeToChain.name}</span></div>
                    {bridgeDisplayQuote.transferSpeed && <div className="flex justify-between gap-3"><span className="text-slate-500">Settlement</span><span className="text-right text-slate-300">{bridgeDisplayQuote.transferSpeed}</span></div>}
                    {bridgeDisplayQuote.routeComparison && <p className="text-[10px] leading-4 text-slate-500">Automatic routing prefers Circle-managed destination delivery when available. Fee comparisons exclude native gas costs.</p>}
                    {(bridgeDisplayQuote.gasEstimates ?? []).map((gas, index) => {
                      const isMint = bridgeDisplayQuote.selectedRoute === "cctp" && gas.chainId === bridgeToChainId && gas.step.toLowerCase() === "mint";
                      if (gas.step.toLowerCase() === "approve" && !bridgeApproval.required && bridgeApproval.isReady) return null;
                      return (
                        <div key={`${gas.chainId}-${gas.step}-${index}`} className="flex flex-wrap justify-between gap-x-3">
                          <span className="text-slate-500">{gas.chainId === bridgeFromChainId ? "Source" : "Destination"} gas · {gas.step.toLowerCase() === "approve" ? "approval (if needed)" : gas.step} · {getOrbitNetwork(gas.chainId)?.name ?? "Chain"}</span>
                          <span className="font-mono text-right text-slate-300">
                            {formatUnits(gas.amount, gas.decimals)} {gas.tokenSymbol}
                            {isMint && ` · ${destinationBalanceLoading ? "checking balance…" : destinationNativeBalance ? `${formatUnits(destinationNativeBalance.value, destinationNativeBalance.decimals)} ${destinationNativeBalance.symbol} available` : "balance unavailable"}`}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </details>
              )}
              {bridgeDisplayQuote?.selectedRoute === "cctp" && (
                <p className="mt-3 text-[10px] leading-4 text-amber-200">Standard CCTP requires a separate {bridgeToChain.name} mint transaction and {getOrbitNetwork(bridgeToChainId)?.nativeCurrency.symbol ?? "native"} for gas.</p>
              )}
                </motion.div>
              )}
              {bridgeHasPositiveAmount && !bridgeExecutionStarted && (
                (bridgeQuoteState.quote && ["stale", "refreshing", "refresh-failed"].includes(bridgeQuoteFreshnessState))
                || (!bridgeDisplayQuote && bridgeQuoteState.isError)
              ) && (
                <div role={bridgeQuoteFreshnessState === "refresh-failed" ? "alert" : "status"} className={`mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 text-xs ${bridgeQuoteFreshnessState === "refresh-failed" ? "border-rose-300/20 bg-rose-300/[.06] text-rose-200" : "border-amber-300/20 bg-amber-300/[.06] text-amber-200"}`}>
                  <span>
                    {bridgeQuoteFreshnessState === "refreshing"
                      ? "Updating quote; review is paused."
                      : bridgeQuoteFreshnessState === "refresh-failed"
                        ? "Quote refresh failed. Retry for a current estimate."
                        : bridgeQuoteState.quote
                          ? "Quote expired; refreshing automatically."
                          : "Quote unavailable. Retry to fetch a current estimate."}
                  </span>
                  <Button
                    variant="secondary"
                    onClick={() => void bridgeQuoteState.refetch()}
                    disabled={!isConnected || !address || !rawBridgeAmount || Boolean(bridgeAmountError) || bridgeSameNetwork || bridgeInputsLocked || bridgeQuoteState.isLoading || bridgeQuoteState.isFetching}
                  >
                    <RefreshCw size={14} className={bridgeQuoteFreshnessState === "refreshing" ? "animate-spin" : ""} />
                    {bridgeQuoteFreshnessState === "refreshing" ? "Refreshing quote..." : "Refresh quote"}
                  </Button>
                </div>
              )}
              {bridgeHasPositiveAmount && standardDestinationGasError && (
                <p className="mt-3 text-xs text-rose-300">{standardDestinationGasError}</p>
              )}
              {bridgeHasPositiveAmount && !bridgeExecutionStarted && sourceNativeGasError && (
                <div role={sourceBalanceError ? "alert" : "status"} className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-rose-300">
                  <span>{sourceNativeGasError}</span>
                  {sourceBalanceError && <Button variant="secondary" onClick={() => void refetchSourceNativeBalance()} disabled={sourceBalanceLoading}>Retry gas balance</Button>}
                </div>
              )}
              {(bridgeHasPositiveAmount || bridgeExecutionStarted || bridgeExecution.error) && bridgeStatusMessage && (
                <>
                  <p role={bridgeExecution.status === "error" || bridgeExecution.recoverySaveError || bridgeQuoteState.isError || bridgeApproval.status === "failed" ? "alert" : "status"} aria-live={bridgeExecution.status === "error" || bridgeExecution.recoverySaveError ? "assertive" : "polite"} className={`orbit-bridge-status mt-4 text-xs ${bridgeExecution.status === "error" || bridgeExecution.recoverySaveError || bridgeSameNetwork || bridgeAmountError || bridgeQuoteState.isError || bridgeQuoteState.simulationError || bridgeApproval.status === "failed" || bridgeApproval.isError ? "text-rose-300" : bridgeExecution.status === "needs-attention" ? "text-amber-300" : bridgeIsComplete ? "text-emerald-300" : "text-slate-400"}`}>
                    {bridgeExecution.error?.message ?? bridgeStatusMessage}
                    {bridgeExecution.status === "error" && bridgeExecution.sourceHash && <span className="mt-1 block">Starting again creates a separate transaction; the previous one will not be resubmitted.</span>}
                    {bridgeExecution.status === "needs-attention" && bridgeExecution.sourceHash && <span className="mt-1 block">{getBridgeSelectedRoute(bridgeLifecycleQuote) === "forwarding" ? "The source transaction will not be resubmitted. Destination verification will continue automatically." : bridgeExecution.sourceReceiptConfirmed ? "The saved source receipt is verified. Retry Circle attestation to continue." : "The source hash is preserved. Retry receipt lookup before attestation can resume."}</span>}
                    {bridgeExecution.destinationSubmissionState === "submission-unknown" && (
                      <span className="mt-1 block">
                        No destination hash was saved. Check the connected wallet's destination-chain activity before taking any further action; this recovery will not submit another mint.
                        {bridgeLifecycleQuote && address && getOrbitNetwork(bridgeLifecycleQuote.toChain.id) && (
                          <> <a
                            href={`${getOrbitNetwork(bridgeLifecycleQuote.toChain.id)!.explorerUrl}/address/${address}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline"
                          >Open destination wallet activity</a>.</>
                        )}
                      </span>
                    )}
                    {bridgeExecution.sourceHash && !bridgeExecutionWalletMatches && <span className="mt-1 block">Reconnect the wallet that submitted this transfer before continuing recovery.</span>}
                    {bridgeExecution.recoverySaveError && <span className="mt-1 block">Transfer recovery details could not be saved: {bridgeExecution.recoverySaveError.message}</span>}
                  </p>
                  {(bridgeExecution.status === "error" || bridgeExecution.status === "needs-attention") &&
                    bridgeExecution.sourceHash &&
                    getBridgeSelectedRoute(bridgeLifecycleQuote) === "cctp" &&
                    !bridgeExecution.sourceReceiptConfirmed && (
                      <Button
                        variant="secondary"
                        onClick={() => void bridgeExecution.retryCctpSourceReceipt(bridgeLifecycleTiming)}
                        disabled={bridgeExecution.isSubmitting || !bridgeExecutionWalletMatches}
                      >
                        {bridgeExecution.isSubmitting ? "Checking source receipt..." : "Retry source receipt lookup"}
                      </Button>
                    )}
                  {bridgeExecution.status === "needs-attention" &&
                    bridgeExecution.sourceHash &&
                    bridgeExecution.sourceReceiptConfirmed &&
                    getBridgeSelectedRoute(bridgeLifecycleQuote) === "cctp" &&
                    bridgeStatus.status?.status !== "FAILED" && (
                      <Button
                        variant="secondary"
                        onClick={() => void bridgeExecution.retryCctpAttestation(bridgeLifecycleTiming)}
                        disabled={bridgeExecution.isSubmitting || !bridgeExecutionWalletMatches}
                      >
                        {bridgeExecution.isSubmitting ? "Checking Circle attestation..." : "Retry Circle attestation"}
                      </Button>
                    )}
                  {bridgeExecutionStarted && (
                    <div className="orbit-bridge-progress-slot mt-4">
                      <ol aria-label="Bridge progress" className="orbit-bridge-stepper grid" style={{ gridTemplateColumns: `repeat(${bridgeProgressSteps.length}, minmax(0, 1fr))` }}>
                        {bridgeProgressSteps.map((step, index) => (
                          <motion.li
                            key={index}
                            aria-current={step.state === "active" ? "step" : undefined}
                            className={`orbit-bridge-step orbit-bridge-step--${step.state}`}
                            initial={false}
                            animate={{ opacity: 1 }}
                            transition={{ duration: reduceMotion ? 0 : 0.12 }}
                          >
                            <span className="orbit-bridge-step__connector" aria-hidden="true" />
                            <span className="orbit-bridge-step__marker">{step.state === "complete" ? "✓" : index + 1}</span>
                            <span className="orbit-bridge-step__label">{step.label}</span>
                          </motion.li>
                        ))}
                      </ol>
                    </div>
                  )}
                </>
              )}
              {(bridgeHasPositiveAmount && bridgeHasLiveQuote || bridgeExecutionStarted) && (
              <div className="orbit-bridge-actions-slot">
                {bridgeQuoteCurrent && bridgeApproval.isError && !bridgeWrongNetwork && !bridgeExecutionStarted && <Button className="mt-4 w-full" variant="secondary" onClick={() => void bridgeApproval.refetchAllowance()} disabled={bridgeApproval.isLoading}>Retry allowance check</Button>}
                {(bridgeExecution.status === "error" || bridgeExecution.status === "needs-attention" && getBridgeSelectedRoute(bridgeLifecycleQuote) !== "forwarding") && bridgeExecution.sourceHash && (
                  <Button
                    className="mt-4 w-full"
                    variant="secondary"
                    disabled={bridgeExecution.isSubmitting}
                    onClick={() => resetBridgeRouteState()}
                  >
                    Start a new Bridge
                  </Button>
                )}
                {shouldShowBridgeApprovalAction({
                  status: bridgeExecution.status,
                  sourceHash: bridgeExecution.sourceHash,
                  sourceSubmissionAttempted: bridgeExecution.sourceSubmissionAttempted,
                  approvalRequired: bridgeApprovalAction.show,
                }) ? (
                  <div className="mt-4 space-y-3 rounded-xl border border-amber-300/15 bg-amber-300/[.04] p-3">
                    <p className="text-xs text-slate-300">Approve {formatUnits(bridgeApprovalRequest.amount ?? 0n, bridgeFromToken?.decimals ?? 6)} {bridgeFromToken?.symbol ?? "USDC"} for spender <span className="break-all font-mono text-slate-200">{bridgeApprovalRequest.spender ?? "Unavailable"}</span>.</p>
                    <SlideToConfirm
                      label="Slide to approve"
                      confirmationKey={`${address?.toLowerCase() ?? ""}:${chainId ?? ""}:${bridgeFromToken?.address ?? ""}:${bridgeApprovalRequest.spender ?? ""}:${bridgeApprovalRequest.amount?.toString() ?? ""}`}
                      phase={bridgeApproval.status === "confirmation" ? "submitting" : bridgeApproval.status === "pending" ? "pending" : bridgeApproval.status === "confirmed" ? "success" : bridgeApproval.status === "failed" ? "failed" : "idle"}
                      requirePointerDrag
                      disabled={bridgeApprovalAction.disabled || Boolean(bridgeApproval.hash)}
                      onConfirm={bridgeApproval.approve}
                    />
                  </div>
                ) : shouldShowBridgeReviewAction({
                  status: bridgeExecution.status,
                  sourceHash: bridgeExecution.sourceHash,
                  sourceSubmissionAttempted: bridgeExecution.sourceSubmissionAttempted,
                  approvalRequired: bridgeApprovalAction.show,
                  bridgeReady: bridgeReady && !(bridgeStatus.status?.status === "DONE" && bridgeStatus.status.message && bridgeStatus.status.attestation),
                }) ? (
                  <Button
                    className="orbit-bridge-review-button mt-4 w-full"
                    onClick={() => {
                      if (!bridgeReady || !bridgeQuoteState.quote) return;
                      setReviewedBridgeQuote(bridgeQuoteState.quote);
                      setShowBridgeConfirmation(true);
                    }}
                    disabled={!bridgeReady}
                    icon
                  >
                    Review bridge
                  </Button>
                ) : null}
              </div>
              )}
              {(bridgeExecution.sourceHash || finalDestinationHash) && <div className="orbit-bridge-transactions-slot">
                {(bridgeExecution.sourceHash || finalDestinationHash) && (
                  <details className="orbit-bridge-disclosure rounded-xl border border-white/[.07] px-4 py-1">
                    <summary className="cursor-pointer py-2 text-[11px] font-medium text-slate-400 transition-colors hover:text-slate-200">Transactions</summary>
                    <div className="space-y-2 border-t border-white/[.06] py-3 text-[11px] text-cyan-300">
                      {bridgeExecution.sourceHash && bridgeExplorerUrl(bridgeFromChainId, bridgeExecution.sourceHash) && <div>Source · {bridgeFromChain.name}: <a href={bridgeExplorerUrl(bridgeFromChainId, bridgeExecution.sourceHash) ?? undefined} target="_blank" rel="noopener noreferrer" className="underline">{shortAddr(bridgeExecution.sourceHash)}</a></div>}
                      {finalDestinationHash && bridgeExplorerUrl(bridgeToChainId, finalDestinationHash) && <div>Destination · {bridgeToChain.name}: <a href={bridgeExplorerUrl(bridgeToChainId, finalDestinationHash) ?? undefined} target="_blank" rel="noopener noreferrer" className="underline">{shortAddr(finalDestinationHash)}</a></div>}
                    </div>
                  </details>
                )}
              </div>}
              {shouldShowBridgeSourceConfirmation({
                open: showBridgeConfirmation && Boolean(reviewedBridgeQuote),
                executionStarted: bridgeExecutionStarted,
                sourceHash: bridgeExecution.sourceHash,
              }) && reviewedBridgeQuote && (
                <div className="mt-4 rounded-xl border border-cyan-300/20 bg-cyan-300/[.05] p-4">
                  <Label>Final confirmation</Label>
                  <div className="mt-3 space-y-2 text-xs">
                    <div className="flex justify-between gap-3"><span className="text-slate-500">Route</span><span className="text-right">{getBridgeRouteLabel(reviewedBridgeQuote.selectedRoute)} · {bridgeFromChain.name} → {bridgeToChain.name}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">Input</span><span>{formatUnits(reviewedBridgeQuote.fromAmount, reviewedBridgeQuote.fromToken.decimals)} {reviewedBridgeQuote.fromToken.symbol}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">Minimum received</span><span>{reviewedBridgeQuote.toAmountMin !== null ? `${formatUnits(reviewedBridgeQuote.toAmountMin, reviewedBridgeQuote.toToken.decimals)} ${reviewedBridgeQuote.toToken.symbol}` : "Unavailable"}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">Circle fee</span><span>{reviewedBridgeQuote.feeAmount !== null ? `${formatUnits(reviewedBridgeQuote.feeAmount, reviewedBridgeQuote.fromToken.decimals)} ${reviewedBridgeQuote.fromToken.symbol}` : "Unavailable"}</span></div>
                    <div className="flex justify-between gap-3"><span className="text-slate-500">Recipient</span><span className="break-all text-right font-mono">{address ?? "Unavailable"}</span></div>
                  </div>
                  <p className="mt-3 text-[10px] leading-4 text-amber-300">{reviewedBridgeQuote.selectedRoute === "forwarding" ? "Confirm the source USDC transfer in your wallet. Circle will handle destination delivery." : `Confirm the source USDC transfer in your wallet. Standard CCTP requires a separate ${bridgeToChain.name} mint confirmation and ${getOrbitNetwork(bridgeToChainId)?.nativeCurrency.symbol ?? "native"} for gas.`}</p>
                  {!reviewedBridgeQuoteCurrent && <p role="status" className="mt-3 text-xs text-amber-200">This quote changed or expired after review. Review the current quote again before confirming.</p>}
                  <div className="mt-4 space-y-3">
                    <Button variant="secondary" className="w-full" disabled={bridgeExecutionStarted} onClick={() => { setShowBridgeConfirmation(false); setReviewedBridgeQuote(null); }}>Cancel review</Button>
                    <SlideToConfirm
                      label="Slide to bridge"
                      confirmationKey={`${address?.toLowerCase() ?? ""}:${chainId ?? ""}:${bridgeFromChainId}:${bridgeToChainId}:${reviewedBridgeQuote.fromToken.address}:${reviewedBridgeQuote.toToken.address}:${reviewedBridgeQuote.fromAmount}:${reviewedBridgeQuote.feeAmount ?? ""}:${reviewedBridgeQuote.selectedRoute}`}
                      phase={bridgeExecution.isSubmitting || bridgeExecution.status === "preflight" ? "submitting" : bridgeExecution.status === "source-pending" ? "pending" : ["source-confirmed", "attestation-pending", "attestation-ready", "destination-pending"].includes(bridgeExecution.status) ? "pending" : bridgeExecution.status === "completed" ? "success" : bridgeExecution.status === "error" ? "failed" : "idle"}
                      requirePointerDrag
                      disabled={bridgeExecution.isSubmitting || bridgeExecution.sourceSubmissionAttempted || Boolean(bridgeExecution.sourceHash) || (!reviewedBridgeQuoteCurrent && !bridgeExecutionStarted)}
                      onConfirm={() => {
                        if (!reviewedBridgeQuoteCurrent || !reviewedBridgeQuote || !bridgeReady || bridgeExecution.sourceHash || bridgeExecution.sourceSubmissionAttempted || bridgeExecution.isSubmitting) {
                          throw new Error("Bridge review changed or is no longer ready. Review the current route again.");
                        }
                        setShowBridgeConfirmation(false);
                        setReviewedBridgeQuote(null);
                        const timing = bridgeTiming ?? beginArcForwardingTiming();
                        bridgeTimingRef.current = timing;
                        markArcForwardingTiming(timing, "Confirm bridge clicked");
                        return bridgeExecution.execute(timing, reviewedBridgeQuote);
                      }}
                    />
                  </div>
                </div>
              )}
              {bridgeLifecycleQuote && shouldShowCctpDestinationMintAction({
                selectedRoute: getBridgeSelectedRoute(bridgeLifecycleQuote),
                status: bridgeStatus.status?.status,
                message: bridgeStatus.status?.message,
                attestation: bridgeStatus.status?.attestation,
              }) && bridgeStatus.status?.message && bridgeStatus.status.attestation && (
                <div className="mt-4 space-y-3 rounded-xl border border-amber-300/20 bg-amber-300/[.04] p-4" aria-label="Review destination mint">
                  <Label>Destination mint confirmation</Label>
                  <p className="text-xs leading-5 text-slate-300">The source transfer is confirmed and Circle attestation is ready. Review and authorize the separate destination mint transaction.</p>
                  <dl className="grid gap-3 text-xs sm:grid-cols-2">
                    <div><dt className="text-slate-500">Destination network</dt><dd className="mt-1 text-slate-200">{bridgeLifecycleQuote.toChain.name}</dd></div>
                    <div><dt className="text-slate-500">Asset / minimum received</dt><dd className="mt-1 text-slate-200">{bridgeLifecycleQuote.toAmountMin === null ? "Unavailable" : `${formatUnits(bridgeLifecycleQuote.toAmountMin, bridgeLifecycleQuote.toToken.decimals)} ${bridgeLifecycleQuote.toToken.symbol}`}</dd></div>
                    <div><dt className="text-slate-500">Source transaction</dt><dd className="mt-1 break-all font-mono text-slate-200">{bridgeExecution.sourceHash ?? "Unavailable"}</dd></div>
                    <div><dt className="text-slate-500">Destination gas estimate</dt><dd className="mt-1 text-slate-200">{standardMintGasEstimate === undefined || standardMintGasDecimals === undefined ? "Unavailable" : `${formatUnits(standardMintGasEstimate, standardMintGasDecimals)} ${getOrbitNetwork(bridgeLifecycleQuote.toChain.id)?.nativeCurrency.symbol ?? "native gas"}`}</dd></div>
                  </dl>
                  <SlideToConfirm
                    label={bridgeExecution.destinationHash ? "Verify destination mint" : "Confirm destination mint"}
                    confirmationKey={`${address?.toLowerCase() ?? ""}:${chainId ?? ""}:${bridgeExecution.sourceHash ?? ""}:${bridgeStatus.status.message}:${bridgeStatus.status.attestation}`}
                    phase={bridgeExecution.isSubmitting && bridgeExecution.status === "destination-pending" ? bridgeExecution.destinationHash ? "pending" : "submitting" : bridgeExecution.status === "completed" ? "success" : bridgeExecution.status === "error" ? "failed" : bridgeExecution.status === "destination-pending" ? "pending" : "idle"}
                    requirePointerDrag
                    disabled={!bridgeExecution.sourceHash || !bridgeExecutionWalletMatches || bridgeExecution.isSubmitting || bridgeExecution.status === "completed" || bridgeExecution.destinationSubmissionAttempted && !bridgeExecution.destinationHash}
                    onConfirm={() => {
                      if (!bridgeStatus.status?.message || !bridgeStatus.status.attestation || !bridgeExecution.sourceHash) {
                        throw new Error("Circle attestation or source transaction changed. Verify status before continuing.");
                      }
                      return bridgeExecution.complete(bridgeStatus.status.message, bridgeStatus.status.attestation);
                    }}
                  />
                </div>
              )}
              <AnimatePresence>
                {bridgeIsComplete && bridgeExecution.sourceHash && bridgeLifecycleQuote && (
                  <TransactionSuccessScreen
                    title="Bridge Successful!"
                    description={<>Your assets were successfully bridged from <span className="font-semibold text-slate-200">{bridgeFromChain.name}</span> to <span className="font-semibold text-slate-200">{bridgeToChain.name}</span>.</>}
                    amountLabel="Amount bridged"
                    amount={formatUnits(bridgeLifecycleQuote.fromAmount, bridgeLifecycleQuote.fromToken.decimals)}
                    token={{ symbol: bridgeSymbol, color: ARC_USDC.color }}
                    networks={[
                      { label: "Source network", network: bridgeFromChain },
                      { label: "Destination network", network: bridgeToChain },
                    ]}
                    transactionLabel="Source transaction"
                    transactionHash={bridgeExecution.sourceHash}
                    successChimeKey={`bridge:${bridgeExecution.sourceHash}`}
                    explorerUrl={bridgeExplorerUrl(bridgeFromChainId, bridgeExecution.sourceHash)}
                    additionalTransactions={[{
                      label: "Destination transaction",
                      transactionHash: finalDestinationHash,
                      explorerUrl: finalDestinationHash ? bridgeExplorerUrl(bridgeToChainId, finalDestinationHash) : null,
                    }]}
                    completedAt={bridgeLifecycleQuote.quotedAt}
                    primaryLabel="Done"
                    onBack={resetBridgeRouteState}
                    onPrimary={resetBridgeRouteState}
                  />
                )}
              </AnimatePresence>
            </>
          ) : null}
        </Card>
        {isSwap && <Card className="h-fit p-5">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-cyan-300/10 p-2 text-cyan-300">
              <Sparkles size={18} />
            </div>
            <div>
              <Label>ORBIT Intelligence</Label>
              <h2 className="mt-1 text-lg font-bold">
                Transaction Impact Analysis
              </h2>
            </div>
          </div>
          <div className="mt-6 space-y-4">
            {(isSwap
              ? [
                  ["Portfolio impact", quote ? `${formatUnits(quote.amountOut, toAsset.decimals)} ${toAsset.symbol}` : "Quote unavailable"],
                  ["Price impact", formatPercent(quote?.priceImpact ?? null)],
                  [
                    "Contract / router",
                    quote?.routerAddress
                      ? <div key="router" className="flex flex-col items-end gap-1 text-right">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-slate-200">KyberSwap Router</span>
                            <button
                              type="button"
                              onClick={() => void navigator.clipboard?.writeText(quote.routerAddress as string)}
                              className="rounded border border-white/10 bg-white/[.02] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.14em] text-cyan-300"
                            >
                              Copy
                            </button>
                          </div>
                          <div className="flex items-center gap-2 font-mono text-[11px] text-slate-200">
                            <span>{shortAddr(quote.routerAddress)}</span>
                            <a
                              href={`https://basescan.org/address/${quote.routerAddress}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-cyan-300 underline underline-offset-2"
                            >
                              View on BaseScan
                            </a>
                          </div>
                          <span className="text-[10px] text-slate-400">Contract identity available; verification not independently confirmed.</span>
                        </div>
                      : "Not available from quote",
                  ],
                  ["Recommended", !quote ? "Quote unavailable" : !quoteFresh ? "Quote expired" : swapApproval.isApprovalRequired ? "Approval required" : "Ready to review"],
                ]
                : [
                    ["Protocol", "Circle CCTP V2"],
                    ["Source network", bridgeFromChain.name],
                    ["Destination", bridgeToChain.name],
                    ["Route status", bridgeReady ? "Ready to review" : "Unavailable"],
                  ]
            ).map(([a, b], i) => (
              <div
                key={String(a)}
                className="flex items-center justify-between gap-3 border-b border-white/[.06] pb-3 text-xs"
              >
                <span className="text-slate-500">{a}</span>
                <span
                  className={
                    i === 3
                      ? "font-semibold text-emerald-300"
                      : "font-semibold text-slate-200"
                  }
                >
                  {typeof b === 'string' ? b : b}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-6 text-[11px] leading-5 text-slate-500">
            This analysis is based on current market conditions and your
            wallet's onchain history. Always review before signing.
          </p>
        </Card>}
      </div>
    </div>
  );
}
function SwapBox({
  label,
  token,
  color,
  asset,
  value = "",
  onTokenChange,
  onAmountChange,
  onMax,
  disabled = false,
}: {
  label: string;
  token: string;
  color: string;
  asset: typeof BASE_ASSETS[number];
  value?: string;
  onTokenChange?: (symbol: string) => void;
  onAmountChange?: (value: string) => void;
  onMax?: () => void;
  disabled?: boolean;
}) {
  const { address } = useAccount();
  const portfolio = usePortfolio();
  const balance = portfolio.assets.find((item) => item.symbol === token);
  return (
    <div className="orbit-swap-box rounded-xl border border-white/10 bg-white/[.035] p-4">
      <div className="flex justify-between">
        <Label>{label}</Label>
        <span className="font-mono text-[9px] text-slate-500">
          Balance {address && balance ? Number(formatUnits(balance.raw, asset.decimals)).toFixed(4) : "—"}
        </span>
      </div>
      <div className="mt-4 flex items-center justify-between">
        <select value={token} onChange={(event) => onTokenChange?.(event.target.value)} disabled={disabled} className="rounded-lg border border-white/10 bg-[#101725] p-2 font-bold text-white outline-none">
          {BASE_SWAP_ASSETS.map((option) => <option key={option.symbol} value={option.symbol}>{option.symbol}</option>)}
        </select>
        <div className="orbit-swap-amount-control flex items-center gap-2">
          <TokenIcon symbol={token} color={color} />
          {onAmountChange ? <input value={value} onChange={(event) => onAmountChange(event.target.value)} disabled={disabled} inputMode="decimal" placeholder="0.00" className="w-28 bg-transparent text-right text-2xl font-bold text-white outline-none placeholder:text-slate-600" /> : <span className="text-2xl font-bold text-slate-400">{value || "0.00"}</span>}
        </div>
      </div>
      {onMax && <button type="button" onClick={onMax} disabled={disabled} className="orbit-form-max mt-3 text-[10px] font-bold">MAX</button>}
    </div>
  );
}
function Discover() {
  const { data, isLoading, isError, error, refetch } = useDiscover();
  const [search, setSearch] = useState("");
  const filteredOpportunities = data?.opportunities.filter((opportunity) =>
    `${opportunity.name} ${opportunity.symbol}`.toLowerCase().includes(search.toLowerCase()),
  ) ?? [];

  const formatUsd = (value: number | null) => {
    if (value === null) return "Unavailable";
    return value >= 1_000_000_000
      ? `$${(value / 1_000_000_000).toFixed(2)}B`
      : value >= 1_000_000
        ? `$${(value / 1_000_000).toFixed(2)}M`
        : `$${(value / 1_000).toFixed(1)}K`;
  };

  const content = isLoading ? (
    <div className="grid gap-4 md:grid-cols-3">
      {[1, 2, 3].map((item) => <Card key={item} className="h-32 animate-pulse bg-white/[.03]"><span /></Card>)}
    </div>
  ) : isError ? (
    <Card className="p-6">
      <Label>Discover unavailable</Label>
      <p className="mt-2 text-sm text-slate-300">Live public market data could not be loaded.</p>
      <p className="mt-1 text-xs text-slate-500">{error instanceof Error ? error.message : "Try again shortly."}</p>
      <Button className="mt-5" variant="secondary" onClick={() => void refetch()}>Retry</Button>
    </Card>
  ) : (
    <>
      <div>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <Label>Trending ecosystems</Label>
            <h2 className="mt-2 text-xl font-bold">Live network activity</h2>
          </div>
          <span className="text-[10px] font-semibold uppercase tracking-widest text-emerald-300">Public data</span>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {data?.ecosystems.map((ecosystem) => (
            <Card key={ecosystem.name} className="p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full" style={{ background: ecosystem.color }}>
                    {ecosystem.name === "Arc" && <ChainLogo chainId={arcTestnet.id} className="h-6 w-6" />}
                  </div>
                  <div>
                    <p className="font-bold">{ecosystem.name}</p>
                    <p className="text-[10px] text-slate-500">{ecosystem.protocolCount.toLocaleString()} tracked protocols</p>
                  </div>
                </div>
                <TrendingUp size={16} className="text-emerald-300" />
              </div>
              <div className="mt-5 flex items-end justify-between">
                <span className="font-mono text-[10px] text-slate-500">TOTAL TVL</span>
                <span className="text-lg font-bold">{formatUsd(ecosystem.tvlUsd)}</span>
              </div>
            </Card>
          ))}
        </div>
      </div>
      <div>
        <div className="mb-4">
          <Label>Arc ecosystem opportunities</Label>
          <h2 className="mt-2 text-xl font-bold">Live pools worth investigating</h2>
        </div>
        {filteredOpportunities.length === 0 ? (
          <Card className="p-6 text-sm text-slate-400">{search ? "No live Arc opportunities match your search." : "No eligible Arc opportunities are currently available."}</Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {filteredOpportunities.map((opportunity) => (
              <Card key={opportunity.id} className="p-5">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-400/15 text-sm font-extrabold text-cyan-200">{opportunity.name.slice(0, 1).toUpperCase()}</span>
                    <div>
                      <p className="font-bold">{opportunity.name}</p>
                      <p className="text-[10px] text-slate-500">{opportunity.symbol}</p>
                    </div>
                  </div>
                  <Pill color="cyan">{opportunity.riskSignal}</Pill>
                </div>
                <div className="mt-6 flex items-end justify-between gap-4">
                  <div>
                    <Label>Current APY</Label>
                    <p className="mt-1 text-2xl font-extrabold text-emerald-300">{opportunity.apy.toFixed(2)}%</p>
                  </div>
                  <div>
                    <Label>Pool TVL</Label>
                    <p className="mt-1 text-xs font-semibold">{formatUsd(opportunity.tvlUsd)}</p>
                  </div>
                  <a href={opportunity.poolUrl} target="_blank" rel="noreferrer" className="group flex items-center gap-2 rounded-xl border border-white/10 bg-white/[.045] px-4 py-2.5 text-sm font-bold text-white transition hover:border-white/20 hover:bg-white/[.08]">Explore <ExternalLink size={15} /></a>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </>
  );

  return (
    <div className="space-y-8">
      <PageTitle
        label="Explore / Discover"
        title="Find your next edge."
        action={
          <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[.03] px-3 py-2 text-xs text-slate-500">
            <Search size={14} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search live pools" className="w-36 bg-transparent text-xs text-white outline-none placeholder:text-slate-500" />
          </div>
        }
      />
      {content}
    </div>
  );
}
function SendPage({ paymentRequest }: { paymentRequest?: ArcPaymentRequest | null }) {
  const { address, isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const { prepare, confirm, status, transactionHash, error, reset, gasCost, submissionUncertain, retryRecoveryCheck } = useSendTransaction();
  const isArcTestnet = chainId === arcTestnet.id;
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [completedAt, setCompletedAt] = useState<number | null>(null);
  const [showSendReview, setShowSendReview] = useState(false);
  const sendUiGenerationRef = useRef(0);
  const asset = ARC_USDC;
  const balance = useTokenBalance(asset, address, Boolean(isConnected && isArcTestnet));
  const isPaymentRequestSend = Boolean(paymentRequest);
  const balanceRaw = balance.raw;
  const isBusy = status === "preparing" || status === "ready" || status === "confirmation" || status === "pending";
  const isSendInputInvalid = validateSendRequest({
    address,
    recipient,
    amount,
    balance: balanceRaw,
    decimals: asset.decimals,
  }) !== null;
  useEffect(() => {
    if (status === "confirmed" && transactionHash) setCompletedAt((current) => current ?? Date.now());
    else setCompletedAt(null);
  }, [status, transactionHash]);
  const setInput = (setter: (value: string) => void, value: string) => {
    setter(value);
    setFormError(null);
    setShowSendReview(false);
    if (status !== "idle") reset();
  };
  useEffect(() => {
    if (!paymentRequest) return;
    setRecipient(paymentRequest.recipient);
    setAmount(paymentRequest.amount);
    setFormError(null);
  }, [paymentRequest]);
  const handleMax = () => {
    setAmount(formatUnits(balanceRaw, asset.decimals));
    setFormError(null);
  };
  const startAnotherSend = () => {
    sendUiGenerationRef.current += 1;
    reset();
    const freshForm = createFreshSendFormState();
    setRecipient(freshForm.recipient);
    setAmount(freshForm.amount);
    setFormError(freshForm.formError);
    setCompletedAt(freshForm.completedAt);
    setShowSendReview(freshForm.showReview);
  };
  const prepareSend = async () => {
    const flowGeneration = sendUiGenerationRef.current;
    setFormError(null);
    if (!isConnected || !address) {
      setFormError("Connect your wallet before sending assets.");
      return;
    }
    if (chainId !== arcTestnet.id) {
      setFormError("Switch to Arc Testnet before sending Arc USDC.");
      return;
    }
    if (!isAddress(recipient) || recipient.toLowerCase() === "0x0000000000000000000000000000000000000000" || recipient.toLowerCase() === address.toLowerCase()) {
      setFormError("Enter a valid non-zero recipient address that is not your own wallet.");
      return;
    }
    let rawAmount: bigint;
    try {
      rawAmount = parseUnits(amount || "0", asset.decimals);
    } catch {
      setFormError(`Enter a valid ${asset.symbol} amount with up to ${asset.decimals} decimals.`);
      return;
    }
    if (rawAmount <= 0n) {
      setFormError("Amount must be greater than zero.");
      return;
    }
    if (balance.isError || balance.isLoading) {
      setFormError("Arc USDC balance is unavailable. Refresh and try again.");
      return;
    }
    if (rawAmount > balanceRaw) {
      setFormError(`Insufficient ${asset.symbol} balance.`);
      return;
    }
    const prepared = await prepare({ asset, recipient: recipient as Address, amount: rawAmount });
    if (!isCurrentSendFlow(flowGeneration, sendUiGenerationRef.current)) return;
    setShowSendReview(prepared);
  };
  const stateMessage = status === "preparing" ? "Preparing transaction and estimating Arc gas..." : status === "ready" ? "Review the estimated fee, then slide to send." : status === "confirmation" ? "Confirm this transaction in your wallet." : status === "pending" ? "Transaction pending on Arc Testnet..." : status === "timeout" ? "Receipt check timed out. The transaction outcome is still unresolved." : status === "rpc-error" ? "RPC could not verify the saved transaction. Its outcome is still unresolved." : status === "uncertain" ? "Wallet submission outcome is unknown. Check wallet activity before retrying." : status === "recovery-mismatch" ? "A saved Send transaction belongs to a different chain context. Switch to Arc Testnet to check it." : status === "reverted" ? "The Send transaction reverted on Arc Testnet." : status === "confirmed" ? "Transaction confirmed." : status === "rejected" ? "Transaction rejected in wallet." : status === "failed" ? error?.message ?? "Transaction failed." : null;
  if (transactionHash && shouldShowSendSuccess({ status, transactionHash })) {
    return (
      <TransactionSuccessScreen
        title="Send Successful!"
        description={recipient && amount
          ? `Your ${asset.symbol} transfer was successfully confirmed on Arc Testnet.`
          : `A Send transaction was confirmed on Arc Testnet. The original amount and recipient are not available in this browser session.`}
        amountLabel="Amount sent"
        amount={amount || "—"}
        token={asset}
        networks={[{ label: "Network", network: { id: arcTestnet.id, name: "Arc Testnet" } }]}
        recipient={recipient || undefined}
        transactionHash={transactionHash}
        explorerUrl={explorerTxUrl(transactionHash, arcTestnet.id)}
        gasFee={gasCost === null ? "Unavailable" : `${formatEther(gasCost)} USDC`}
        completedAt={completedAt ?? Date.now()}
        primaryLabel="Send Again"
        onBack={startAnotherSend}
        onPrimary={startAnotherSend}
      />
    );
  }
  return (
    <div className="orbit-action-page orbit-send-page mx-auto max-w-3xl space-y-6">
      <PageTitle label="Move / Send" title="Send assets securely." />
      {!isConnected ? <Card className="flex flex-col items-center justify-center p-16 text-center" glow><div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-cyan-300/10 text-cyan-300"><Wallet size={28} /></div><h2 className="mt-6 text-2xl font-bold">Connect your wallet</h2><p className="mt-3 max-w-md text-sm leading-6 text-slate-500">Connect a wallet to send Arc Testnet USDC.</p><WalletButton className="mt-7" /></Card> : !isArcTestnet ? <Card className="flex flex-col items-center justify-center p-16 text-center" glow><ShieldCheck size={28} className="text-amber-300" /><h2 className="mt-6 text-2xl font-bold">Switch to Arc Testnet</h2><p className="mt-3 max-w-md text-sm leading-6 text-slate-500">Send uses the official Arc Testnet USDC contract and your connected wallet.</p><Button className="mt-6" variant="secondary" onClick={() => switchChain({ chainId: arcTestnet.id })}>Switch to Arc Testnet</Button></Card> : <Card className="p-5" glow><div className="mb-5"><Label>Send / Arc Testnet</Label><h2 className="mt-2 text-xl font-bold">{isPaymentRequestSend ? "Pay Arc USDC request" : "Transfer from your wallet"}</h2></div><div className="space-y-4"><div><span className="mb-2 block text-xs font-semibold text-slate-400">Asset</span><div className="rounded-xl border border-white/10 bg-white/[.04] px-4 py-3 text-sm font-bold text-white">USDC <span className="ml-2 font-normal text-slate-500">Official Arc ERC-20</span></div></div><label className="block"><span className="mb-2 block text-xs font-semibold text-slate-400">Recipient address</span><input value={recipient} onChange={(event) => setInput(setRecipient, event.target.value)} disabled={isBusy || Boolean(transactionHash) || submissionUncertain || isPaymentRequestSend} placeholder="0x..." className="w-full rounded-xl border border-white/10 bg-white/[.04] px-4 py-3 font-mono text-sm text-white outline-none placeholder:text-slate-600 focus:border-cyan-300/40" /></label><label className="block"><span className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-400"><span>Amount</span><button type="button" onClick={handleMax} disabled={isBusy || Boolean(transactionHash) || submissionUncertain || isPaymentRequestSend || balance.isLoading || balance.isError} className="font-mono text-[10px] text-cyan-300 hover:text-cyan-200">MAX</button></span><div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[.04] px-4"><input value={amount} onChange={(event) => setInput(setAmount, event.target.value)} disabled={isBusy || Boolean(transactionHash) || submissionUncertain || isPaymentRequestSend} inputMode="decimal" placeholder="0.00" className="min-w-0 flex-1 bg-transparent py-3 text-lg font-bold text-white outline-none placeholder:text-slate-600" /><span className="font-mono text-xs text-slate-500">USDC</span></div><span className="mt-2 block font-mono text-[10px] text-slate-500">Available {balance.isLoading ? "..." : balance.isError ? "Unavailable" : `${formatUnits(balanceRaw, asset.decimals)} USDC`}</span></label>{isPaymentRequestSend && <div className="rounded-xl border border-cyan-300/20 bg-cyan-300/[.05] p-4 text-xs text-slate-300">This request is for {paymentRequest?.amount} USDC to {paymentRequest?.recipient}. Review the details in your wallet before confirming.</div>}<div className="rounded-xl border border-cyan-300/20 bg-cyan-300/[.05] p-4 text-xs"><p className="font-semibold text-cyan-100">Transaction preview</p><div className="mt-3 space-y-2 text-slate-300"><div className="flex justify-between gap-3"><span className="text-slate-500">Network</span><span>Arc Testnet</span></div><div className="flex justify-between gap-3"><span className="text-slate-500">Asset / amount</span><span>{amount || "0"} USDC</span></div><div className="flex justify-between gap-3"><span className="text-slate-500">Recipient</span><span className="max-w-[65%] truncate font-mono">{recipient || "Not provided"}</span></div><div className="flex justify-between gap-3"><span className="text-slate-500">Estimated gas</span><span>{gasCost !== null ? `${formatUnits(gasCost, 18)} native USDC` : "Estimated during preparation"}</span></div></div><p className="mt-3 text-[10px] leading-4 text-amber-200">Arc gas is paid in native USDC. ERC-20 balance alone does not guarantee enough gas.</p></div></div>{(formError || stateMessage) && <p className={`mt-4 text-xs ${status === "confirmed" ? "text-emerald-300" : status === "failed" || status === "rejected" || formError ? "text-rose-300" : "text-cyan-300"}`}>{formError || stateMessage}</p>}{transactionHash && <p className="mt-3 text-xs text-emerald-300">Hash: <a href={explorerTxUrl(transactionHash, arcTestnet.id)} target="_blank" rel="noopener noreferrer" className="underline">{shortAddr(transactionHash)}</a></p>}                  <Button onClick={() => submissionUncertain ? void retryRecoveryCheck() : (status === "confirmed" || status === "reverted") && transactionHash ? reset() : void prepareSend()} disabled={submissionUncertain ? false : (status === "confirmed" || status === "reverted") && transactionHash ? false : isBusy || Boolean(transactionHash) || balance.isLoading || balance.isError || isSendInputInvalid} className="mt-5 w-full" icon>{submissionUncertain ? "Check transaction status" : status === "confirmation" ? "Confirm in wallet" : status === "pending" ? "Sending..." : status === "confirmed" || status === "reverted" ? "Prepare another send" : "Review and send"}</Button>{showSendReview && status !== "idle" && status !== "preparing" && status !== "confirmed" && <div className="mt-5 space-y-3 rounded-xl border border-lime-300/20 bg-lime-300/[.04] p-4" aria-label="Review send details"><p className="text-sm font-semibold text-white">Review send details</p><dl className="grid gap-3 text-xs sm:grid-cols-2"><div><dt className="text-slate-500">Recipient</dt><dd className="mt-1 break-all font-mono text-slate-200">{recipient}</dd></div><div><dt className="text-slate-500">Amount</dt><dd className="mt-1 text-slate-200">{amount} USDC</dd></div><div><dt className="text-slate-500">Network</dt><dd className="mt-1 text-slate-200">Arc Testnet</dd></div><div><dt className="text-slate-500">Estimated fee</dt><dd className="mt-1 text-slate-200">{gasCost === null ? "Unavailable" : `${formatUnits(gasCost, 18)} native USDC`}</dd></div></dl><SlideToConfirm label="Slide to send" confirmationKey={`${address?.toLowerCase() ?? ""}:${chainId ?? ""}:${recipient.toLowerCase()}:${amount}:${gasCost?.toString() ?? ""}`} phase={status === "confirmation" ? "submitting" : status === "pending" ? "pending" : status === "rejected" ? "rejected" : status === "failed" ? "failed" : "idle"} disabled={Boolean(transactionHash) || submissionUncertain} onConfirm={() => confirm({ asset, recipient: recipient as Address, amount: parseUnits(amount, asset.decimals) })} /><Button variant="secondary" className="w-full" disabled={isBusy || Boolean(transactionHash) || submissionUncertain} onClick={() => { setShowSendReview(false); reset(); }}>Cancel review</Button></div>}</Card>}
    </div>
  );
}

function BridgeNetworkPicker({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: number;
  options: BridgeChain[];
  onChange: (chainId: number) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.id === value));
  const selected = options[selectedIndex] ?? options[0];

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const choose = (index: number) => {
    const next = options[index];
    if (!next) return;
    onChange(next.id);
    setOpen(false);
  };

  return (
    <div ref={pickerRef} className="orbit-bridge-network-picker relative mt-3">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled || options.length === 0}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
            event.preventDefault();
            choose((selectedIndex + 1) % options.length);
          } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
            event.preventDefault();
            choose((selectedIndex - 1 + options.length) % options.length);
          } else if (event.key === 'Home') {
            event.preventDefault();
            choose(0);
          } else if (event.key === 'End') {
            event.preventDefault();
            choose(options.length - 1);
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen((current) => !current);
          }
        }}
        className="orbit-bridge-network-picker__trigger flex w-full items-center justify-between gap-3 rounded-xl border border-white/10 bg-[#101725] px-3 py-2.5 text-left text-sm font-bold text-white outline-none transition hover:border-cyan-300/30 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ChainLogo chainId={selected?.id ?? value} className="h-5 w-5 shrink-0" />
          <span className="truncate">{selected?.name ?? 'Unavailable'}</span>
        </span>
        <span aria-hidden="true" className="text-slate-500">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div role="listbox" aria-label={label} className="absolute left-0 right-0 top-full z-30 mt-2 max-h-64 overflow-y-auto rounded-xl border border-slate-700 bg-slate-950 p-1.5 shadow-[0_20px_50px_rgba(2,6,23,0.65)]">
          {options.map((option, index) => {
            const isSelected = option.id === value;
            return (
              <button
                type="button"
                role="option"
                aria-selected={isSelected}
                key={option.id}
                onClick={() => choose(index)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs transition ${isSelected ? 'text-white' : 'text-slate-300 hover:bg-white/[.06] hover:text-white'}`}
              >
                <ChainLogo chainId={option.id} className="h-5 w-5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{option.name}</span>
                {isSelected && <span className="text-[10px] text-cyan-300">Selected</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ReceivePage() {
  const { address, isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const isArcTestnet = chainId === arcTestnet.id;
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copyAddress = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopyError(null);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopyError("Unable to copy the wallet address. Select and copy it manually.");
    }
  };
  return <div className="orbit-action-page orbit-receive-page mx-auto max-w-3xl space-y-6"><PageTitle label="Move / Receive" title="Fund your wallet." /><div className="flex items-center gap-2 text-xs font-semibold text-slate-400"><ChainLogo chainId={arcTestnet.id} className="h-5 w-5" />Arc Testnet / USDC</div>{!isConnected || !address ? <Card className="flex flex-col items-center justify-center p-16 text-center" glow><div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-cyan-300/10 text-cyan-300"><Wallet size={28} /></div><h2 className="mt-6 text-2xl font-bold">Connect your wallet</h2><p className="mt-3 max-w-md text-sm leading-6 text-slate-500">Connect a wallet to display your Arc Testnet receiving address.</p><WalletButton className="mt-7" /></Card> : <Card className="flex flex-col items-center p-8 text-center" glow><div className="flex items-center gap-2 text-sm font-bold text-slate-200"><ChainLogo chainId={arcTestnet.id} className="h-6 w-6" />Arc Testnet</div><Label>Your Arc Testnet wallet address</Label><div className="mt-6 rounded-2xl bg-white p-4"><QRCodeSVG value={address} size={188} bgColor="#ffffff" fgColor="#070a11" includeMargin /></div><p className="mt-6 max-w-lg break-all font-mono text-xs leading-6 text-slate-300">{address}</p><p className="mt-3 max-w-md text-sm leading-6 text-slate-500">Send real USDC to this connected wallet address on Arc Testnet. The QR and copied value are the wallet address itself.</p>{!isArcTestnet && <Button variant="secondary" onClick={() => switchChain({ chainId: arcTestnet.id })} className="mt-6">Switch to Arc Testnet</Button>}<Button variant="secondary" onClick={() => void copyAddress()} className="mt-6"><Copy size={15} />{copied ? "Copied" : "Copy address"}</Button>{copyError && <p className="mt-3 text-xs text-rose-300">{copyError}</p>}</Card>}</div>;
}
function WatchlistPage() {
  const { items, has, toggle, remove } = useWatchlist();
  const [search, setSearch] = useState("");
  const [assetToAdd, setAssetToAdd] = useState("ETH");
  const [protocolToAdd, setProtocolToAdd] = useState("");
  const { prices, isLoading: isPricesLoading, isError: isPricesError, error: pricesError, refetch: refetchPrices } = usePrices(PORTFOLIO_PRICES);
  const { data: discoverData, isLoading: isDiscoverLoading, isError: isDiscoverError, error: discoverError, refetch: refetchDiscover } = useDiscover();

  const assetOptions = [ARC_USDC];
  const protocolOptions = discoverData?.opportunities ?? [];
  const availableAssetOptions = assetOptions.filter((asset) => !has(asset.symbol, "asset"));
  const availableProtocolOptions = protocolOptions.filter((opportunity) => !has(opportunity.id, "protocol"));

  const displayedItems = items.filter((item) => {
    if (item.kind === "asset") {
      const asset = assetOptions.find((candidate) => candidate.symbol === item.id);
      const haystack = `${asset?.name ?? item.id} ${item.id}`.toLowerCase();
      return haystack.includes(search.toLowerCase());
    }
    const protocol = protocolOptions.find((candidate) => candidate.id === item.id);
    const haystack = `${protocol?.name ?? item.id} ${protocol?.symbol ?? ""}`.toLowerCase();
    return haystack.includes(search.toLowerCase());
  });

  const isLoading = isPricesLoading || isDiscoverLoading;
  const isError = isPricesError || isDiscoverError;
  const formatUsd = (value: number | null) => {
    if (value === null || Number.isNaN(value)) return "Unavailable";
    if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
    if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
    return `$${value.toFixed(2)}`;
  };

  const addAsset = () => {
    const nextAsset = assetOptions.find((asset) => asset.symbol === assetToAdd);
    if (!nextAsset) return;
    toggle({ id: nextAsset.symbol, kind: "asset" });
    setAssetToAdd(nextAsset.symbol);
  };

  const addProtocol = () => {
    if (!protocolToAdd) return;
    toggle({ id: protocolToAdd, kind: "protocol" });
    setProtocolToAdd("");
  };

  const handleRefresh = () => {
    void Promise.all([refetchPrices(), refetchDiscover()]);
  };

  const renderRow = (item: WatchlistItem) => {
    if (item.kind === "asset") {
      const asset = assetOptions.find((candidate) => candidate.symbol === item.id) ?? assetOptions[0];
      const price = prices[item.id] ?? null;
      return (
        <div key={`${item.kind}-${item.id}`} className="rounded-2xl border border-white/10 bg-white/[.03] p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <TokenIcon symbol={asset.symbol} color={asset.color} />
              <div>
                <p className="font-bold text-white">{asset.name}</p>
                <p className="font-mono text-[10px] text-slate-500">{asset.symbol}</p>
              </div>
            </div>
            <button
              onClick={() => remove(item)}
              className="rounded-lg border border-white/10 bg-white/[.04] px-2 py-1 text-[10px] font-bold text-slate-400 hover:text-white"
            >
              Remove
            </button>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3 text-xs">
            <div className="rounded-xl bg-slate-950/40 p-3">
              <p className="text-slate-500">Price</p>
              <p className="mt-2 font-mono font-bold text-slate-200">
                {typeof price === "number" ? `$${price.toLocaleString(undefined, { maximumFractionDigits: price >= 1 ? 2 : 4 })}` : "Unavailable"}
              </p>
            </div>
            <div className="rounded-xl bg-slate-950/40 p-3">
              <p className="text-slate-500">Type</p>
              <p className="mt-2 font-semibold text-cyan-300">Asset</p>
            </div>
          </div>
        </div>
      );
    }

    const protocol = protocolOptions.find((candidate) => candidate.id === item.id);
    if (!protocol) {
      return (
        <div key={`${item.kind}-${item.id}`} className="rounded-2xl border border-white/10 bg-white/[.03] p-4 text-sm text-slate-400">
          <div className="flex items-center justify-between gap-4">
            <span>Protocol no longer available</span>
            <button onClick={() => remove(item)} className="rounded-lg border border-white/10 bg-white/[.04] px-2 py-1 text-[10px] font-bold text-slate-400 hover:text-white">Remove</button>
          </div>
        </div>
      );
    }

    return (
      <div key={`${item.kind}-${item.id}`} className="rounded-2xl border border-white/10 bg-white/[.03] p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-400/15 text-sm font-extrabold text-cyan-200">{protocol.name.slice(0, 1).toUpperCase()}</span>
            <div>
              <p className="font-bold text-white">{protocol.name}</p>
              <p className="text-[10px] text-slate-500">{protocol.symbol}</p>
            </div>
          </div>
          <button
            onClick={() => remove(item)}
            className="rounded-lg border border-white/10 bg-white/[.04] px-2 py-1 text-[10px] font-bold text-slate-400 hover:text-white"
          >
            Remove
          </button>
        </div>
        <div className="mt-5 grid grid-cols-3 gap-3 text-xs">
          <div className="rounded-xl bg-slate-950/40 p-3">
            <p className="text-slate-500">APY</p>
            <p className="mt-2 font-bold text-emerald-300">{protocol.apy.toFixed(2)}%</p>
          </div>
          <div className="rounded-xl bg-slate-950/40 p-3">
            <p className="text-slate-500">TVL</p>
            <p className="mt-2 font-bold text-slate-200">{formatUsd(protocol.tvlUsd)}</p>
          </div>
          <div className="rounded-xl bg-slate-950/40 p-3">
            <p className="text-slate-500">Risk</p>
            <Pill color={protocol.riskSignal.toLowerCase().includes("low") ? "green" : protocol.riskSignal.toLowerCase().includes("medium") ? "amber" : "red"}>{protocol.riskSignal}</Pill>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <PageTitle
        label="Explore / Watchlist"
        title="Keep an eye on the signal."
        action={
          <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[.03] px-3 py-2 text-xs text-slate-500">
            <Search size={14} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search watchlist"
              className="w-36 bg-transparent text-xs text-white outline-none placeholder:text-slate-500"
            />
          </div>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[1.55fr_0.9fr]">
        <Card className="p-5" glow>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[.06] pb-4">
            <div>
              <Label>My watchlist</Label>
              <p className="mt-2 text-sm text-slate-400">{items.length} tracked assets and protocols</p>
            </div>
            <Button variant="secondary" onClick={handleRefresh} disabled={isLoading}>
              <RefreshCw size={15} className={isLoading ? "animate-spin" : ""} />
              {isLoading ? "Refreshing..." : "Refresh"}
            </Button>
          </div>

          {isLoading ? (
            <div className="mt-5 grid gap-3">
              {[1, 2, 3].map((entry) => (
                <div key={entry} className="h-28 animate-pulse rounded-2xl bg-white/[.04]" />
              ))}
            </div>
          ) : isError ? (
            <div className="mt-5 rounded-2xl border border-rose-300/20 bg-rose-300/[.05] p-6 text-sm text-rose-200">
              <p className="font-bold">Watchlist data unavailable</p>
              <p className="mt-2 text-rose-100/80">
                {pricesError instanceof Error ? pricesError.message : discoverError instanceof Error ? discoverError.message : "Live data could not be refreshed."}
              </p>
              <Button className="mt-4" variant="secondary" onClick={handleRefresh}>Retry</Button>
            </div>
          ) : items.length === 0 ? (
            <div className="mt-5 flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/[.015] p-10 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-cyan-300/10 text-cyan-300">
                <Radar size={28} />
              </div>
              <h2 className="mt-6 text-xl font-bold">Your watchlist is empty</h2>
              <p className="mt-3 max-w-sm text-sm leading-6 text-slate-500">
                Add a live asset or Base protocol to track price, TVL, and yield signals here.
              </p>
            </div>
          ) : displayedItems.length === 0 ? (
            <div className="mt-5 rounded-2xl border border-white/10 bg-white/[.015] p-6 text-sm text-slate-400">
              No items match your current search.
            </div>
          ) : (
            <div className="mt-5 grid gap-3">{displayedItems.map((item) => renderRow(item))}</div>
          )}
        </Card>

        <Card className="p-5" glow>
          <Label>Add to watchlist</Label>
          <div className="mt-4 space-y-5">
            <div>
              <p className="mb-2 text-xs font-semibold text-slate-400">Assets</p>
              <select
                value={assetToAdd}
                onChange={(event) => setAssetToAdd(event.target.value)}
                className="w-full rounded-xl border border-white/10 bg-[#101725] px-3 py-2.5 text-sm font-bold text-white outline-none"
                disabled={availableAssetOptions.length === 0}
              >
                {availableAssetOptions.length === 0 ? (
                  <option value="">All supported assets already added</option>
                ) : (
                  assetOptions.map((asset) => (
                    <option key={asset.symbol} value={asset.symbol} disabled={has(asset.symbol, "asset")}>
                      {asset.symbol}
                    </option>
                  ))
                )}
              </select>
              <Button className="mt-3 w-full" variant="secondary" onClick={addAsset} disabled={availableAssetOptions.length === 0}>
                Add asset
              </Button>
            </div>

            <div>
              <p className="mb-2 text-xs font-semibold text-slate-400">Arc protocols</p>
              <select
                value={protocolToAdd}
                onChange={(event) => setProtocolToAdd(event.target.value)}
                className="w-full rounded-xl border border-white/10 bg-[#101725] px-3 py-2.5 text-sm font-bold text-white outline-none"
                disabled={availableProtocolOptions.length === 0}
              >
                {availableProtocolOptions.length === 0 ? (
                  <option value="">No live Arc protocols available</option>
                ) : (
                  <option value="">Select protocol</option>
                )}
                {availableProtocolOptions.slice(0, 12).map((opportunity) => (
                  <option key={opportunity.id} value={opportunity.id}>
                    {opportunity.name}
                  </option>
                ))}
              </select>
              <Button className="mt-3 w-full" variant="secondary" onClick={addProtocol} disabled={!protocolToAdd || availableProtocolOptions.length === 0}>
                Add protocol
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
declare const __APP_VERSION__: string;

function SettingsPage() {
  const { address, isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const { settings, setDensity, setExplorer, setRefreshMode, hasStorage } = useOrbitSettings();
  const watchlist = useWatchlist();
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearMessage, setClearMessage] = useState<string | null>(null);

  const activeChain = supportedChains.find((item) => item.id === chainId);
  const walletStateLabel = !isConnected ? 'Wallet disconnected' : !activeChain ? 'Unsupported network' : activeChain.name;
  const networkStatusPill = !isConnected ? 'amber' : !activeChain ? 'amber' : 'green';

  const handleClearWatchlist = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      setClearMessage('This removes all locally stored watchlist entries from this browser.');
      return;
    }

    const current = watchlist.items.slice();
    current.forEach((item) => watchlist.remove(item));
    setConfirmClear(false);
    setClearMessage('Local watchlist cleared.');
  };

  return (
    <div className={settings.density === 'compact' ? 'space-y-3' : 'space-y-6'}>
      <PageTitle
        label="ORBIT / Settings"
        title="Configuration center."
        action={
          <Button
            variant="secondary"
            onClick={() => switchChain({ chainId: arcTestnet.id })}
            disabled={!isConnected || chainId === arcTestnet.id}
          >
            <RefreshCw size={15} />
            {!isConnected ? 'Connect wallet' : chainId === arcTestnet.id ? 'Arc Testnet ready' : 'Switch to Arc Testnet'}
          </Button>
        }
      />

      <div className={settings.density === 'compact' ? 'grid gap-3 lg:grid-cols-2' : 'grid gap-4 lg:grid-cols-2'}>
        <Card className="p-5" glow>
          <Label>Wallet & network</Label>
          <div className={settings.density === 'compact' ? 'mt-3 space-y-3 text-sm' : 'mt-4 space-y-4 text-sm'}>
            <div className={settings.density === 'compact' ? 'rounded-xl border border-white/10 bg-white/[.02] p-2' : 'rounded-xl border border-white/10 bg-white/[.02] p-3'}>
              <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Wallet</p>
              <p className="mt-2 font-semibold text-slate-200">{isConnected && address ? shortAddr(address) : 'Wallet disconnected'}</p>
            </div>
            <div className={settings.density === 'compact' ? 'rounded-xl border border-white/10 bg-white/[.02] p-2' : 'rounded-xl border border-white/10 bg-white/[.02] p-3'}>
              <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Current network</p>
              <div className="mt-2 flex items-center justify-between gap-3">
                <p className="font-semibold text-slate-200">{walletStateLabel}</p>
                <Pill color={networkStatusPill === 'green' ? 'green' : 'amber'}>{!isConnected ? 'Disconnected' : !activeChain ? 'Unsupported' : 'Connected'}</Pill>
              </div>
            </div>
            <div className={settings.density === 'compact' ? 'rounded-xl border border-white/10 bg-white/[.02] p-2' : 'rounded-xl border border-white/10 bg-white/[.02] p-3'}>
              <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Wallet security</p>
              <p className="mt-2 text-slate-300">ORBIT reads wallet state, network status, and transaction history with your explicit wallet approval. ORBIT does not store private keys or seed phrases.</p>
            </div>
          </div>
        </Card>

        <Card className="p-5" glow>
          <Label>Supported networks</Label>
          <div className={settings.density === 'compact' ? 'mt-3 space-y-3 text-sm' : 'mt-4 space-y-4 text-sm'}>
            <div className={settings.density === 'compact' ? 'rounded-xl border border-white/10 bg-white/[.02] p-2' : 'rounded-xl border border-white/10 bg-white/[.02] p-3'}>
              <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Wallet chains</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {supportedChains.map((chain) => (
                  <Pill key={chain.id} color="green">{chain.name}</Pill>
                ))}
              </div>
            </div>
            <div className={settings.density === 'compact' ? 'rounded-xl border border-white/10 bg-white/[.02] p-2' : 'rounded-xl border border-white/10 bg-white/[.02] p-3'}>
              <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Arc core network</p>
              <p className="mt-2 text-slate-200">Arc Testnet · Chain ID 5042002 · Native gas USDC</p>
              <p className="mt-1 break-all text-xs text-slate-500">RPC https://rpc.testnet.arc.io · Explorer https://testnet.arcscan.app</p>
            </div>
          </div>
        </Card>
      </div>

      <div className={settings.density === 'compact' ? 'grid gap-3 lg:grid-cols-2' : 'grid gap-4 lg:grid-cols-2'}>
        <Card className="p-5" glow>
          <Label>Explorer & refresh</Label>
          <div className={settings.density === 'compact' ? 'mt-3 space-y-3' : 'mt-4 space-y-4'}>
            <div className={settings.density === 'compact' ? 'rounded-xl border border-white/10 bg-white/[.02] p-2' : 'rounded-xl border border-white/10 bg-white/[.02] p-3'}>
              <p className="mb-2 text-xs font-semibold text-slate-400">Explorer</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  aria-pressed={settings.explorer === 'arcscan'}
                  onClick={() => setExplorer('arcscan')}
                  className={`flex-1 rounded-xl border px-3 py-2 text-sm font-bold ${settings.explorer === 'arcscan' ? 'border-cyan-300/30 bg-cyan-300/10 text-cyan-200' : 'border-white/10 bg-[#101725] text-slate-300'}`}
                >
                  ArcScan
                </button>
              </div>
              <p className="mt-2 text-[11px] text-slate-500">Arc activity and transaction links use the official ArcScan explorer.</p>
            </div>

            <div className={settings.density === 'compact' ? 'rounded-xl border border-white/10 bg-white/[.02] p-2' : 'rounded-xl border border-white/10 bg-white/[.02] p-3'}>
              <p className="mb-2 text-xs font-semibold text-slate-400">Refresh behavior</p>
              <div className="grid gap-2 sm:grid-cols-3">
                {(['manual', 'balanced', 'live'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={settings.refreshMode === mode}
                    onClick={() => setRefreshMode(mode)}
                    className={`rounded-xl border px-3 py-2 text-xs font-bold uppercase tracking-[.14em] ${settings.refreshMode === mode ? 'border-cyan-300/30 bg-cyan-300/10 text-cyan-200' : 'border-white/10 bg-[#101725] text-slate-300'}`}
                  >
                    {formatRefreshMode(mode)}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-slate-500">Manual gives you full control; balanced uses a reasonable stale window; live refreshes more aggressively when supported.</p>
            </div>
          </div>
        </Card>

        <Card className="p-5" glow>
          <Label>Display & local preferences</Label>
          <div className={settings.density === 'compact' ? 'mt-3 space-y-3' : 'mt-4 space-y-4'}>
            <div className={settings.density === 'compact' ? 'rounded-xl border border-white/10 bg-white/[.02] p-2' : 'rounded-xl border border-white/10 bg-white/[.02] p-3'}>
              <p className="mb-2 text-xs font-semibold text-slate-400">Information density</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  aria-pressed={settings.density === 'comfortable'}
                  onClick={() => setDensity('comfortable')}
                  className={`rounded-xl border px-3 py-2 text-sm font-bold ${settings.density === 'comfortable' ? 'border-cyan-300/30 bg-cyan-300/10 text-cyan-200' : 'border-white/10 bg-[#101725] text-slate-300'}`}
                >
                  Comfortable
                </button>
                <button
                  type="button"
                  aria-pressed={settings.density === 'compact'}
                  onClick={() => setDensity('compact')}
                  className={`rounded-xl border px-3 py-2 text-sm font-bold ${settings.density === 'compact' ? 'border-cyan-300/30 bg-cyan-300/10 text-cyan-200' : 'border-white/10 bg-[#101725] text-slate-300'}`}
                >
                  Compact
                </button>
              </div>
              <p className="mt-2 text-[11px] text-slate-500">Density affects ORBIT’s supported layout spacing and content density while keeping the same underlying data and actions.</p>
            </div>

            <div className={settings.density === 'compact' ? 'rounded-xl border border-white/10 bg-white/[.02] p-2' : 'rounded-xl border border-white/10 bg-white/[.02] p-3'}>
              <p className="mb-2 text-xs font-semibold text-slate-400">Persistence</p>
              <p className="text-sm text-slate-300">Explorer, refresh behavior, and density are persisted in browser local storage only.</p>
              <p className="mt-2 text-[11px] text-slate-500">{hasStorage ? 'Browser storage is available for persisted preferences.' : 'Local storage is unavailable in this environment, so these settings are temporary.'}</p>
            </div>
          </div>
        </Card>
      </div>

      <div className={settings.density === 'compact' ? 'grid gap-3 lg:grid-cols-2' : 'grid gap-4 lg:grid-cols-2'}>
        <Card className="p-5" glow>
          <Label>Watchlist data</Label>
          <div className={settings.density === 'compact' ? 'mt-3 space-y-3' : 'mt-4 space-y-4'}>
            <div className={settings.density === 'compact' ? 'rounded-xl border border-white/10 bg-white/[.02] p-2' : 'rounded-xl border border-white/10 bg-white/[.02] p-3'}>
              <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Storage mode</p>
              <p className="mt-2 text-slate-200">Local browser persistence only</p>
              <p className="mt-1 text-xs text-slate-500">Watchlist entries are stored locally in this browser. They are not wallet-owned, blockchain data, or synced to another device unless a separate sync system is added.</p>
            </div>
            <div className={settings.density === 'compact' ? 'rounded-xl border border-rose-300/20 bg-rose-300/[.05] p-2' : 'rounded-xl border border-rose-300/20 bg-rose-300/[.05] p-3'}>
              <p className="mb-2 text-xs font-semibold text-rose-200">Clear local watchlist?</p>
              <p className="mb-3 text-xs text-rose-100/80">This removes all locally stored watchlist entries from this browser.</p>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  className="flex-1 justify-center"
                  onClick={() => {
                    setConfirmClear(false);
                    setClearMessage(null);
                  }}
                  disabled={!confirmClear}
                >
                  Cancel
                </Button>
                <Button variant="secondary" className="flex-1 justify-center" onClick={handleClearWatchlist}>
                  {confirmClear ? 'Clear watchlist' : 'Clear local watchlist'}
                </Button>
              </div>
              {clearMessage && <p className="mt-2 text-[11px] text-rose-100/80">{clearMessage}</p>}
            </div>
          </div>
        </Card>

        <Card className="p-5" glow>
          <Label>App information</Label>
          <div className={settings.density === 'compact' ? 'mt-3 space-y-2 text-sm' : 'mt-4 space-y-3 text-sm'}>
            <div className={settings.density === 'compact' ? 'rounded-xl border border-white/10 bg-white/[.02] p-2' : 'rounded-xl border border-white/10 bg-white/[.02] p-3'}>
              <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Network in use</p>
              <p className="mt-2 text-slate-200">{walletStateLabel}</p>
            </div>
            <div className={settings.density === 'compact' ? 'rounded-xl border border-white/10 bg-white/[.02] p-2' : 'rounded-xl border border-white/10 bg-white/[.02] p-3'}>
              <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Supported chain</p>
              <p className="mt-2 text-slate-200">Arc Testnet</p>
            </div>
            <div className={settings.density === 'compact' ? 'rounded-xl border border-white/10 bg-white/[.02] p-2' : 'rounded-xl border border-white/10 bg-white/[.02] p-3'}>
              <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">App version</p>
              <p className="mt-2 text-slate-200">{__APP_VERSION__}</p>
            </div>
            <div className={settings.density === 'compact' ? 'rounded-xl border border-white/10 bg-white/[.02] p-2' : 'rounded-xl border border-white/10 bg-white/[.02] p-3'}>
              <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Data-provider architecture</p>
              <p className="mt-2 text-slate-200">ArcScan activity provider and official Arc RPC</p>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
export function Generic({ page }: { page: Page }) {
  
  const title =
    page === "activity"
      ? "Your onchain trail."
      : page === "watchlist"
        ? "Keep an eye on the signal."
        : page === "receive"
          ? "Fund your wallet."
          : page === "send"
            ? "Send assets securely."
            : "Coming into view.";
  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle label={`ORBIT / ${page}`} title={title} />
      <Card
        className="mt-8 flex flex-col items-center justify-center p-16 text-center"
        glow
      >
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-cyan-300/10 text-cyan-300">
          <Radar size={28} />
        </div>
        <h2 className="mt-6 text-2xl font-bold">Intelligence layer ready</h2>
        <p className="mt-3 max-w-md text-sm leading-6 text-slate-500">
          This workspace is prepared for your onchain data. Connect a wallet to
          unlock the full experience.
        </p>
        <Button className="mt-7" icon>
          Connect Wallet
        </Button>
      </Card>
    </div>
  );
}
function ActivityPage() {
  const { address, isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const isArcTestnet = chainId === arcTestnet.id;
  const isBase = chainId === base.id;
  const isSupportedNetwork = isArcTestnet || isBase;
  const activityNetwork = isArcTestnet ? 'Arc Testnet' : isBase ? 'Base' : 'supported network';
  const [selectedCategory, setSelectedCategory] = useState<
    'all' | 'Send' | 'Receive' | 'Swap' | 'Approval' | 'Contract Interaction' | 'Other'
  >('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedTxHash, setSelectedTxHash] = useState<string | null>(null);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [showAllTransactions, setShowAllTransactions] = useState(false);
  const { transactions, isLoading, isError, refetch, isFetching } =
    useTransactions(address, isConnected && isSupportedNetwork, chainId, showAllTransactions);

  const wrongNetwork = isConnected && !isSupportedNetwork;

  const filteredTransactions = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    return transactions.filter((tx) => {
      const matchesFilter =
        selectedCategory === 'all' ||
        (selectedCategory === 'Other' && ['Bridge', 'Lending', 'Unknown'].includes(tx.category)) ||
        tx.category === selectedCategory;

      if (!matchesFilter) return false;
      if (!query) return true;

      const searchTargets = [
        tx.hash,
        tx.from,
        tx.to,
        tx.category,
        tx.tokenTransfers.map((transfer) => transfer.symbol).join(' '),
        tx.tokenTransfers.map((transfer) => transfer.contractAddress).join(' '),
      ].join(' ').toLowerCase();

      return searchTargets.includes(query);
    });
  }, [searchTerm, selectedCategory, transactions]);

  const summary = useMemo(() => {
    const successful = transactions.filter((tx) => tx.status === 'success').length;
    const failed = transactions.filter((tx) => tx.status === 'failed').length;
    const pending = transactions.filter((tx) => tx.status === 'pending').length;
    return {
      total: transactions.length,
      successful,
      failed,
      pending,
      sends: transactions.filter((tx) => tx.category === 'Send').length,
      receives: transactions.filter((tx) => tx.category === 'Receive').length,
      approvals: transactions.filter((tx) => tx.category === 'Approval').length,
      swaps: transactions.filter((tx) => tx.category === 'Swap').length,
      interactions: transactions.filter((tx) => tx.category === 'Contract Interaction').length,
    };
  }, [transactions]);

  const pendingTransactions = useMemo(
    () => transactions.filter((tx) => tx.status === 'pending'),
    [transactions],
  );

  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(filteredTransactions.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleTransactions = showAllTransactions
    ? filteredTransactions
    : filteredTransactions.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  useEffect(() => {
    setPage(1);
    setShowAllTransactions(false);
  }, [selectedCategory, searchTerm]);

  const selectedTx =
    visibleTransactions.find((tx) => tx.hash === selectedTxHash) ??
    visibleTransactions[0] ??
    null;

  useEffect(() => {
    if (!copiedHash) return;
    const timer = window.setTimeout(() => setCopiedHash(null), 1500);
    return () => window.clearTimeout(timer);
  }, [copiedHash]);

  const handleCopyText = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedHash(value);
    } catch (error) {
      console.warn('Clipboard copy failed', error);
    }
  };

  return (
    <div className="space-y-6">
      <PageTitle
        label="Activity / Onchain History"
        title="Your onchain trail."
        action={
          <Button
            variant="secondary"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            <RefreshCw size={15} className={isFetching ? "animate-spin" : ""} />
            {isFetching ? "Refreshing..." : "Refresh"}
          </Button>
        }
      />
      <div className="flex items-center gap-2 text-xs font-semibold text-slate-400"><ChainLogo chainId={isSupportedNetwork ? chainId : arcTestnet.id} className="h-5 w-5" />{activityNetwork} activity</div>
      {!isConnected ? (
        <Card className="flex flex-col items-center justify-center p-16 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-cyan-300/10 text-cyan-300">
            <Wallet size={28} />
          </div>
          <h2 className="mt-6 text-2xl font-bold">Connect your wallet</h2>
          <p className="mt-3 max-w-md text-sm leading-6 text-slate-500">
            Connect a wallet to view your Arc Testnet transaction history.
          </p>
        </Card>
      ) : wrongNetwork ? (
        <Card className="flex flex-col items-center justify-center p-16 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-300/10 text-amber-300">
            <ShieldCheck size={28} />
          </div>
          <h2 className="mt-6 text-2xl font-bold">Switch to Arc Testnet</h2>
          <p className="mt-3 max-w-md text-sm leading-6 text-slate-500">
            ORBIT activity is currently available on Arc Testnet and Base.
          </p>
          <Button className="mt-6" variant="secondary" onClick={() => switchChain({ chainId: arcTestnet.id })}>
            Switch to Arc Testnet
          </Button>
        </Card>
      ) : isLoading ? (
        <Card className="p-5">
          <div className="space-y-3">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="flex items-center gap-3 py-3">
                <div className="h-10 w-10 animate-pulse rounded-lg bg-white/10" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-32 animate-pulse rounded bg-white/10" />
                  <div className="h-2 w-48 animate-pulse rounded bg-white/10" />
                </div>
                <div className="h-3 w-16 animate-pulse rounded bg-white/10" />
              </div>
            ))}
          </div>
        </Card>
      ) : isError ? (
        <Card className="flex flex-col items-center justify-center p-16 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-rose-300/10 text-rose-300">
            <X size={28} />
          </div>
          <h2 className="mt-6 text-2xl font-bold">Failed to load</h2>
          <p className="mt-3 max-w-md text-sm leading-6 text-slate-500">
            Unable to fetch transaction history. The free API may be rate-limited or the network may have failed. Use refresh to retry.
          </p>
          <Button
            className="mt-6"
            variant="secondary"
            onClick={() => void refetch()}
          >
            <RefreshCw size={15} />
            Try again
          </Button>
        </Card>
      ) : transactions.length === 0 ? (
        <Card className="flex flex-col items-center justify-center p-16 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-cyan-300/10 text-cyan-300">
            <Activity size={28} />
          </div>
          <h2 className="mt-6 text-2xl font-bold">No transactions found</h2>
          <p className="mt-3 max-w-md text-sm leading-6 text-slate-500">
            No recent onchain transactions were found for this wallet on {activityNetwork}.
          </p>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-7">
            <div className="rounded-2xl border border-white/10 bg-white/[.03] p-4">
              <p className="font-mono text-[9px] uppercase tracking-[.18em] text-slate-500">Total</p>
              <p className="mt-2 text-2xl font-extrabold">{summary.total}</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[.03] p-4">
              <p className="font-mono text-[9px] uppercase tracking-[.18em] text-slate-500">Success</p>
              <p className="mt-2 text-2xl font-extrabold text-emerald-300">{summary.successful}</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[.03] p-4">
              <p className="font-mono text-[9px] uppercase tracking-[.18em] text-slate-500">Failed</p>
              <p className="mt-2 text-2xl font-extrabold text-rose-300">{summary.failed}</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[.03] p-4">
              <p className="font-mono text-[9px] uppercase tracking-[.18em] text-slate-500">Pending</p>
              <p className="mt-2 text-2xl font-extrabold text-amber-300">{summary.pending}</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[.03] p-4">
              <p className="font-mono text-[9px] uppercase tracking-[.18em] text-slate-500">Sends</p>
              <p className="mt-2 text-2xl font-extrabold">{summary.sends}</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[.03] p-4">
              <p className="font-mono text-[9px] uppercase tracking-[.18em] text-slate-500">Receives</p>
              <p className="mt-2 text-2xl font-extrabold">{summary.receives}</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[.03] p-4">
              <p className="font-mono text-[9px] uppercase tracking-[.18em] text-slate-500">Approvals</p>
              <p className="mt-2 text-2xl font-extrabold">{summary.approvals}</p>
            </div>
          </div>

          <Card className="overflow-hidden">
            <div className="flex flex-col gap-4 border-b border-white/[.06] p-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <Label>Transaction History</Label>
                  <p className="mt-2 text-sm text-slate-400">
                    Showing {filteredTransactions.length} loaded {activityNetwork} transaction{filteredTransactions.length === 1 ? '' : 's'}
                  </p>
                </div>
                <Pill color="cyan">LIVE DATA</Pill>
              </div>

              <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                <div className="flex-1">
                  <input
                    value={searchTerm}
                    onChange={(event) => setSearchTerm(event.target.value)}
                    placeholder="Search hash, address, token, category"
                    className="w-full rounded-xl border border-white/10 bg-[#101725] px-3 py-2.5 text-sm text-white placeholder:text-slate-500 outline-none"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  {[
                    ['all', 'All'],
                    ['Send', 'Sends'],
                    ['Receive', 'Receives'],
                    ['Swap', 'Swaps'],
                    ['Approval', 'Approvals'],
                    ['Contract Interaction', 'Contract'],
                    ['Other', 'Other'],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      onClick={() => setSelectedCategory(value as 'all' | 'Send' | 'Receive' | 'Swap' | 'Approval' | 'Contract Interaction' | 'Other')}
                      className={`rounded-full border px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[.14em] ${selectedCategory === value ? 'border-cyan-300/30 bg-cyan-300/10 text-cyan-200' : 'border-white/10 bg-white/[.02] text-slate-400 hover:border-white/20 hover:text-slate-200'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {filteredTransactions.length === 0 ? (
              <div className="p-6 text-sm text-slate-400">
                No transactions match the current filters or search terms.
              </div>
            ) : (
              <>
                <div className="min-w-0">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[980px] table-fixed text-left xl:min-w-0">
                      <thead className="border-b border-white/[.06] font-mono text-[9px] uppercase tracking-widest text-slate-600">
                        <tr>
                          <th className="w-[10%] px-3 py-3 text-left">Type</th>
                          <th className="w-[16%] min-w-[150px] px-3 py-3 text-left">Tx Hash</th>
                          <th className="w-[14%] min-w-[110px] px-3 py-3 text-left">From</th>
                          <th className="w-[14%] min-w-[110px] px-3 py-3 text-left">To</th>
                          <th className="w-[18%] min-w-[110px] px-3 py-3 text-left">Value</th>
                          <th className="w-[10%] px-3 py-3 text-left">Status</th>
                          <th className="w-[18%] min-w-[130px] px-3 py-3 text-left">Time</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[.05]">
                        {visibleTransactions.map((tx) => {
                          const Icon = txIcon(tx.category);
                          const isSelected = selectedTx?.hash === tx.hash;
                          return (
                            <tr
                              key={tx.hash}
                              className={`cursor-pointer text-xs transition ${isSelected ? 'bg-cyan-300/[.04]' : 'hover:bg-white/[.025]'}`}
                              onClick={() => setSelectedTxHash(tx.hash)}
                            >
                              <td className="overflow-hidden px-3 py-4 align-top">
                                <div className="flex items-center gap-2">
                                  <Icon size={14} className="text-slate-400" />
                                  <span className="truncate font-semibold">{tx.category}</span>
                                </div>
                              </td>
                              <td className="overflow-hidden px-3 py-4 align-top">
                                  <div className="flex max-w-[150px] items-center gap-2 font-mono text-cyan-300 hover:text-cyan-200">
                                    <a
                                      href={explorerTxUrl(tx.hash, chainId)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      title="Open transaction in block explorer"
                                      className="min-w-0 truncate"
                                      onClick={(event) => event.stopPropagation()}
                                    >
                                      {shortAddr(tx.hash)}
                                    </a>
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void handleCopyText(tx.hash);
                                    }}
                                    title={tx.hash}
                                    className="flex min-w-0 items-center gap-1 text-left"
                                  >
                                    <Copy size={11} className="shrink-0" />
                                  </button>
                                </div>
                              </td>
                              <td className="overflow-hidden px-3 py-4 align-top font-mono text-slate-400">
                                <span title={tx.from} className="block max-w-[110px] truncate">{shortAddr(tx.from)}</span>
                              </td>
                              <td className="overflow-hidden px-3 py-4 align-top font-mono text-slate-400">
                                <span title={tx.to} className="block max-w-[110px] truncate">{shortAddr(tx.to)}</span>
                              </td>
                              <td className="overflow-hidden px-3 py-4 align-top font-mono text-slate-300">
                                <span className="block max-w-[120px] truncate">{formatTransactionAmount(tx)}</span>
                              </td>
                              <td className="overflow-hidden px-3 py-4 align-top">
                                <span className={`inline-flex rounded-full border px-2 py-1 text-[9px] font-semibold uppercase tracking-[.14em] ${getStatusClasses(tx.status)}`}>
                                  {getStatusLabel(tx.status)}
                                </span>
                              </td>
                              <td className="overflow-hidden px-3 py-4 align-top text-slate-500">
                                <span className="block whitespace-nowrap text-[11px]">{getTimeAgo(tx.timestamp)}</span>
                                {tx.timestamp ? <span className="mt-1 block whitespace-nowrap text-[10px] text-slate-500">{formatTransactionDate(tx.timestamp)}</span> : null}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {selectedTx && (
                    <aside className="border-t border-white/[.06] bg-slate-950/60 p-5 sm:p-6">
                      <Label>Transaction details</Label>
                      <div className="mt-4 space-y-4">
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-semibold text-slate-200">{selectedTx.category}</span>
                          <span className={`inline-flex rounded-full border px-2 py-1 text-[9px] font-semibold uppercase tracking-[.12em] ${getStatusClasses(selectedTx.status)}`}>
                            {getStatusLabel(selectedTx.status)}
                          </span>
                        </div>

                        <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                          <div className="min-w-0 rounded-xl border border-white/10 bg-white/[.02] p-3 xl:col-span-2">
                            <div className="flex items-center justify-between gap-2">
                              <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Hash</p>
                              <button
                                type="button"
                                onClick={() => void handleCopyText(selectedTx.hash)}
                                className="inline-flex items-center gap-1 text-[10px] text-cyan-300"
                                title="Copy transaction hash"
                              >
                                {copiedHash === selectedTx.hash ? 'Copied' : 'Copy'} <Copy size={11} />
                              </button>
                            </div>
                            <div className="mt-2 flex items-center gap-2">
                              <a href={explorerTxUrl(selectedTx.hash, chainId)} target="_blank" rel="noopener noreferrer" title={selectedTx.hash} className="min-w-0 flex-1 truncate text-sm text-cyan-300 hover:text-cyan-200">
                                {`${selectedTx.hash.slice(0, 8)}...${selectedTx.hash.slice(-6)}`}
                              </a>
                              <a href={explorerTxUrl(selectedTx.hash, chainId)} target="_blank" rel="noopener noreferrer" className="text-slate-400 hover:text-slate-200" aria-label="View transaction on block explorer">
                                <ExternalLink size={14} />
                              </a>
                            </div>
                          </div>
                          <div className="min-w-0 rounded-xl border border-white/10 bg-white/[.02] p-3">
                            <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Block</p>
                            <p className="mt-2 whitespace-nowrap text-sm font-semibold text-slate-200">
                              {selectedTx.blockNumber !== null ? `#${selectedTx.blockNumber}` : selectedTx.status === 'pending' ? 'Pending' : 'Not mined'}
                            </p>
                          </div>
                          <div className="min-w-0 rounded-xl border border-white/10 bg-white/[.02] p-3">
                            <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Time</p>
                            <p className="mt-2 whitespace-nowrap text-xs font-semibold text-slate-200 sm:text-sm">
                              {formatTransactionDate(selectedTx.timestamp)}
                            </p>
                          </div>
                          <div className="min-w-0 rounded-xl border border-white/10 bg-white/[.02] p-3">
                            <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Value</p>
                            <p className="mt-2 truncate font-mono text-sm text-slate-300" title={formatTxValue(selectedTx.value, selectedTx.nativeSymbol)}>
                              {formatTxValue(selectedTx.value, selectedTx.nativeSymbol)}
                            </p>
                          </div>
                        </div>

                        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                          <div className="min-w-0 rounded-xl border border-white/10 bg-white/[.02] p-3">
                            <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">From</p>
                            <div className="mt-1 flex items-center gap-2">
                              <span title={selectedTx.from} className="min-w-0 flex-1 truncate font-mono text-slate-300">{shortAddr(selectedTx.from)}</span>
                              <button type="button" onClick={() => void handleCopyText(selectedTx.from)} className="text-slate-400 hover:text-slate-200" title="Copy address"><Copy size={12} /></button>
                            </div>
                          </div>
                          <div className="min-w-0 rounded-xl border border-white/10 bg-white/[.02] p-3">
                            <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">To</p>
                            <div className="mt-1 flex items-center gap-2">
                              <span title={selectedTx.to} className="min-w-0 flex-1 truncate font-mono text-slate-300">{shortAddr(selectedTx.to)}</span>
                              <button type="button" onClick={() => void handleCopyText(selectedTx.to)} className="text-slate-400 hover:text-slate-200" title="Copy address"><Copy size={12} /></button>
                            </div>
                          </div>
                        </div>

                        <div>
                          <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Detected interaction</p>
                          <p className="mt-2 text-sm text-slate-300">{selectedTx.category}</p>
                        </div>

                        {selectedTx.tokenTransfers.length > 0 && (
                          <div>
                            <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Token transfers</p>
                            <div className="mt-2 space-y-2">
                              {selectedTx.tokenTransfers.map((transfer, index) => (
                                <div key={`${transfer.hash}-${transfer.contractAddress}-${index}`} className="rounded-lg border border-white/10 bg-white/[.02] p-2 text-xs">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="font-semibold text-slate-200">{transfer.direction === 'sent' ? 'Sent' : 'Received'} {transfer.symbol}</span>
                                    <span className="font-mono text-slate-300">{transfer.amount} {transfer.symbol}</span>
                                  </div>
                                  <p className="mt-1 font-mono text-[10px] text-slate-500">{transfer.contractAddress}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        <a href={explorerTxUrl(selectedTx.hash, chainId)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm font-semibold text-cyan-300 hover:text-cyan-200">
                          View on block explorer
                          <ExternalLink size={13} />
                        </a>
                      </div>
                    </aside>
                  )}
                </div>

                <div className="mt-5 flex flex-col gap-4 border-t border-white/[.06] pt-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm text-slate-400">
                      Showing {filteredTransactions.length === 0 ? 0 : (currentPage - 1) * pageSize + 1}-{Math.min(currentPage * pageSize, filteredTransactions.length)} of {filteredTransactions.length} transactions
                    </p>
                    {filteredTransactions.length > pageSize && (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setPage((value) => Math.max(1, value - 1))}
                          disabled={currentPage === 1}
                          className="rounded-full border border-white/10 bg-white/[.02] px-3 py-1.5 text-xs font-medium text-slate-300 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Previous
                        </button>
                        <div className="flex items-center gap-1">
                          {Array.from({ length: pageCount }, (_, index) => index + 1).map((pageNum) => (
                            <button
                              key={pageNum}
                              type="button"
                              onClick={() => setPage(pageNum)}
                              className={`h-8 min-w-[2rem] rounded-full border px-2 text-xs ${pageNum === currentPage ? 'border-cyan-300/40 bg-cyan-300/10 text-cyan-200' : 'border-white/10 bg-white/[.02] text-slate-400'}`}
                            >
                              {pageNum}
                            </button>
                          ))}
                        </div>
                        <button
                          type="button"
                          onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
                          disabled={currentPage === pageCount}
                          className="rounded-full border border-white/10 bg-white/[.02] px-3 py-1.5 text-xs font-medium text-slate-300 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Next
                        </button>
                      </div>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => setShowAllTransactions((value) => !value)}
                    className="inline-flex items-center gap-2 self-start text-sm font-medium text-cyan-300 transition hover:text-cyan-200"
                  >
                    {showAllTransactions ? 'Show paged view' : 'View all transactions'}
                    <ChevronRight size={14} />
                  </button>
                </div>
              </>
            )}

            <div className="mt-6 rounded-2xl border border-white/10 bg-white/[.02] p-5">
              {pendingTransactions.length > 0 ? (
                <div>
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <h3 className="text-lg font-bold text-white">Pending transactions</h3>
                    <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-[9px] font-semibold uppercase tracking-[.14em] text-amber-200">
                      {pendingTransactions.length} ACTIVE
                    </span>
                  </div>
                  <div className="space-y-3">
                    {pendingTransactions.map((tx) => (
                      <div key={tx.hash} className="rounded-xl border border-white/10 bg-slate-950/40 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-semibold text-slate-200">{tx.category}</span>
                          <span className={`inline-flex rounded-full border px-2 py-1 text-[9px] font-semibold uppercase tracking-[.14em] ${getStatusClasses(tx.status)}`}>
                            {getStatusLabel(tx.status)}
                          </span>
                        </div>
                        <p className="mt-2 truncate font-mono text-xs text-cyan-300">{shortAddr(tx.hash)}</p>
                        <p className="mt-2 text-xs text-slate-400">Submitted {tx.timestamp ? formatTransactionDate(tx.timestamp) : 'recently'} · waiting to be mined</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-6 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-200">
                    <RefreshCw size={18} />
                  </div>
                  <h3 className="mt-4 text-xl font-bold text-white">No pending transactions</h3>
                  <p className="mt-2 max-w-md text-sm leading-6 text-slate-400">
                    You don't have any pending transactions right now.
                    Pending transactions will appear here while they are being mined.
                  </p>
                </div>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
function Dashboard({
  page,
  setPage,
  paymentRequest,
  setPaymentRequest,
}: {
  page: Page;
  setPage: (p: Page) => void;
  paymentRequest: ArcPaymentRequest | null;
  setPaymentRequest: (request: ArcPaymentRequest | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Space>
      <div className="relative z-10 flex h-screen overflow-hidden">
        <Sidebar page={page} setPage={setPage} open={open} setOpen={setOpen} />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <Topbar onMenu={() => setOpen(true)} page={page} />
          <main className="flex-1 overflow-y-auto px-5 py-8 lg:px-8">
            <AnimatePresence mode="wait">
              <motion.div
                key={page}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
              >
                {page === "home" && <Home setPage={setPage} />}
                {page === "portfolio" && <Portfolio />}
                {page === "settings" && <SettingsPage />}
                {page === "security" && (
                  <SecurityCenter
                    onManageApprovals={() => setPage(getSecurityNavigationTarget('manage-approvals'))}
                  />
                )}
                {page === "approvals" && <Approvals />}
                {page === "discover" && <Discover />}
                {page === "watchlist" && <WatchlistPage />}
                {page === "activity" && <ActivityPage />}
                {page === "send" && <SendPage paymentRequest={paymentRequest} />}
                {page === "receive" && <ReceivePage />}
                {page === "arc-pay" && <ArcPayPage onPay={(request) => { setPaymentRequest(request); setPage("send"); }} />}
                {page === "bridge" && <ActionPage type="bridge" />}
                {page === "swap" && <ArcSwapPage />}
                {page === "unified-balance" && (
                  <div className="orbit-unified-balance">
                    <UnifiedBalancePage />
                  </div>
                )}
                {page === "about" && <AboutPage />}
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
      </div>
    </Space>
  );
}
function AboutPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageTitle label="ORBIT / About" title="Onchain intelligence, designed for clarity." />
      <Card className="p-6 md:p-8" glow>
        <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-slate-400">About ORBIT</p>
            <h2 className="mt-3 text-3xl font-extrabold tracking-[-0.05em] text-white">A focused command center for your onchain wallet.</h2>
            <p className="mt-4 text-base leading-7 text-slate-300">
              ORBIT brings together the essentials of a modern onchain portfolio: portfolio value, wallet activity, approvals, transfers, swaps, and security signals in one place.
            </p>
            <p className="mt-4 text-base leading-7 text-slate-300">
              It is built to help you understand your wallet state and onchain activity across supported testnets, with a focused interface and practical controls.
            </p>
          </div>
          <div className="rounded-3xl border border-slate-700 bg-slate-950/60 p-5 shadow-[0_18px_40px_rgba(2,6,23,0.28)]">
            <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-slate-400">What it helps with</p>
            <ul className="mt-4 space-y-3 text-sm text-slate-300">
              <li className="flex gap-3"><span className="mt-1 h-2 w-2 rounded-full bg-cyan-500" />Track portfolio and wallet balances</li>
              <li className="flex gap-3"><span className="mt-1 h-2 w-2 rounded-full bg-cyan-500" />Review recent onchain activity</li>
              <li className="flex gap-3"><span className="mt-1 h-2 w-2 rounded-full bg-cyan-500" />Send, receive, bridge, and swap supported assets</li>
              <li className="flex gap-3"><span className="mt-1 h-2 w-2 rounded-full bg-cyan-500" />Review approvals and wallet security signals</li>
            </ul>
          </div>
        </div>
      </Card>
    </div>
  );
}

function App() {
  const [launched, setLaunched] = useState(false);
  const [theme, setTheme] = useState<OrbitTheme>(() => {
    if (typeof window === "undefined") return "dark";
    try {
      return window.localStorage.getItem("orbit-theme") === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });
  const [page, setPage] = useState<Page>(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('arcPay') ? 'arc-pay' : 'home');
  const [paymentRequest, setPaymentRequest] = useState<ArcPaymentRequest | null>(null);
  useEffect(() => {
    document.documentElement.dataset.orbitTheme = theme;
    try {
      window.localStorage.setItem("orbit-theme", theme);
    } catch {
      // Storage may be unavailable in protected browsing or constrained environments.
    }
  }, [theme]);
  return launched ? (
    <Dashboard page={page} setPage={setPage} paymentRequest={paymentRequest} setPaymentRequest={setPaymentRequest} />
  ) : (
    <Landing onLaunch={() => { setPage(page === 'arc-pay' ? 'arc-pay' : "home"); setLaunched(true); }} onNavigate={setPage} theme={theme} onThemeChange={setTheme} />
  );
}
export default App;

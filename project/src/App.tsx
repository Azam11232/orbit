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
import { formatEther, formatUnits, isAddress, parseUnits, type Address } from "viem";
import { getPortfolioAnalytics, usePortfolio } from "./hooks/usePortfolio";
import { useApprovals } from "./hooks/useApprovals";
import { useRevokeApproval } from "./hooks/useRevokeApproval";
import { useSendTransaction } from "./hooks/useSendTransaction";
import { useTokenBalance } from "./hooks/useTokenBalance";
import { useSwapQuote } from "./hooks/useSwapQuote";
import { useSwapApproval } from "./hooks/useSwapApproval";
import { useSwapExecution } from "./hooks/useSwapExecution";
import { useBridgeTokens } from "./hooks/useBridgeTokens";
import { useBridgeBalance } from "./hooks/useBridgeBalance";
import { isBridgeReviewable, useBridgeQuote } from "./hooks/useBridgeQuote";
import { useBridgeApproval } from "./hooks/useBridgeApproval";
import { useBridgeExecution } from "./hooks/useBridgeExecution";
import { useBridgeStatus } from "./hooks/useBridgeStatus";
import { useTransactions } from "./hooks/useTransactions";
import { useOrbitSettings } from "./hooks/useOrbitSettings";
import { useWatchlist, type WatchlistItem } from "./hooks/useWatchlist";
import { formatTransactionDate, getTimeAgo, shortAddr, explorerTxUrl, type ChainTransaction, type TxStatus } from "./services/transactions";
import { buildWalletSecurityReport } from "./services/security";
import { ARC_USDC, BASE_ASSETS, BASE_SWAP_ASSETS } from "./data/tokens";
import { ARC_PRIMARY_NETWORK, CCTP_BRIDGE_NETWORKS, ORBIT_NETWORKS, getOrbitNetwork, isCctpRouteSupported } from "./data/networks";
import { usePrices } from "./hooks/usePrices";
import { fetchPortfolioHistoricalCandles, PORTFOLIO_PRICES } from "./services/prices";
import type { BridgeChain } from "./types/bridge";
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
  CreditCard,
  Crosshair,
  ExternalLink,
  Globe2,
  Landmark,
  LayoutDashboard,
  LockKeyhole,
  Menu,
  MoreHorizontal,
  Network,
  Radar,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
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
import { UnifiedBalancePage } from "./components/UnifiedBalancePage";
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
function bridgeExplorerUrl(chainId: number, hash: string) {
  const explorers: Record<number, string> = { 1: "https://etherscan.io/tx/", 10: "https://optimistic.etherscan.io/tx/", 8453: "https://basescan.org/tx/", 42161: "https://arbiscan.io/tx/" };
  return explorers[chainId] ? `${explorers[chainId]}${hash}` : null;
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
        <div
          className="fixed inset-0 z-[3000] flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm"
          onClick={() => setWalletPickerOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-3xl border border-slate-700 bg-slate-950/95 p-4 shadow-[0_30px_80px_rgba(2,6,23,0.6)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">Connect wallet</p>
                <h3 className="mt-2 text-lg font-bold text-white">Choose a wallet</h3>
              </div>
              <button
                type="button"
                onClick={() => setWalletPickerOpen(false)}
                className="rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300 hover:bg-slate-800"
                aria-label="Close wallet picker"
              >
                <X size={14} />
              </button>
            </div>

            {orderedConnectors.length === 0 ? (
              <div className="rounded-2xl border border-slate-700 bg-slate-900/70 p-4 text-sm text-slate-300">
                No browser wallet was detected. Refresh the page after installing an EIP-6963-compatible wallet.
              </div>
            ) : (
              <div className="space-y-2">
                {orderedConnectors.map((candidate) => (
                  <button
                    key={candidate.uid ?? candidate.id}
                    type="button"
                    onClick={() => {
                      setWalletPickerOpen(false);
                      connect({ connector: candidate });
                    }}
                    className="flex w-full items-center justify-between gap-3 rounded-2xl border border-slate-700 bg-slate-900/80 px-3 py-3 text-left transition hover:border-sky-400/40 hover:bg-slate-800"
                  >
                    <div className="flex items-center gap-3">
                      <img
                        src={getWalletBrandIcon(candidate.name, candidate.id, candidate.icon)}
                        alt={candidate.name}
                        className="h-8 w-8 rounded-full object-cover"
                      />
                      <div>
                        <p className="text-sm font-semibold text-white">{candidate.name}</p>
                        <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-slate-500">{candidate.id}</p>
                      </div>
                    </div>
                    {candidate.id === connector?.id && <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.8)]" />}
                  </button>
                ))}
              </div>
            )}
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

function Landing({ onLaunch, onNavigate }: { onLaunch: () => void; onNavigate: (page: Page) => void }) {
  return (
    <Space>
      <header className="relative z-20 mx-auto max-w-7xl px-6 py-7">
        <div className="flex w-full items-center justify-between gap-6">
          <Logo />
          <nav className="hidden items-center justify-center gap-8 text-sm text-slate-300 md:flex md:flex-1">
            <button className="transition hover:text-white" onClick={() => { onLaunch(); onNavigate("security"); }}>
              Security
            </button>
            <button className="transition hover:text-white" onClick={() => { onLaunch(); onNavigate("discover"); }}>
              Discover
            </button>
            <button className="transition hover:text-white" onClick={() => { onLaunch(); onNavigate("about"); }}>
              About
            </button>
          </nav>
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
            <h1 className="mt-7 max-w-xl text-5xl font-extrabold leading-[0.98] tracking-[-.06em] text-white sm:text-6xl lg:text-[5rem]">
              <motion.span
                initial={{ opacity: 0, y: 18, filter: "blur(8px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                transition={{ duration: 0.7, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
                className="block"
              >
                Control Your
              </motion.span>
              <motion.span
                initial={{ opacity: 0, y: 24, filter: "blur(10px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                transition={{ duration: 0.8, delay: 0.38, ease: [0.22, 1, 0.36, 1] }}
                className="hero-gradient-text mt-2 block"
              >
                Onchain Universe.
              </motion.span>
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
              ],
              [
                "MOVE",
                "Bridge and transfer Arc USDC.",
                ArrowLeftRight,
                "violet",
              ],
              [
                "PROTECT",
                "Monitor approvals and wallet security.",
                ShieldCheck,
                "green",
              ],
              [
                "DISCOVER",
                "Explore opportunities across Web3.",
                Compass,
                "amber",
              ],
            ].map(([title, text, Icon, color], i) => (
              <motion.div
                key={title as string}
                initial={{ opacity: 0, y: 26 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.3 }}
                transition={{ duration: 0.6, delay: i * 0.08, ease: [0.22, 1, 0.36, 1] }}
                whileHover={{ y: -6, scale: 1.01 }}
                className="glass group rounded-2xl p-6 transition-all duration-300"
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
              </motion.div>
            ))}
          </div>
        </section>
      </main>
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
            <OrbitBrand variant="light" className="h-20 w-auto max-w-[10rem] drop-shadow-[0_0_22px_rgba(96,165,250,0.45)]" />
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
      ["arc-pay", "Arc Pay", CreditCard],
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
      ["watchlist", "Watchlist", Radar],
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
      className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-slate-700/80 bg-slate-950/95 px-4 py-6 shadow-[0_32px_80px_rgba(2,6,23,0.65)] backdrop-blur-xl transition-all duration-300 lg:relative lg:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}
    >
      <div className="flex items-center justify-between px-3">
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
      <div className="mt-8 flex-1 space-y-6 overflow-y-auto">
        {navGroups.map((g) => (
          <div key={g.title}>
            <Label>{g.title}</Label>
            <div className="mt-2 space-y-1.5">
              {g.items.map(([id, name, Icon]) => (
                <button
                  key={id as string}
                  onClick={() => {
                    setPage(id as Page);
                    setOpen(false);
                  }}
                  className={`group relative flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-xs font-semibold transition-all duration-200 ${page === id ? "bg-sky-500/15 text-white shadow-[0_16px_32px_rgba(14,165,233,0.18)]" : "text-slate-300 hover:bg-slate-800 hover:text-white"}`}
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
      <div className="border-t border-slate-800 pt-4">
        <div className="relative">
          <button
            type="button"
            onClick={() => setWalletMenuOpen((value) => !value)}
            className="flex w-full items-center gap-3 rounded-2xl border border-slate-700 bg-slate-900/80 p-3 text-left shadow-sm transition hover:border-sky-400/40"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-sky-500 via-blue-500 to-violet-500 text-[10px] font-bold text-white">
              {isConnected && address ? address.slice(2, 4).toUpperCase() : "WC"}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-slate-100">{isConnected && address ? shortAddress(address) : "Wallet"}</p>
              <p className="font-mono text-[9px] text-slate-400">
                {isConnected ? activeNetwork?.name ?? `Chain ${chainId}` : 'Awaiting wallet'}
              </p>
            </div>
            <MoreHorizontal size={15} className="text-slate-400" />
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
  const report = buildWalletSecurityReport({
    approvals: approvals.data?.approvals ?? [],
    transactions: txState.transactions ?? [],
    portfolio: usePortfolio(),
    isConnected,
    chainId,
    walletAddress: address,
  });

  const notifications = useMemo(() => {
    const next: Array<{ title: string; detail: string; tone: 'warning' | 'info' | 'danger' }> = [];
    if (!isConnected) {
      return next;
    }
    if (chainId !== arcTestnet.id) {
      next.push({ title: 'Wrong network', detail: 'Your wallet is not on Arc Testnet. Switch to Arc Testnet to keep ORBIT in sync.', tone: 'warning' });
    }
    if ((approvals.data?.approvals ?? []).length > 0) {
      next.push({
        title: `${(approvals.data?.approvals ?? []).length} approval${(approvals.data?.approvals ?? []).length === 1 ? '' : 's'} require attention`,
        detail: 'Review active approvals before signing or moving funds.',
        tone: 'danger',
      });
    }
    const failedTxs = (txState.transactions ?? []).filter((tx) => tx.status === 'failed');
    if (failedTxs.length > 0) {
      next.push({ title: 'Failed transactions', detail: `${failedTxs.length} recent transaction${failedTxs.length === 1 ? '' : 's'} did not complete successfully.`, tone: 'danger' });
    }
    if (report.score < 80) {
      next.push({ title: 'Security recommendation', detail: 'Wallet posture is below the recommended threshold. Review approvals and activity.', tone: 'warning' });
    }
    return next;
  }, [approvals.data?.approvals, chainId, isConnected, report.score, txState.transactions]);

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

function Topbar({ onMenu }: { onMenu: () => void }) {
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
            <span className="font-semibold text-white">Overview</span>
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
            <ChainLogo chainId={displayNetwork.id} className="h-5 w-5 text-sky-300" />
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
                    <ChainLogo chainId={item.id} className="h-5 w-5" />
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

function Chart({ portfolio }: { portfolio: ReturnType<typeof usePortfolio> }) {
  const shouldReduceMotion = useReducedMotion();
  const [candles, setCandles] = useState<Array<{ time: number; open: number; high: number; low: number; close: number }>>([]);
  const [isChartLoading, setIsChartLoading] = useState(true);
  const [chartError, setChartError] = useState<string | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  useEffect(() => {
    let isActive = true;

    const fetchChart = async () => {
      const balances = portfolio.assets
        .filter((asset) => asset.raw > 0n)
        .map((asset) => ({
          symbol: asset.symbol,
          raw: asset.raw,
          decimals: asset.symbol === 'USDC' ? 6 : asset.symbol === 'cbBTC' ? 8 : 18,
        }));

      if (balances.length === 0) {
        if (isActive) {
          setCandles([]);
          setChartError(null);
          setIsChartLoading(false);
          setHoverIndex(null);
        }
        return;
      }

      try {
        const history = await fetchPortfolioHistoricalCandles(balances, 30);
        if (isActive) {
          setCandles(history.slice(-30));
          setChartError(null);
        }
      } catch (error) {
        if (isActive) {
          setCandles([]);
          setChartError(error instanceof Error ? error.message : 'Historical market data is unavailable.');
        }
      } finally {
        if (isActive) {
          setIsChartLoading(false);
        }
      }
    };

    void fetchChart();
    return () => {
      isActive = false;
    };
  }, [portfolio.assets]);

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
      <div className="flex min-h-[180px] items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-900/40 text-center text-sm text-slate-400">
        Historical market data unavailable. Live portfolio value remains available.
      </div>
    );
  }

  if (candles.length === 0) {
    return (
      <div className="flex min-h-[180px] items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-900/40 text-center text-sm text-slate-400">
        {isChartLoading ? 'Loading portfolio history…' : chartError ? 'Historical market data unavailable.' : 'No wallet balance available for a portfolio history chart.'}
      </div>
    );
  }

  const currentPortfolioValue = portfolio.totalValueUsd;
  const chartCandles = candles.slice(-28).map((candle, index, visibleCandles) => {
    if (index !== visibleCandles.length - 1 || !Number.isFinite(currentPortfolioValue) || currentPortfolioValue <= 0) {
      return candle;
    }

    return {
      ...candle,
      high: Math.max(candle.open, currentPortfolioValue),
      low: Math.min(candle.open, currentPortfolioValue),
      close: currentPortfolioValue,
    };
  });
  const values = chartCandles.flatMap((candle) => [candle.high, candle.low]);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = maxValue - minValue || 1;
  const svgWidth = 760;
  const svgHeight = 220;
  const leftPad = 12;
  const rightPad = 12;
  const topPad = 18;
  const bottomPad = 18;
  const usableWidth = svgWidth - leftPad - rightPad;
  const usableHeight = svgHeight - topPad - bottomPad;
  const step = usableWidth / Math.max(chartCandles.length, 1);
  const candleWidth = Math.max(5, Math.min(14, step * 0.68));
  const hoverCandle = hoverIndex === null ? null : chartCandles[hoverIndex];
  const tooltipIndex = hoverIndex ?? 0;

  return (
    <div className="space-y-4 pt-2">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-slate-400">
        <span>Portfolio value</span>
        <span>{`$${(chartCandles[chartCandles.length - 1]?.close ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`}</span>
      </div>

      <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-[radial-gradient(circle_at_top,_rgba(56,189,248,0.12),transparent_28%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(15,23,42,0.82))] p-3">
        <div className="absolute inset-0 opacity-60 [background-image:linear-gradient(to_right,rgba(148,163,184,0.08)_1px,transparent_1px),linear-gradient(to_top,rgba(148,163,184,0.08)_1px,transparent_1px)] [background-size:28px_28px]" />

        <div className="relative z-10">
          {hoverCandle && (
            <div
              className="pointer-events-none absolute z-20 -translate-x-1/2 rounded-xl border border-slate-700 bg-slate-950/95 px-2.5 py-1.5 text-[10px] text-slate-200 shadow-[0_16px_30px_rgba(2,6,23,0.45)]"
              style={{
                left: `${((tooltipIndex + 0.5) / Math.max(chartCandles.length, 1)) * 100}%`,
                top: `${Math.max(18, 18 + (maxValue - hoverCandle.high) / range * usableHeight)}px`,
              }}
            >
              <div className="font-semibold text-white">${hoverCandle.close.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
              <div className="mt-0.5 flex gap-2 text-[9px] text-slate-400">
                <span>O ${hoverCandle.open.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                <span>H ${hoverCandle.high.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                <span>L ${hoverCandle.low.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                <span>C ${hoverCandle.close.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
              </div>
            </div>
          )}

          <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="h-64 w-full" role="img" aria-label="Portfolio value chart">
            {[0, 1, 2, 3].map((line) => {
              const y = topPad + (usableHeight / 3) * line;
              return <line key={line} x1={leftPad} x2={svgWidth - rightPad} y1={y} y2={y} stroke="rgba(148,163,184,0.12)" strokeDasharray="4 10" />;
            })}

            {chartCandles.map((candle, index) => {
              const x = leftPad + step * index + step / 2;
              const isUp = candle.close >= candle.open;
              const bodyTop = topPad + ((maxValue - Math.max(candle.open, candle.close)) / range) * usableHeight;
              const bodyBottom = topPad + ((maxValue - Math.min(candle.open, candle.close)) / range) * usableHeight;
              const wickTop = topPad + ((maxValue - candle.high) / range) * usableHeight;
              const wickBottom = topPad + ((maxValue - candle.low) / range) * usableHeight;
              const bodyHeight = Math.max(1, bodyBottom - bodyTop);
              const color = isUp ? '#34d399' : '#f87171';
              const opacity = shouldReduceMotion ? 1 : 0.75;

              return (
                <g
                  key={`${candle.time}-${index}`}
                  onMouseEnter={() => setHoverIndex(index)}
                  onMouseLeave={() => setHoverIndex(null)}
                  style={{ cursor: 'pointer' }}
                  opacity={opacity}
                >
                  <line
                    x1={x}
                    x2={x}
                    y1={wickTop}
                    y2={wickBottom}
                    stroke={color}
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                  <rect
                    x={x - candleWidth / 2}
                    y={bodyTop}
                    width={candleWidth}
                    height={bodyHeight}
                    rx={2}
                    fill={color}
                    fillOpacity={0.9}
                    stroke="rgba(255,255,255,0.08)"
                    strokeWidth="0.8"
                    style={shouldReduceMotion ? undefined : { filter: `drop-shadow(0 0 8px ${color}33)` }}
                  />
                </g>
              );
            })}
          </svg>
        </div>
      </div>
    </div>
  );
}
function StatCards() {
  const { address, isConnected, chainId } = useAccount();
  const portfolio = usePortfolio();
  const isArcTestnet = chainId === arcTestnet.id;
  const approvalsQuery = useApprovals();
  const transactionsQuery = useTransactions(address, isConnected && chainId === arcTestnet.id && Boolean(address), chainId);
  const approvals = approvalsQuery.data?.approvals ?? [];
  const report = buildWalletSecurityReport({
    approvals,
    transactions: transactionsQuery.transactions ?? [],
    portfolio,
    isConnected,
    chainId,
    walletAddress: address,
  });
  const displayAsset = portfolio.assets.find((asset) => asset.symbol === (isArcTestnet ? "USDC" : "ETH")) ?? portfolio.assets[0];
  const heldAssets = portfolio.assets.filter((asset) => asset.valueUsd !== null && asset.valueUsd > 0 && asset.raw > 0n);
  const scoreColor = report.score >= 85 ? "green" : report.score >= 60 ? "amber" : "red";
  const displayAssetError = !portfolio.isDisconnected && !portfolio.isWrongNetwork && !portfolio.isLoading && displayAsset?.isError && displayAsset.raw === 0n;

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card className="p-5" glow>
        <div className="flex items-center justify-between">
          <Label>Arc USDC Balance</Label>
          <span className="rounded-xl bg-sky-100 p-2 text-sky-700 ring-1 ring-sky-200">
            <Wallet size={16} />
          </span>
        </div>
        {portfolio.isDisconnected ? (
          <>
            <p className="mt-5 text-2xl font-extrabold text-slate-400">
              Connect wallet
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Live Arc ERC-20 balance appears here
            </p>
          </>
        ) : displayAsset?.isLoading ? (
          <>
            <p className="mt-5 h-7 w-32 animate-pulse rounded bg-white/10" />
            <p className="mt-2 h-3 w-24 animate-pulse rounded bg-white/10" />
          </>
        ) : (
          <>
            <p className="mt-5 text-3xl font-extrabold tracking-[-0.06em]">
              {displayAsset?.isError ? "Unavailable" : displayAsset?.formatted ?? "0"}{" "}
              <span className="text-xl text-slate-500">{isArcTestnet ? "USDC" : "ETH"}</span>
            </p>
            <p className="mt-2 text-xs font-semibold text-cyan-300">
              Live balance{" "}
              <span className="font-normal text-slate-500">on Arc Testnet</span>
            </p>
          </>
        )}
        {isArcTestnet ? (
          <p className="mt-2 text-xs text-cyan-300">
            Arc Testnet connected. USDC is read through its ERC-20 interface.
          </p>
        ) : portfolio.isWrongNetwork ? (
          <p className="mt-2 text-xs text-amber-300">
            Wrong network — switch to Arc Testnet
          </p>
        ) : null}
        {displayAssetError && (
          <div className="mt-3 flex items-center justify-between gap-2 rounded-xl border border-rose-400/20 bg-rose-500/5 p-2.5">
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
      </Card>
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <Label>Portfolio mix</Label>
          <span className="rounded-xl bg-violet-300/10 p-2 text-violet-300 ring-1 ring-violet-400/20">
            <Globe2 size={16} />
          </span>
        </div>
        <div className="mt-5 flex items-end justify-between">
          <p className="text-3xl font-extrabold tracking-[-0.06em]">
            {heldAssets.length}{" "}
            <span className="text-sm font-medium text-slate-500">
              active asset{heldAssets.length === 1 ? "" : "s"}
            </span>
          </p>
          <div className="flex -space-x-1">
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
        <div className="mt-5 flex h-1.5 overflow-hidden rounded-full bg-slate-900/80">
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
        <div className="mt-4 space-y-2">
          {heldAssets.length === 0 ? (
            <p className="text-xs text-slate-500">No Arc asset balances are currently detected.</p>
          ) : (
            heldAssets.map((asset) => (
              <div key={asset.symbol} className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/40 px-2.5 py-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <TokenIcon symbol={asset.symbol} color={asset.color} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-100">{asset.name}</p>
                    <p className="text-[10px] uppercase tracking-[0.12em] text-slate-500">{asset.symbol}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-xs font-semibold text-slate-200">{asset.valueUsd !== null ? `$${asset.valueUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : 'N/A'}</p>
                  <p className="text-[10px] text-slate-500">{asset.allocationPercent.toFixed(1)}%</p>
                </div>
              </div>
            ))
          )}
        </div>
      </Card>
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <Label>Security Score</Label>
          <span className="rounded-xl bg-emerald-300/10 p-2 text-emerald-300 ring-1 ring-emerald-400/20">
            <ShieldCheck size={16} />
          </span>
        </div>
        <div className="mt-3 flex items-center gap-5">
          <div
            className="relative flex h-20 w-20 items-center justify-center rounded-full"
            style={{
              background: `conic-gradient(${scoreColor === "green" ? "#34d399" : scoreColor === "amber" ? "#fbbf24" : "#f87171"} 0 ${report.score}%, #1b2933 ${report.score}% 100%)`,
            }}
          >
            <div className="flex h-[68px] w-[68px] flex-col items-center justify-center rounded-full bg-[#101827]">
              <b className="text-xl">{report.score}</b>
              <span className="font-mono text-[8px] text-slate-500">/ 100</span>
            </div>
          </div>
          <div>
            <Pill color={scoreColor}>{scoreColor === "green" ? "Protected" : scoreColor === "amber" ? "Watch" : "High risk"}</Pill>
            <p className="mt-2 text-xs text-slate-500">
              {report.approvalAlerts.length > 0 ? `${report.approvalAlerts.length} alert${report.approvalAlerts.length === 1 ? "" : "s"} detected` : "No material alerts"}
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
function QuickActions({ setPage }: { setPage: (p: Page) => void }) {
  const items = [
    ["Bridge", "Move across networks", Network, "bridge"],
    ["Send", "Transfer to any wallet", Send, "send"],
    ["Receive", "Fund your wallet", ArrowDownLeft, "receive"],
    ["Swap", "Exchange stablecoins", ArrowLeftRight, "swap"],
    ["Arc Pay", "Create a payment request", CreditCard, "arc-pay"],
    ["Unified Balance", "Manage cross-network USDC", CircleDollarSign, "unified-balance"],
  ];
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: "easeOut" }}
    >
      <div className="mb-4 flex items-center justify-between">
        <div>
          <Label>Quick Actions</Label>
          <h2 className="mt-2 text-2xl font-extrabold tracking-[-0.05em] text-white sm:text-3xl">Make a move</h2>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {items.map(([name, desc, Icon, id], index) => (
          <motion.button
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.04, duration: 0.18, ease: "easeOut" }}
            whileHover={{ y: -4, scale: 1.01 }}
            onClick={() => setPage(id as Page)}
            key={name as string}
            className="group rounded-2xl border border-slate-700/80 bg-slate-900/80 p-4 text-left shadow-[0_18px_40px_rgba(2,6,23,0.22)] transition-all duration-200 hover:border-sky-400/40 hover:bg-slate-900"
          >
            <div className="mb-7 flex h-11 w-11 items-center justify-center rounded-2xl border border-sky-400/20 bg-gradient-to-br from-sky-500/12 to-violet-500/10 text-slate-100 shadow-[0_0_18px_rgba(125,211,252,0.12)] transition duration-200 group-hover:-translate-y-0.5 group-hover:border-sky-300/40 group-hover:bg-sky-500/10 group-hover:text-sky-200">
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

function RecentActivity({ setPage }: { setPage: (p: Page) => void }) {
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
  const portfolio = usePortfolio();
  const { address, isConnected, chainId } = useAccount();
  const approvalsQuery = useApprovals();
  const transactionsQuery = useTransactions(address, isConnected && chainId === arcTestnet.id && Boolean(address), chainId);
  const discover = useDiscover();
  const watchlist = useWatchlist();
  const approvalCount = approvalsQuery.data?.approvals.filter((approval) => approval.isUnlimited || approval.risk === "High" || approval.risk === "Medium").length ?? 0;
  const security = buildWalletSecurityReport({
    approvals: approvalsQuery.data?.approvals ?? [],
    transactions: transactionsQuery.transactions ?? [],
    portfolio,
    isConnected,
    chainId,
    walletAddress: address,
  });

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const networkLabel = supportedChains.find((item) => item.id === chainId)?.name ?? "Current network";
  const hasRealPortfolioValue = Number.isFinite(portfolio.totalValueUsd) && portfolio.totalValueUsd > 0;
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
  const lastSync = portfolio.isLoading ? "UPDATING" : portfolio.isError ? "DEGRADED" : "LIVE";

  return (
    <div className="space-y-7">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: 'easeOut' }}
        className="page-shell relative overflow-hidden rounded-[28px] p-5 sm:p-6 lg:p-7"
      >
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(34,211,238,0.12),transparent_18%),radial-gradient(circle_at_bottom_right,_rgba(139,92,246,0.18),transparent_24%),linear-gradient(135deg,rgba(2,6,23,0.96),rgba(15,23,42,0.88),rgba(2,6,23,0.96))]" />
        <div className="absolute inset-0 opacity-80">
          <div className="absolute left-10 top-10 h-40 w-40 rounded-full border border-sky-400/20 bg-sky-400/5 blur-2xl" />
          <div className="absolute right-10 top-20 h-56 w-56 rounded-full border border-violet-400/20 bg-violet-500/10 blur-3xl" />
          <div className="absolute bottom-8 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full border border-cyan-300/10" />
        </div>
        <div className="relative z-10 flex flex-wrap items-end justify-between gap-5">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: 'easeOut' }}
          >
            <motion.p
              className="text-sm font-semibold tracking-[0.18em] text-sky-300 uppercase"
              animate={
                window.matchMedia('(prefers-reduced-motion: reduce)').matches
                  ? { opacity: 1 }
                  : { opacity: [0.78, 1, 0.84], filter: ['drop-shadow(0 0 0 rgba(125,211,252,0))', 'drop-shadow(0 0 12px rgba(125,211,252,0.28))', 'drop-shadow(0 0 0 rgba(125,211,252,0))'] }
              }
              transition={{ duration: 2.8, repeat: Infinity, ease: 'easeInOut' }}
            >
              {greeting}
            </motion.p>
          </motion.div>
          <div className="rounded-full border border-sky-400/20 bg-sky-500/10 px-3 py-1.5 shadow-[0_0_24px_rgba(34,211,238,0.12)]">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-300">
              Last sync <span className="text-sky-200">{lastSync}</span>
            </p>
          </div>
        </div>

        <div className="relative z-10 mt-8 grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
          <div className="rounded-3xl border border-slate-700/80 bg-slate-900/70 p-5 shadow-[0_22px_50px_rgba(2,6,23,0.45)] backdrop-blur-sm">
            <div className="flex items-center justify-between gap-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-slate-300">Portfolio value</p>
              <Pill color="green">{lastSync}</Pill>
            </div>
            <div className="mt-4 flex items-end justify-between gap-4">
              <div>
                <p className="text-4xl font-extrabold tracking-[-0.08em] text-white md:text-5xl">{value}</p>
                <p className="mt-2 text-sm text-slate-300">{valueDetail}</p>
              </div>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-slate-900 p-5 text-white shadow-[0_18px_40px_rgba(15,23,42,0.10)]">
            <div className="flex items-center justify-between">
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-slate-300">Security status</p>
              <span className={`rounded-full border px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.12em] ${security.score >= 85 ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200' : security.score >= 60 ? 'border-amber-400/40 bg-amber-500/10 text-amber-200' : 'border-rose-400/40 bg-rose-500/10 text-rose-200'}`}>
                {security.score >= 85 ? 'Protected' : security.score >= 60 ? 'Watch' : 'High risk'}
              </span>
            </div>
            <div className="mt-4 flex items-end justify-between gap-4">
              <div>
                <p className="text-4xl font-extrabold tracking-[-0.08em]">{security.score}</p>
                <p className="text-xs text-slate-300">/ 100 wallet score</p>
              </div>
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/5 ring-1 ring-white/10">
                <ShieldCheck size={20} className="text-sky-300" />
              </div>
            </div>
          </div>
        </div>
      </motion.div>

      <StatCards />
      <QuickActions setPage={setPage} />

      <div className="grid gap-4 lg:grid-cols-1">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, delay: 0.05 }}
        >
          <Card className="p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <Label>Portfolio snapshot</Label>
                <div className="mt-3 flex items-baseline gap-3">
                  <h2 className="text-2xl font-extrabold tracking-[-0.06em] md:text-3xl">{value}</h2>
                  <span className="text-xs font-medium text-slate-500">
                    {portfolio.isDisconnected
                      ? 'Awaiting wallet'
                      : portfolio.isWrongNetwork
                        ? 'Wallet on unsupported network'
                        : portfolio.hasUnavailablePrices
                          ? 'Live pricing unavailable'
                          : 'Current Base value'}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1 rounded-xl border border-slate-700/80 bg-slate-900/80 p-1.5">
                <span className="rounded-md bg-cyan-300/15 px-2 py-1 font-mono text-[9px] font-bold tracking-[0.16em] text-cyan-200">
                  LIVE
                </span>
              </div>
            </div>
            <div className="mt-6 rounded-2xl border border-slate-800/80 bg-slate-950/30 p-3">
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

      <div className="grid gap-4 md:grid-cols-3">
        {[{ label: 'Security overview', value: security.score, meta: `${approvalCount} alert${approvalCount === 1 ? '' : 's'} need review`, tone: security.score >= 85 ? 'green' : security.score >= 60 ? 'amber' : 'red', badge: security.severity }, { label: 'Opportunity feed', value: discover.data?.opportunities.length ?? 0, meta: discover.isLoading ? 'Refreshing public market data...' : discover.isError ? 'Discover feed unavailable' : 'Public yield opportunities loaded', tone: 'cyan', badge: 'LIVE' }, { label: 'Watchlist', value: watchlist.items.length, meta: watchlist.items.length > 0 ? 'Saved and ready for quick review' : 'No items saved yet', tone: 'purple', badge: 'TRACKED' }].map((tile, index) => (
          <motion.div key={tile.label} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, delay: 0.08 + index * 0.04 }}>
            <Card className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Label>{tile.label}</Label>
                  <div className="mt-3">
                    <p className="text-2xl font-extrabold tracking-[-0.06em]">{tile.value}</p>
                    <p className="mt-1 text-[10px] uppercase tracking-[0.18em] text-slate-500">{tile.label === 'Opportunity feed' ? 'live Arc opportunities' : tile.label === 'Watchlist' ? 'tracked items' : 'wallet score'}</p>
                  </div>
                </div>
                <Pill color={tile.tone as 'green' | 'amber' | 'red' | 'cyan' | 'purple'}>{tile.badge}</Pill>
              </div>
              <p className="mt-4 text-xs text-slate-400">{tile.meta}</p>
            </Card>
          </motion.div>
        ))}
      </div>
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
  const analytics = getPortfolioAnalytics(portfolio.assets, transactionsQuery.transactions, portfolioNetwork);

  const formatUsd = (value: number | null, fallback = 'N/A') =>
    value === null || !Number.isFinite(value) ? fallback : `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const hasLivePortfolioValue = Number.isFinite(portfolio.totalValueUsd) && portfolio.totalValueUsd > 0;
  const value = portfolio.isDisconnected
    ? 'Connect wallet'
    : portfolio.isLoading
      ? 'Loading...'
      : portfolio.isWrongNetwork
        ? 'Switch to Arc Testnet'
        : portfolio.isError
          ? 'Balance unavailable'
        : hasLivePortfolioValue
          ? formatUsd(portfolio.totalValueUsd, '$0.00')
          : portfolio.hasUnavailablePrices
            ? 'Price data unavailable'
            : 'No balances';

  const allocationSegments = analytics.allocation
    .filter((asset: { valueUsd: number; allocationPercent: number }) => asset.valueUsd > 0 && asset.allocationPercent > 0)
    .map((asset: { color: string; allocationPercent: number; valueUsd: number }) => `${asset.color} ${asset.allocationPercent}%`)
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
          Some asset prices are unavailable. Values shown below may be incomplete.
        </Card>
      )}
      {portfolio.isError && !portfolio.isLoading && !portfolio.isDisconnected && !portfolio.isWrongNetwork && (
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
      {analytics.zeroBalance && !portfolio.isDisconnected && !portfolio.isWrongNetwork && !portfolio.isLoading && !portfolio.isError && (
        <Card className="flex items-center gap-3 p-4 text-sm text-slate-300">
          <Wallet size={16} className="text-cyan-300" />
          No supported asset balance is currently detected on {portfolioNetwork} for this wallet.
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <Card className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Label>Total net worth</Label>
              <p className="mt-3 text-4xl font-extrabold tracking-[-0.06em]">{value}</p>
              <p className="mt-2 text-xs text-slate-500">
                USD value <span className="text-cyan-300">live</span>
              </p>
            </div>
            <div
              className="flex h-28 w-28 shrink-0 items-center justify-center rounded-full border border-slate-700/80 shadow-[0_18px_45px_rgba(125,211,252,0.12)]"
              style={{ background: allocationSegments ? `conic-gradient(${allocationSegments})` : '#182236' }}
            >
              <div className="flex h-[74%] w-[74%] items-center justify-center rounded-full bg-[#101725] text-center">
                <span className="font-mono text-[10px] text-slate-500">
                  {portfolio.connectedAssets}
                  <br />
                  ASSETS
                </span>
              </div>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-3 text-xs">
            {[
              ['Largest position', analytics.topAsset ? `${analytics.topAsset.symbol} • ${analytics.topAsset.allocationPercent.toFixed(1)}%` : 'N/A'],
              ['Volatile exposure', `${analytics.volatileExposurePercent.toFixed(1)}%`],
              ['Stablecoin', `${analytics.stablecoinExposurePercent.toFixed(1)}%`],
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
        <Card className="p-5">
          <Label>Allocation</Label>
          <h2 className="mt-2 text-xl font-bold">By asset</h2>
          <div className="mt-6 space-y-4">
            {portfolio.assets.map((a) => (
              <div key={a.symbol}>
                <div className="flex justify-between text-xs">
                  <span className="flex items-center gap-2 font-semibold text-slate-200">
                    <i className="h-2.5 w-2.5 rounded-full" style={{ background: a.color }} />
                    {a.symbol}
                  </span>
                  <span className="font-mono text-slate-400">
                    {a.isLoading ? '...' : a.valueUsd === null ? 'N/A' : `${a.allocationPercent.toFixed(1)}%`}
                  </span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-900/80">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.max(4, a.allocationPercent)}%`, background: a.color }}
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
              ['Current value', formatUsd(portfolio.totalValueUsd, 'N/A')],
              ['Top allocation', analytics.topAsset ? `${analytics.topAsset.allocationPercent.toFixed(1)}%` : '0.0%'],
              ['USDC exposure', `${analytics.stablecoinExposurePercent.toFixed(1)}%`],
              ['Volatile exposure', `${analytics.volatileExposurePercent.toFixed(1)}%`],
            ].map(([label, metric]) => (
              <div key={label} className="data-card rounded-xl p-3">
                <p className="font-mono text-[9px] uppercase tracking-[0.15em] text-slate-500">{label}</p>
                <p className="mt-2 text-xl font-extrabold tracking-[-0.04em] text-white">{metric}</p>
              </div>
            ))}
          </div>
          <div className="mt-5 rounded-2xl border border-amber-300/15 bg-amber-300/[.05] p-4 text-sm text-amber-100">
            <p className="font-semibold">Performance methodology</p>
            <p className="mt-1 text-amber-100/80">{analytics.performance.note}</p>
          </div>
        </Card>
        <Card className="p-5">
          <Label>Risk / exposure</Label>
          <h2 className="mt-2 text-xl font-bold">Portfolio signals</h2>
          <div className="mt-5 space-y-3">
            {analytics.riskSignals.length === 0 ? (
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
          <button className="rounded-lg border border-white/10 p-2 text-slate-400" aria-label="Open asset filters">
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
          <button className="rounded-lg border border-white/10 p-2 text-slate-400" aria-label="Filter holdings">
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
                    {a.isLoading ? (
                      <span className="inline-block h-4 w-16 animate-pulse rounded bg-white/10" />
                    ) : a.isError ? (
                      'Unavailable'
                    ) : a.raw > 0n ? (
                      a.formatted
                    ) : (
                      '0.000000'
                    )}
                  </td>
                  <td className="px-5 py-4 font-mono font-semibold text-slate-300">
                    {a.isLoading ? '...' : a.valueUsd === null ? 'N/A' : formatUsd(a.valueUsd, 'N/A')}
                  </td>
                  <td className="px-5 py-4 font-mono text-slate-500">
                    {a.isLoading ? '...' : a.valueUsd === null ? 'N/A' : `${a.allocationPercent.toFixed(1)}%`}
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
function Security({ setPage }: { setPage: (p: Page) => void }) {
  const { address, isConnected, chainId } = useAccount();
  const portfolio = usePortfolio();
  const approvalsQuery = useApprovals();
  const transactionsQuery = useTransactions(address, isConnected && chainId === arcTestnet.id && Boolean(address), chainId);
  const approvals = approvalsQuery.data?.approvals ?? [];
  const transactions = transactionsQuery.transactions ?? [];
  const report = buildWalletSecurityReport({
    approvals,
    transactions,
    portfolio,
    isConnected,
    chainId,
    walletAddress: address,
  });
  const isLoading = approvalsQuery.isLoading || transactionsQuery.isLoading || portfolio.isLoading;
  const isError = approvalsQuery.isError || transactionsQuery.isError || portfolio.isError;
  const walletStatus = !isConnected ? 'No wallet connected' : chainId !== arcTestnet.id ? 'Unsupported network' : 'Monitoring Arc';
  const scoreColor = report.score >= 85 ? 'green' : report.score >= 60 ? 'amber' : 'red';

  return (
    <div className="space-y-6">
      <PageTitle
        label="Protect / Security Center"
        title="Your wallet, protected."
        action={
          <Button variant="secondary" onClick={() => { void approvalsQuery.refetch(); void transactionsQuery.refetch(); }} disabled={isLoading}>
            <RefreshCw size={15} className={isLoading ? 'animate-spin' : ''} />
            {isLoading ? 'Checking wallet...' : 'Refresh'}
          </Button>
        }
      />

      {!isConnected && (
        <Card className="p-6 text-sm text-slate-400" glow>
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-amber-400/10 p-2 text-amber-300"><Wallet size={18} /></div>
            <div>
              <p className="font-bold text-slate-200">Connect a wallet</p>
              <p className="mt-1">ORBIT security analysis runs on connected Arc Testnet wallet data.</p>
            </div>
          </div>
        </Card>
      )}

      {isConnected && chainId !== arcTestnet.id && (
        <Card className="border border-amber-300/20 bg-amber-300/[.06] p-4 text-sm text-amber-200" glow>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <ShieldCheck size={18} />
              <span>Wallet is connected on an unsupported chain. Arc security monitoring requires Arc Testnet.</span>
            </div>
            <Button variant="secondary" onClick={() => setPage('home')}>
              Switch to Arc Testnet
            </Button>
          </div>
        </Card>
      )}

      {isLoading ? (
        <Card className="p-6" glow>
          <div className="space-y-3">
            {[...Array(5)].map((_, index) => (
              <div key={index} className="h-4 animate-pulse rounded bg-white/10" />
            ))}
          </div>
        </Card>
      ) : isError ? (
        <Card className="p-6 text-sm text-rose-200" glow>
          <p className="font-bold">Wallet security data could not be loaded.</p>
          <p className="mt-2 text-rose-100/80">One or more Arc read sources failed. Try refreshing shortly.</p>
        </Card>
      ) : (
        <>
          <Card className="relative overflow-hidden p-6" glow>
            <div className="absolute right-0 top-0 h-64 w-64 rounded-full bg-cyan-400/[.07] blur-3xl" />
            <div className="relative flex flex-wrap items-center gap-8">
              <div
                className="relative flex h-36 w-36 items-center justify-center rounded-full"
                style={{
                  background: `conic-gradient(${scoreColor === 'green' ? '#34d399' : scoreColor === 'amber' ? '#fbbf24' : '#f87171'} 0 ${report.score}%, #182932 ${report.score}% 100%)`,
                }}
              >
                <div className="flex h-[124px] w-[124px] flex-col items-center justify-center rounded-full bg-[#101725]">
                  <span className="text-4xl font-extrabold">{report.score}</span>
                  <span className="font-mono text-[9px] text-slate-500">OUT OF 100</span>
                </div>
              </div>
              <div>
                <Pill color={scoreColor === 'green' ? 'green' : scoreColor === 'amber' ? 'amber' : 'red'}>{report.severity} risk</Pill>
                <h2 className="mt-3 text-2xl font-bold">{walletStatus}</h2>
                <p className="mt-2 max-w-lg text-sm leading-6 text-slate-400">{report.summary}</p>
                <p className="mt-4 font-mono text-[10px] text-slate-500">WALLET STATUS <span className="text-emerald-300">{walletStatus}</span></p>
              </div>
            </div>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <Card className="p-5">
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-emerald-400/10 p-2 text-emerald-300"><ShieldCheck size={18} /></div>
                <div>
                  <Label>Security factors</Label>
                  <p className="mt-1 text-2xl font-extrabold">{report.factors.length}</p>
                </div>
              </div>
              <div className="mt-5 space-y-3 text-xs">
                {report.factors.length === 0 ? (
                  <p className="text-slate-300">No active wallet security factors were detected in the current Arc data.</p>
                ) : report.factors.map((factor: { label: string; severity: 'neutral' | 'warning' | 'critical'; detail: string }) => (
                  <div key={factor.label} className="rounded-xl border border-white/10 bg-white/[.02] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-bold text-slate-200">{factor.label}</p>
                      <Pill color={factor.severity === 'critical' ? 'red' : factor.severity === 'warning' ? 'amber' : 'green'}>{factor.severity}</Pill>
                    </div>
                    <p className="mt-2 text-slate-400">{factor.detail}</p>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="p-5">
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-amber-400/10 p-2 text-amber-300"><LockKeyhole size={18} /></div>
                <div>
                  <Label>Recommendations</Label>
                  <p className="mt-1 text-2xl font-extrabold">{report.recommendations.length}</p>
                </div>
              </div>
              <div className="mt-5 space-y-3 text-xs">
                {report.recommendations.map((recommendation: string) => (
                  <p key={recommendation} className="flex gap-2 text-slate-300">
                    <span className="text-amber-300">⚠</span>
                    <span>{recommendation}</span>
                  </p>
                ))}
              </div>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <Label>Approval risk</Label>
                  <h2 className="mt-2 text-xl font-bold">Token approvals</h2>
                </div>
                <Pill color={report.approvalAlerts.length > 0 ? 'amber' : 'green'}>{report.approvalAlerts.length} alert{report.approvalAlerts.length === 1 ? '' : 's'}</Pill>
              </div>
              {report.approvalAlerts.length === 0 ? (
                <p className="text-sm text-slate-400">No risky approvals were detected for the configured Arc token set.</p>
              ) : (
                <div className="space-y-3">
                  {report.approvalAlerts.map((approval: { id: string; token: { symbol: string }; spenderAddress: string; isUnlimited: boolean; risk: 'High' | 'Medium' | 'Low' | 'Unknown'; allowanceFormatted: string }) => (
                    <div key={approval.id} className="rounded-xl border border-white/10 bg-white/[.02] p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-bold text-slate-200">{approval.token.symbol}</p>
                          <p className="mt-1 font-mono text-[10px] text-slate-500">{approval.spenderAddress}</p>
                        </div>
                        <Pill color={approval.isUnlimited ? 'red' : approval.risk === 'High' ? 'red' : approval.risk === 'Medium' ? 'amber' : 'green'}>{approval.isUnlimited ? 'Unlimited' : approval.risk}</Pill>
                      </div>
                      <p className="mt-2 text-xs text-slate-400">Allowance: {approval.allowanceFormatted}</p>
                    </div>
                  ))}
                </div>
              )}
              <Button className="mt-4 w-full" variant="secondary" onClick={() => setPage('approvals')}>
                Review approval flow
              </Button>
            </Card>

            <Card className="p-5">
              <div className="mb-4">
                <Label>Transaction signals</Label>
                <h2 className="mt-2 text-xl font-bold">Observable warnings</h2>
              </div>
              <div className="space-y-3 text-sm">
                <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[.02] p-3">
                  <span className="text-slate-400">Unknown contract interactions</span>
                  <strong className="text-slate-200">{report.unknownContractInteractions}</strong>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[.02] p-3">
                  <span className="text-slate-400">Large outgoing transfers</span>
                  <strong className="text-slate-200">{report.largeOutgoingTransfers}</strong>
                </div>
                <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[.02] p-3">
                  <span className="text-slate-400">Failed transactions</span>
                  <strong className="text-slate-200">{report.failedTransactions}</strong>
                </div>
              </div>
              <p className="mt-4 text-xs leading-5 text-slate-500">
                These are risk signals based on observable Arc activity, not definitive fraud claims.
              </p>
            </Card>
          </div>

          <Card className="p-5" glow>
            <div className="mb-4">
              <Label>Tracked asset safety</Label>
              <h2 className="mt-2 text-xl font-bold">ORBIT-known contracts</h2>
            </div>
            <div className="space-y-3">
              {report.trackedContractStatus.map((asset: { symbol: string; address: string; status: 'Verified in ORBIT' | 'Unknown / not verified by ORBIT' }) => (
                <div key={asset.symbol} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[.02] p-3 text-sm">
                  <div>
                    <p className="font-bold text-slate-200">{asset.symbol}</p>
                    <p className="font-mono text-[10px] text-slate-500">{asset.address}</p>
                  </div>
                  <Pill color={asset.status === 'Verified in ORBIT' ? 'green' : 'amber'}>{asset.status}</Pill>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
function Approvals() {
  const { isConnected, chainId } = useAccount();
  const approvalsQuery = useApprovals();
  const { revoke, activeApprovalId, status, transactionHash, error } = useRevokeApproval();
  const approvals = approvalsQuery.data?.approvals ?? [];
  return (
    <div className="space-y-6">
      <PageTitle
        label="Protect / Approvals & Revoke"
        title="Take back control."
        action={
          <Button variant="secondary" onClick={approvalsQuery.refetch} disabled={approvalsQuery.isFetching || status === "pending"}>
            <RefreshCw size={15} />
            {approvalsQuery.isFetching ? "Scanning..." : "Refresh scan"}
          </Button>
        }
      />
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[.06] p-5">
          <div>
            <Label>Approval scanner</Label>
            <p className="mt-2 text-sm text-slate-400">
              {approvals.length} detected approvals for configured Arc tokens.
            </p>
          </div>
          <Pill color="amber">{approvals.filter((approval) => approval.risk === "High" || approval.risk === "Medium").length} ACTIONS NEEDED</Pill>
        </div>
        {status === "success" && transactionHash && (
          <p className="border-b border-white/[.06] px-5 py-3 text-xs text-emerald-300">
            Approval revoked. <a href={explorerTxUrl(transactionHash)} target="_blank" rel="noopener noreferrer" className="underline">View on ArcScan</a>
          </p>
        )}
        {status === "error" && error && <p className="border-b border-white/[.06] px-5 py-3 text-xs text-rose-300">{error.message}</p>}
        {!isConnected ? (
          <p className="p-12 text-center text-xs text-slate-500">Connect your wallet to scan token approvals.</p>
        ) : chainId !== arcTestnet.id ? (
          <p className="p-12 text-center text-xs text-amber-300">Switch to Arc Testnet to view Arc approvals.</p>
        ) : approvalsQuery.isLoading ? (
          <p className="p-12 text-center text-xs text-slate-500">Loading Arc approval availability...</p>
        ) : approvalsQuery.isError ? (
          <p className="p-12 text-center text-xs text-rose-300">Unable to scan approvals. Try refreshing.</p>
        ) : approvals.length === 0 ? (
          <p className="p-12 text-center text-xs text-slate-400">Arc approval scanning is not available yet.</p>
        ) : <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-left">
            <thead className="border-b border-white/[.06] font-mono text-[9px] uppercase tracking-widest text-slate-600">
              <tr>
                <th className="px-5 py-3">Token</th>
                <th className="px-5 py-3">Spender</th>
                <th className="px-5 py-3">Allowance</th>
                <th className="px-5 py-3">Risk</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[.05]">
              {approvals.map((a) => (
                <tr
                  key={a.id}
                  className="text-xs hover:bg-white/[.025]"
                >
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-2">
                      <TokenIcon symbol={a.token.symbol} color={a.token.color} />
                      <div><b>{a.token.name}</b><p className="font-mono text-[9px] text-slate-600">{a.token.symbol}</p><p className="font-mono text-[8px] text-slate-700">{a.token.address}</p></div>
                    </div>
                  </td>
                  <td className="px-5 py-4 font-semibold">
                    <p className="font-mono text-[10px] text-slate-300">{shortAddr(a.spenderAddress)}</p>
                    <p className="font-mono text-[9px] text-slate-600">{a.spenderAddress}</p>
                  </td>
                  <td className="px-5 py-4 font-mono text-slate-400">
                    {a.isUnlimited ? "Unlimited" : a.allowanceFormatted}
                    <p className="mt-1 text-[9px] text-slate-600">{a.status}</p>
                  </td>
                  <td className="px-5 py-4">
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
                  </td>
                  <td className="px-5 py-4 text-right">
                    <Button variant="secondary" onClick={() => void revoke(a)} disabled={status === "pending"}>
                      {status === "pending" && activeApprovalId === a.id ? "Revoking..." : "Revoke"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>}
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
  const { address, isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
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
  const [bridgeSlippage, setBridgeSlippage] = useState(0.005);
  const [showBridgeConfirmation, setShowBridgeConfirmation] = useState(false);
  const bridgeFromChain: BridgeChain = { id: bridgeFromChainId, name: getOrbitNetwork(bridgeFromChainId)?.name ?? "Unknown" };
  const bridgeToChain: BridgeChain = { id: bridgeToChainId, name: getOrbitNetwork(bridgeToChainId)?.name ?? "Unknown" };
  const bridgeSameNetwork = bridgeFromChainId === bridgeToChainId; // Prevent same-network bridging
  const bridgeTokensQuery = useBridgeTokens();
  const bridgeFromToken = bridgeTokensQuery.tokens.find((token) => token.chainId === bridgeFromChainId && token.symbol === bridgeSymbol);
  const bridgeToToken = bridgeTokensQuery.tokens.find((token) => token.chainId === bridgeToChainId && token.symbol === bridgeSymbol);
  let rawBridgeAmount: bigint | null = null;
  try { rawBridgeAmount = bridgeAmount && bridgeFromToken ? parseUnits(bridgeAmount, bridgeFromToken.decimals) : null; } catch { rawBridgeAmount = null; }
  const bridgeBalance = useBridgeBalance(bridgeFromToken, address, isConnected);
  const bridgeAmountError = bridgeAmount && rawBridgeAmount === null ? "Invalid amount" : rawBridgeAmount !== null && rawBridgeAmount <= 0n ? "Amount must be greater than zero" : rawBridgeAmount !== null && !bridgeBalance.isWrongNetwork && BridgeBalanceHasEnough(bridgeBalance.raw, rawBridgeAmount) === false ? "Insufficient balance" : null;
  const bridgeQuoteState = useBridgeQuote(bridgeFromChain, bridgeToChain, bridgeFromToken, bridgeToToken, isBridge && rawBridgeAmount && rawBridgeAmount > 0n && !bridgeAmountError && !bridgeSameNetwork ? rawBridgeAmount : null, address, bridgeSlippage);
  const bridgeApproval = useBridgeApproval(bridgeFromToken, address, bridgeQuoteState.quote?.transactionTarget ?? null, rawBridgeAmount);
  const bridgeExecution = useBridgeExecution(bridgeQuoteState.quote);
  const resetBridgeExecution = bridgeExecution.reset;
  const bridgeStatus = useBridgeStatus(bridgeQuoteState.quote, bridgeExecution.sourceHash?.toString(), bridgeExecution.status === "source-confirmed" || bridgeExecution.status === "bridging" || Boolean(bridgeExecution.sourceHash));
  const bridgeWrongNetwork = isConnected && chainId !== bridgeFromChainId;
  const queryClient = useQueryClient();
  const resetBridgeRouteState = useCallback(() => {
    resetBridgeExecution();
    queryClient.removeQueries({ queryKey: ['bridge-status'] });
    queryClient.removeQueries({ queryKey: ['bridge-quote'] });
    setShowBridgeConfirmation(false);
  }, [queryClient, resetBridgeExecution]);
  useEffect(() => {
    resetBridgeRouteState();
  }, [bridgeFromChainId, bridgeToChainId, resetBridgeRouteState]);
  const bridgeReady = isBridgeReviewable({ isConnected, wrongNetwork: bridgeWrongNetwork, sameNetwork: bridgeSameNetwork, hasSourceToken: Boolean(bridgeFromToken), hasDestinationToken: Boolean(bridgeToToken), hasQuote: Boolean(bridgeQuoteState.quote), hasAmount: Boolean(rawBridgeAmount), hasAmountError: Boolean(bridgeAmountError), approvalRequired: bridgeApproval.required, simulationSucceeded: bridgeQuoteState.simulationSucceeded, isSimulating: bridgeQuoteState.isSimulating, quoteFresh: Date.now() - (bridgeQuoteState.quote?.quotedAt ?? 0) <= 30_000 });
  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <PageTitle
        label={`${isSwap ? "Move / Swap" : "Move / Bridge"}`}
        title={
          isSwap
            ? "Move with confidence."
            : "Cross-chain, simplified."
        }
      />
      <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
        <Card className="p-5" glow>
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
              {swapApproval.isApprovalRequired ? <Button className="mt-4 w-full" onClick={() => void swapApproval.approve()} disabled={swapApproval.approvalStatus === "confirmation" || swapApproval.approvalStatus === "pending" || !quote} icon>{swapApproval.approvalStatus === "pending" ? "Approval pending..." : swapApproval.approvalStatus === "confirmation" ? "Confirm in wallet" : "Approve exact amount"}</Button> : <Button className="mt-4 w-full" onClick={() => setShowSwapConfirmation(true)} icon disabled={!swapReady || swapExecution.status === "pending" || swapExecution.status === "confirmation"}>{swapExecution.status === "pending" ? "Swap pending..." : swapExecution.status === "confirmed" ? "Swap confirmed" : "Review swap"}</Button>}
              {swapApproval.approvalStatus === "failed" && swapApproval.approvalError && <p className="mt-3 text-xs text-rose-300">Approval failed: {swapApproval.approvalError.message}</p>}
              {swapApproval.approvalHash && <p className="mt-2 text-xs text-cyan-300">Approval transaction submitted.</p>}
              {swapExecution.transactionHash && <p className="mt-2 text-xs text-emerald-300">Swap hash: <a className="underline" href={explorerTxUrl(swapExecution.transactionHash)} target="_blank" rel="noopener noreferrer">{shortAddr(swapExecution.transactionHash)}</a></p>}
              {showSwapConfirmation && quote && <div className="mt-4 rounded-xl border border-cyan-300/20 bg-cyan-300/[.05] p-4"><Label>Final confirmation</Label><div className="mt-3 space-y-2 text-xs"><div className="flex justify-between"><span className="text-slate-500">Input</span><span>{formatUnits(quote.amountIn, fromAsset.decimals)} {fromAsset.symbol}</span></div><div className="flex justify-between"><span className="text-slate-500">Expected output</span><span>{formatUnits(quote.amountOut, toAsset.decimals)} {toAsset.symbol}</span></div><div className="flex justify-between"><span className="text-slate-500">Minimum received</span><span>{minimumReceived !== null ? `${formatUnits(minimumReceived, toAsset.decimals)} ${toAsset.symbol}` : "Not available from quote"}</span></div><div className="flex justify-between"><span className="text-slate-500">Network</span><span>Base Mainnet</span></div><div className="flex justify-between"><span className="text-slate-500">Deadline</span><span>5 minutes</span></div></div><p className="mt-3 text-[10px] leading-4 text-amber-300">Review the route and transaction in your wallet before signing. Digital assets can lose value.</p><div className="mt-4 flex gap-2"><Button variant="secondary" className="flex-1" onClick={() => setShowSwapConfirmation(false)}>Cancel</Button><Button className="flex-1" onClick={() => { setShowSwapConfirmation(false); void swapExecution.execute(quote, address as Address, slippageBps); }} disabled={!swapReady} icon>Confirm swap</Button></div></div>}
            </>
          ) : isBridge ? (
            <>
              <div className="mb-5">
                <Label>Bridge assets</Label>
                <h2 className="mt-2 text-xl font-bold">Select route</h2>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-white/10 bg-white/[.04] p-4">
                  <Label>From</Label>
                  <div className="mt-3 flex items-center gap-2 text-xs text-slate-400"><ChainLogo chainId={bridgeFromChainId} className="h-5 w-5" />{bridgeFromChain.name}</div>
                  <BridgeNetworkPicker label="Bridge source network" value={bridgeFromChainId} options={allBridgeNetworks.filter((chain) => chain.id !== bridgeToChainId)} onChange={setBridgeFromChainId} disabled={bridgeExecution.status === "source-pending"} />
                </div>
                <div className="rounded-xl border border-white/10 bg-white/[.04] p-4">
                  <Label>To</Label>
                  <div className="mt-3 flex items-center gap-2 text-xs text-slate-400"><ChainLogo chainId={bridgeToChainId} className="h-5 w-5" />{bridgeToChain.name}</div>
                  <BridgeNetworkPicker label="Bridge destination network" value={bridgeToChainId} options={allBridgeNetworks.filter((chain) => chain.id !== bridgeFromChainId)} onChange={setBridgeToChainId} disabled={bridgeExecution.status === "source-pending"} />
                </div>
              </div>
              {bridgeSameNetwork && <div className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/[.06] p-4 text-xs text-amber-200"><span>Source and destination networks must be different.</span></div>}
              {bridgeWrongNetwork && <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-amber-300/20 bg-amber-300/[.06] p-4 text-xs text-amber-200"><span>Wrong network. Switch to {bridgeFromChain.name} before bridging.</span><Button variant="secondary" onClick={() => switchChain({ chainId: bridgeFromChainId })}>Switch to {bridgeFromChain.name}</Button></div>}
              <div className="mt-4 rounded-xl border border-white/10 bg-white/[.03] p-4">
                <Label>Asset</Label>
                <div className="mt-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="rounded-lg border border-white/10 bg-[#101725] p-2 font-bold text-white">USDC</div>
                  </div>
                  <span className="font-mono text-xs text-slate-500">
                    Balance {bridgeBalance.isDisconnected ? 'Connect wallet' : bridgeBalance.isLoading ? "..." : bridgeFromToken && bridgeBalance.raw !== null ? formatUnits(bridgeBalance.raw, bridgeFromToken.decimals) : "Unavailable"}
                  </span>
                </div>
                <div className="mt-4 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[.04] px-4"><input value={bridgeAmount} onChange={(event) => setBridgeAmount(event.target.value)} inputMode="decimal" placeholder="0.00" className="min-w-0 flex-1 bg-transparent py-3 text-lg font-bold text-white outline-none placeholder:text-slate-600" /><button type="button" onClick={() => bridgeFromToken && bridgeBalance.raw !== null && setBridgeAmount(formatUnits(bridgeBalance.raw, bridgeFromToken.decimals))} className="font-mono text-[10px] font-bold text-cyan-300">MAX</button><span className="font-mono text-xs text-slate-500">{bridgeSymbol}</span></div>
              </div>
              <div className="mt-4 space-y-2 rounded-xl bg-white/[.03] p-4 text-xs"><div className="flex justify-between"><span className="text-slate-500">Route</span><span className="font-semibold">{bridgeSameNetwork ? "Same network" : !isCctpRouteSupported(bridgeFromChainId, bridgeToChainId) ? "Unavailable" : "CCTP V2"}</span></div><div className="flex justify-between"><span className="text-slate-500">Expected output</span><span className="font-mono text-slate-300">{bridgeQuoteState.quote?.toAmount !== null && bridgeQuoteState.quote?.toAmount !== undefined && bridgeToToken ? `${formatUnits(bridgeQuoteState.quote.toAmount, bridgeToToken.decimals)} ${bridgeToToken.symbol}` : "Unavailable"}</span></div><div className="flex justify-between"><span className="text-slate-500">Minimum received</span><span className="font-mono text-slate-300">{bridgeQuoteState.quote?.toAmountMin !== null && bridgeQuoteState.quote?.toAmountMin !== undefined && bridgeToToken ? `${formatUnits(bridgeQuoteState.quote.toAmountMin, bridgeToToken.decimals)} ${bridgeToToken.symbol}` : "Unavailable"}</span></div><div className="flex justify-between"><span className="text-slate-500">Estimated completion</span><span className="font-mono text-slate-300">Depends on Circle attestation</span></div><div className="flex justify-between"><span className="text-slate-500">Bridge fee</span><span className="font-mono text-slate-300">{bridgeQuoteState.quote?.feeAmount !== null && bridgeQuoteState.quote?.feeAmount !== undefined && bridgeFromToken ? formatUnits(bridgeQuoteState.quote.feeAmount, bridgeFromToken.decimals) : "Fee determined by Circle/CCTP"}</span></div><div className="flex items-center justify-between"><span className="text-slate-500">Slippage</span><select value={bridgeSlippage} onChange={(event) => setBridgeSlippage(Number(event.target.value))} className="rounded border border-white/10 bg-[#101725] px-2 py-1 font-mono text-[10px] text-slate-300"><option value={0.001}>0.1%</option><option value={0.005}>0.5%</option><option value={0.01}>1%</option></select></div></div>
              <p className={`mt-4 text-xs ${bridgeSameNetwork ? "text-amber-300" : bridgeAmountError || bridgeQuoteState.isError || bridgeQuoteState.simulationError || bridgeExecution.status === "failed" ? "text-rose-300" : bridgeExecution.status === "completed" ? "text-emerald-300" : "text-slate-500"}`}>{bridgeSameNetwork ? "Select different source and destination networks." : bridgeAmountError ?? bridgeExecution.error?.message ?? (bridgeWrongNetwork ? `Switch to ${bridgeFromChain.name} before bridging.` : bridgeTokensQuery.isError ? "CCTP token catalog unavailable." : bridgeQuoteState.isError ? `CCTP route unavailable: ${bridgeQuoteState.error instanceof Error ? bridgeQuoteState.error.message : "provider unavailable"}` : bridgeApproval.required ? "Approve canonical USDC for Circle CCTP." : bridgeQuoteState.isSimulating ? "Checking the CCTP burn on the source chain..." : bridgeQuoteState.simulationError ? `CCTP burn simulation failed: ${bridgeQuoteState.simulationError.message}` : bridgeStatus.status?.status === "DONE" ? "Source message attested. Destination mint requires confirmation." : bridgeQuoteState.quote ? "Ready to review Circle CCTP transfer." : "Enter a USDC amount to request a CCTP quote.")}</p>
              {bridgeApproval.required ? <Button className="mt-4 w-full" onClick={() => void bridgeApproval.approve()} disabled={bridgeApproval.status === "confirmation" || bridgeApproval.status === "pending"} icon>{bridgeApproval.status === "pending" ? "Approval pending..." : bridgeApproval.status === "confirmation" ? "Confirm in wallet" : "Approve exact amount"}</Button> : bridgeStatus.status?.status === "DONE" && bridgeStatus.status.message && bridgeStatus.status.attestation ? <Button className="mt-4 w-full" onClick={() => void bridgeExecution.complete(bridgeStatus.status?.message, bridgeStatus.status?.attestation)} disabled={bridgeExecution.status === "bridging" || bridgeExecution.status === "completed"} icon>{bridgeExecution.status === "bridging" ? "Mint pending..." : bridgeExecution.status === "completed" ? "Bridge completed" : "Mint on destination"}</Button> : <Button className="mt-4 w-full" onClick={() => setShowBridgeConfirmation(true)} disabled={!bridgeReady || bridgeExecution.status === "source-pending"} icon>{bridgeExecution.status === "source-pending" ? "Bridge pending..." : bridgeExecution.status === "source-confirmed" ? "Waiting for attestation..." : "Review bridge"}</Button>}
              {bridgeExecution.sourceHash && bridgeExplorerUrl(bridgeFromChainId, bridgeExecution.sourceHash) && <p className="mt-2 text-xs text-cyan-300">Source transaction: <a href={bridgeExplorerUrl(bridgeFromChainId, bridgeExecution.sourceHash) ?? undefined} target="_blank" rel="noopener noreferrer" className="underline">{shortAddr(bridgeExecution.sourceHash)}</a></p>}
              {bridgeStatus.status?.receiving?.txHash && bridgeExplorerUrl(bridgeStatus.status.receiving.chainId ?? bridgeToChainId, bridgeStatus.status.receiving.txHash) && <p className="mt-2 text-xs text-emerald-300">Destination transaction: <a href={bridgeExplorerUrl(bridgeStatus.status.receiving.chainId ?? bridgeToChainId, bridgeStatus.status.receiving.txHash) ?? undefined} target="_blank" rel="noopener noreferrer" className="underline">{shortAddr(bridgeStatus.status.receiving.txHash)}</a></p>}
              {showBridgeConfirmation && bridgeQuoteState.quote && <div className="mt-4 rounded-xl border border-cyan-300/20 bg-cyan-300/[.05] p-4"><Label>Final confirmation</Label><div className="mt-3 space-y-2 text-xs"><div className="flex justify-between"><span className="text-slate-500">Route</span><span>{bridgeFromChain.name} → {bridgeToChain.name}</span></div><div className="flex justify-between"><span className="text-slate-500">Input</span><span>{bridgeAmount} {bridgeSymbol}</span></div><div className="flex justify-between"><span className="text-slate-500">Minimum received</span><span>{bridgeQuoteState.quote.toAmountMin !== null && bridgeToToken ? `${formatUnits(bridgeQuoteState.quote.toAmountMin, bridgeToToken.decimals)} ${bridgeToToken.symbol}` : "Unavailable"}</span></div><div className="flex justify-between"><span className="text-slate-500">Protocol</span><span>Circle CCTP V2</span></div></div><p className="mt-3 text-[10px] leading-4 text-amber-300">Review the canonical USDC burn transaction in your wallet before signing. The destination mint requires a Circle attestation.</p><div className="mt-4 flex gap-2"><Button variant="secondary" className="flex-1" onClick={() => setShowBridgeConfirmation(false)}>Cancel</Button><Button className="flex-1" onClick={() => { setShowBridgeConfirmation(false); void bridgeExecution.execute(); }} disabled={!bridgeReady} icon>Confirm bridge</Button></div></div>}
            </>
          ) : null}
        </Card>
        <Card className="h-fit p-5">
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
        </Card>
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
    <div className="rounded-xl border border-white/10 bg-white/[.035] p-4">
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
        <div className="flex items-center gap-2">
          <TokenIcon symbol={token} color={color} />
          {onAmountChange ? <input value={value} onChange={(event) => onAmountChange(event.target.value)} disabled={disabled} inputMode="decimal" placeholder="0.00" className="w-28 bg-transparent text-right text-2xl font-bold text-white outline-none placeholder:text-slate-600" /> : <span className="text-2xl font-bold text-slate-400">{value || "0.00"}</span>}
        </div>
      </div>
      {onMax && <button type="button" onClick={onMax} disabled={disabled} className="mt-3 text-[10px] font-bold text-cyan-300 hover:text-cyan-200">MAX</button>}
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
  const { send, status, transactionHash, error, reset, gasCost } = useSendTransaction();
  const isArcTestnet = chainId === arcTestnet.id;
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const asset = ARC_USDC;
  const balance = useTokenBalance(asset, address, Boolean(isConnected && isArcTestnet));
  const isPaymentRequestSend = Boolean(paymentRequest);
  const balanceRaw = balance.raw;
  const isBusy = status === "preparing" || status === "confirmation" || status === "pending";
  const setInput = (setter: (value: string) => void, value: string) => {
    setter(value);
    setFormError(null);
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
  const handleSend = async () => {
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
    await send({ asset, recipient: recipient as Address, amount: rawAmount });
  };
  const stateMessage = status === "preparing" ? "Preparing transaction and estimating Arc gas..." : status === "confirmation" ? "Confirm this transaction in your wallet." : status === "pending" ? "Transaction pending on Arc Testnet..." : status === "confirmed" ? "Transaction confirmed." : status === "rejected" ? "Transaction rejected in wallet." : status === "failed" ? error?.message ?? "Transaction failed." : null;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageTitle label="Move / Send" title="Send assets securely." />
      {!isConnected ? <Card className="flex flex-col items-center justify-center p-16 text-center" glow><div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-cyan-300/10 text-cyan-300"><Wallet size={28} /></div><h2 className="mt-6 text-2xl font-bold">Connect your wallet</h2><p className="mt-3 max-w-md text-sm leading-6 text-slate-500">Connect a wallet to send Arc Testnet USDC.</p><WalletButton className="mt-7" /></Card> : !isArcTestnet ? <Card className="flex flex-col items-center justify-center p-16 text-center" glow><ShieldCheck size={28} className="text-amber-300" /><h2 className="mt-6 text-2xl font-bold">Switch to Arc Testnet</h2><p className="mt-3 max-w-md text-sm leading-6 text-slate-500">Send uses the official Arc Testnet USDC contract and your connected wallet.</p><Button className="mt-6" variant="secondary" onClick={() => switchChain({ chainId: arcTestnet.id })}>Switch to Arc Testnet</Button></Card> : <Card className="p-5" glow><div className="mb-5"><Label>Send / Arc Testnet</Label><h2 className="mt-2 text-xl font-bold">{isPaymentRequestSend ? "Pay Arc USDC request" : "Transfer from your wallet"}</h2></div><div className="space-y-4"><div><span className="mb-2 block text-xs font-semibold text-slate-400">Asset</span><div className="rounded-xl border border-white/10 bg-white/[.04] px-4 py-3 text-sm font-bold text-white">USDC <span className="ml-2 font-normal text-slate-500">Official Arc ERC-20</span></div></div><label className="block"><span className="mb-2 block text-xs font-semibold text-slate-400">Recipient address</span><input value={recipient} onChange={(event) => setInput(setRecipient, event.target.value)} disabled={isBusy || isPaymentRequestSend} placeholder="0x..." className="w-full rounded-xl border border-white/10 bg-white/[.04] px-4 py-3 font-mono text-sm text-white outline-none placeholder:text-slate-600 focus:border-cyan-300/40" /></label><label className="block"><span className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-400"><span>Amount</span><button type="button" onClick={handleMax} disabled={isBusy || isPaymentRequestSend || balance.isLoading || balance.isError} className="font-mono text-[10px] text-cyan-300 hover:text-cyan-200">MAX</button></span><div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[.04] px-4"><input value={amount} onChange={(event) => setInput(setAmount, event.target.value)} disabled={isBusy || isPaymentRequestSend} inputMode="decimal" placeholder="0.00" className="min-w-0 flex-1 bg-transparent py-3 text-lg font-bold text-white outline-none placeholder:text-slate-600" /><span className="font-mono text-xs text-slate-500">USDC</span></div><span className="mt-2 block font-mono text-[10px] text-slate-500">Available {balance.isLoading ? "..." : balance.isError ? "Unavailable" : `${formatUnits(balanceRaw, asset.decimals)} USDC`}</span></label>{isPaymentRequestSend && <div className="rounded-xl border border-cyan-300/20 bg-cyan-300/[.05] p-4 text-xs text-slate-300">This request is for {paymentRequest?.amount} USDC to {paymentRequest?.recipient}. Review the details in your wallet before confirming.</div>}<div className="rounded-xl border border-cyan-300/20 bg-cyan-300/[.05] p-4 text-xs"><p className="font-semibold text-cyan-100">Transaction preview</p><div className="mt-3 space-y-2 text-slate-300"><div className="flex justify-between gap-3"><span className="text-slate-500">Network</span><span>Arc Testnet</span></div><div className="flex justify-between gap-3"><span className="text-slate-500">Asset / amount</span><span>{amount || "0"} USDC</span></div><div className="flex justify-between gap-3"><span className="text-slate-500">Recipient</span><span className="max-w-[65%] truncate font-mono">{recipient || "Not provided"}</span></div><div className="flex justify-between gap-3"><span className="text-slate-500">Estimated gas</span><span>{gasCost !== null ? `${formatUnits(gasCost, 18)} native USDC` : "Estimated during preparation"}</span></div></div><p className="mt-3 text-[10px] leading-4 text-amber-200">Arc gas is paid in native USDC. ERC-20 balance alone does not guarantee enough gas.</p></div></div>{(formError || stateMessage) && <p className={`mt-4 text-xs ${status === "confirmed" ? "text-emerald-300" : status === "failed" || status === "rejected" || formError ? "text-rose-300" : "text-cyan-300"}`}>{formError || stateMessage}</p>}{transactionHash && <p className="mt-3 text-xs text-emerald-300">Hash: <a href={explorerTxUrl(transactionHash, arcTestnet.id)} target="_blank" rel="noopener noreferrer" className="underline">{shortAddr(transactionHash)}</a></p>}<Button onClick={() => void handleSend()} disabled={isBusy || balance.isLoading || balance.isError} className="mt-5 w-full" icon>{status === "confirmation" ? "Confirm in wallet" : status === "pending" ? "Sending..." : status === "confirmed" ? "Send another" : "Review and send"}</Button></Card>}
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
    <div ref={pickerRef} className="relative mt-3">
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
        className="flex w-full items-center justify-between gap-3 rounded-xl border border-white/10 bg-[#101725] px-3 py-2.5 text-left text-sm font-bold text-white outline-none transition hover:border-cyan-300/30 focus-visible:border-cyan-300/50 focus-visible:ring-2 focus-visible:ring-cyan-300/20 disabled:cursor-not-allowed disabled:opacity-60"
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
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs transition ${isSelected ? 'bg-cyan-300/10 text-white' : 'text-slate-300 hover:bg-white/[.06] hover:text-white'}`}
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
  return <div className="mx-auto max-w-3xl space-y-6"><PageTitle label="Move / Receive" title="Fund your wallet." /><div className="flex items-center gap-2 text-xs font-semibold text-slate-400"><ChainLogo chainId={arcTestnet.id} className="h-5 w-5" />Arc Testnet / USDC</div>{!isConnected || !address ? <Card className="flex flex-col items-center justify-center p-16 text-center" glow><div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-cyan-300/10 text-cyan-300"><Wallet size={28} /></div><h2 className="mt-6 text-2xl font-bold">Connect your wallet</h2><p className="mt-3 max-w-md text-sm leading-6 text-slate-500">Connect a wallet to display your Arc Testnet receiving address.</p><WalletButton className="mt-7" /></Card> : <Card className="flex flex-col items-center p-8 text-center" glow><div className="flex items-center gap-2 text-sm font-bold text-slate-200"><ChainLogo chainId={arcTestnet.id} className="h-6 w-6" />Arc Testnet</div><Label>Your Arc Testnet wallet address</Label><div className="mt-6 rounded-2xl bg-white p-4"><QRCodeSVG value={address} size={188} bgColor="#ffffff" fgColor="#070a11" includeMargin /></div><p className="mt-6 max-w-lg break-all font-mono text-xs leading-6 text-slate-300">{address}</p><p className="mt-3 max-w-md text-sm leading-6 text-slate-500">Send real USDC to this connected wallet address on Arc Testnet. The QR and copied value are the wallet address itself.</p>{!isArcTestnet && <Button variant="secondary" onClick={() => switchChain({ chainId: arcTestnet.id })} className="mt-6">Switch to Arc Testnet</Button>}<Button variant="secondary" onClick={() => void copyAddress()} className="mt-6"><Copy size={15} />{copied ? "Copied" : "Copy address"}</Button>{copyError && <p className="mt-3 text-xs text-rose-300">{copyError}</p>}</Card>}</div>;
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
  const { settings, setDensity, setRefreshMode, hasStorage } = useOrbitSettings();
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
    <div className="space-y-6">
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

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5" glow>
          <Label>Wallet & network</Label>
          <div className="mt-4 space-y-4 text-sm">
            <div className="rounded-xl border border-white/10 bg-white/[.02] p-3">
              <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Wallet</p>
              <p className="mt-2 font-semibold text-slate-200">{isConnected && address ? shortAddr(address) : 'Wallet disconnected'}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[.02] p-3">
              <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Current network</p>
              <div className="mt-2 flex items-center justify-between gap-3">
                <p className="font-semibold text-slate-200">{walletStateLabel}</p>
                <Pill color={networkStatusPill === 'green' ? 'green' : 'amber'}>{!isConnected ? 'Disconnected' : !activeChain ? 'Unsupported' : 'Connected'}</Pill>
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[.02] p-3">
              <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Wallet security</p>
              <p className="mt-2 text-slate-300">ORBIT reads wallet state, network status, and transaction history with your explicit wallet approval. ORBIT does not store private keys or seed phrases.</p>
            </div>
          </div>
        </Card>

        <Card className="p-5" glow>
          <Label>Supported networks</Label>
          <div className="mt-4 space-y-4 text-sm">
            <div className="rounded-xl border border-white/10 bg-white/[.02] p-3">
              <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Wallet chains</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {supportedChains.map((chain) => (
                  <Pill key={chain.id} color="green">{chain.name}</Pill>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[.02] p-3">
              <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Arc core network</p>
              <p className="mt-2 text-slate-200">Arc Testnet · Chain ID 5042002 · Native gas USDC</p>
              <p className="mt-1 break-all text-xs text-slate-500">RPC https://rpc.testnet.arc.network · Explorer https://testnet.arcscan.app</p>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5" glow>
          <Label>Explorer & refresh</Label>
          <div className="mt-4 space-y-4">
            <div className="rounded-xl border border-white/10 bg-white/[.02] p-3">
              <p className="mb-2 text-xs font-semibold text-slate-400">Explorer</p>
              <div className="flex gap-2">
                <button
                  onClick={() => undefined}
                  className="flex-1 rounded-xl border border-cyan-300/30 bg-cyan-300/10 px-3 py-2 text-sm font-bold text-cyan-200"
                >
                  ArcScan
                </button>
              </div>
              <p className="mt-2 text-[11px] text-slate-500">Arc activity and transaction links use the official ArcScan explorer.</p>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/[.02] p-3">
              <p className="mb-2 text-xs font-semibold text-slate-400">Refresh behavior</p>
              <div className="grid gap-2 sm:grid-cols-3">
                {(['manual', 'balanced', 'live'] as const).map((mode) => (
                  <button
                    key={mode}
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
          <div className="mt-4 space-y-4">
            <div className="rounded-xl border border-white/10 bg-white/[.02] p-3">
              <p className="mb-2 text-xs font-semibold text-slate-400">Information density</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  onClick={() => setDensity('comfortable')}
                  className={`rounded-xl border px-3 py-2 text-sm font-bold ${settings.density === 'comfortable' ? 'border-cyan-300/30 bg-cyan-300/10 text-cyan-200' : 'border-white/10 bg-[#101725] text-slate-300'}`}
                >
                  Comfortable
                </button>
                <button
                  onClick={() => setDensity('compact')}
                  className={`rounded-xl border px-3 py-2 text-sm font-bold ${settings.density === 'compact' ? 'border-cyan-300/30 bg-cyan-300/10 text-cyan-200' : 'border-white/10 bg-[#101725] text-slate-300'}`}
                >
                  Compact
                </button>
              </div>
              <p className="mt-2 text-[11px] text-slate-500">Density affects ORBIT’s supported layout spacing and content density while keeping the same underlying data and actions.</p>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/[.02] p-3">
              <p className="mb-2 text-xs font-semibold text-slate-400">Persistence</p>
              <p className="text-sm text-slate-300">Explorer, refresh behavior, and density are persisted in browser local storage only.</p>
              <p className="mt-2 text-[11px] text-slate-500">{hasStorage ? 'Browser storage is available for persisted preferences.' : 'Local storage is unavailable in this environment, so these settings are temporary.'}</p>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5" glow>
          <Label>Watchlist data</Label>
          <div className="mt-4 space-y-4">
            <div className="rounded-xl border border-white/10 bg-white/[.02] p-3">
              <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Storage mode</p>
              <p className="mt-2 text-slate-200">Local browser persistence only</p>
              <p className="mt-1 text-xs text-slate-500">Watchlist entries are stored locally in this browser. They are not wallet-owned, blockchain data, or synced to another device unless a separate sync system is added.</p>
            </div>
            <div className="rounded-xl border border-rose-300/20 bg-rose-300/[.05] p-3">
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
          <div className="mt-4 space-y-3 text-sm">
            <div className="rounded-xl border border-white/10 bg-white/[.02] p-3">
              <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Network in use</p>
              <p className="mt-2 text-slate-200">{walletStateLabel}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[.02] p-3">
              <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Supported chain</p>
              <p className="mt-2 text-slate-200">Arc Testnet</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[.02] p-3">
              <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">App version</p>
              <p className="mt-2 text-slate-200">{__APP_VERSION__}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[.02] p-3">
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
  const { transactions, isLoading, isError, refetch, isFetching } =
    useTransactions(address, isConnected && isSupportedNetwork, chainId);
  const [selectedCategory, setSelectedCategory] = useState<
    'all' | 'Send' | 'Receive' | 'Swap' | 'Approval' | 'Contract Interaction' | 'Other'
  >('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedTxHash, setSelectedTxHash] = useState<string | null>(null);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [showAllTransactions, setShowAllTransactions] = useState(false);

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
                <div className="grid gap-0 xl:grid-cols-[minmax(0,1.7fr)_minmax(280px,0.72fr)]">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[980px] table-fixed text-left xl:min-w-0">
                      <thead className="border-b border-white/[.06] font-mono text-[9px] uppercase tracking-widest text-slate-600">
                        <tr>
                          <th className="w-[10%] px-3 py-3 text-left">Type</th>
                          <th className="w-[18%] min-w-[150px] px-3 py-3 text-left">Tx Hash</th>
                          <th className="w-[12%] min-w-[110px] px-3 py-3 text-left">From</th>
                          <th className="w-[12%] min-w-[110px] px-3 py-3 text-left">To</th>
                          <th className="w-[12%] min-w-[110px] px-3 py-3 text-left">Value</th>
                          <th className="w-[12%] px-3 py-3 text-left">Status</th>
                          <th className="w-[14%] min-w-[130px] px-3 py-3 text-left">Time</th>
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
                                <span className="block text-[11px]">{getTimeAgo(tx.timestamp)}</span>
                                {tx.timestamp ? <span className="mt-1 block text-[10px] text-slate-500">{formatTransactionDate(tx.timestamp)}</span> : null}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {selectedTx && (
                    <aside className="border-t border-white/[.06] bg-slate-950/60 p-5 xl:border-l xl:border-t-0">
                      <Label>Transaction details</Label>
                      <div className="mt-4 space-y-4">
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-semibold text-slate-200">{selectedTx.category}</span>
                          <span className={`inline-flex rounded-full border px-2 py-1 text-[9px] font-semibold uppercase tracking-[.12em] ${getStatusClasses(selectedTx.status)}`}>
                            {getStatusLabel(selectedTx.status)}
                          </span>
                        </div>

                        <div className="rounded-xl border border-white/10 bg-white/[.02] p-3">
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

                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="rounded-xl border border-white/10 bg-white/[.02] p-3">
                            <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Block</p>
                            <p className="mt-2 text-sm font-semibold text-slate-200">
                              {selectedTx.blockNumber !== null ? `#${selectedTx.blockNumber}` : selectedTx.status === 'pending' ? 'Pending' : 'Not mined'}
                            </p>
                          </div>
                          <div className="rounded-xl border border-white/10 bg-white/[.02] p-3">
                            <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Time</p>
                            <p className="mt-2 text-sm font-semibold text-slate-200">
                              {selectedTx.timestamp ? formatTransactionDate(selectedTx.timestamp) : 'Pending'}
                            </p>
                          </div>
                        </div>

                        <div className="space-y-3 text-sm">
                          <div>
                            <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">From</p>
                            <div className="mt-1 flex items-center gap-2">
                              <span title={selectedTx.from} className="min-w-0 flex-1 truncate font-mono text-slate-300">{shortAddr(selectedTx.from)}</span>
                              <button type="button" onClick={() => void handleCopyText(selectedTx.from)} className="text-slate-400 hover:text-slate-200" title="Copy address"><Copy size={12} /></button>
                            </div>
                          </div>
                          <div>
                            <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">To</p>
                            <div className="mt-1 flex items-center gap-2">
                              <span title={selectedTx.to} className="min-w-0 flex-1 truncate font-mono text-slate-300">{shortAddr(selectedTx.to)}</span>
                              <button type="button" onClick={() => void handleCopyText(selectedTx.to)} className="text-slate-400 hover:text-slate-200" title="Copy address"><Copy size={12} /></button>
                            </div>
                          </div>
                          <div>
                            <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-500">Value</p>
                            <p className="mt-1 font-mono text-slate-300">{formatTxValue(selectedTx.value, selectedTx.nativeSymbol)}</p>
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
      <div className="relative z-10 flex min-h-screen">
        <Sidebar page={page} setPage={setPage} open={open} setOpen={setOpen} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar onMenu={() => setOpen(true)} />
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
                {page === "security" && <Security setPage={setPage} />}
                {page === "approvals" && <Approvals />}
                {page === "discover" && <Discover />}
                {page === "watchlist" && <WatchlistPage />}
                {page === "activity" && <ActivityPage />}
                {page === "send" && <SendPage paymentRequest={paymentRequest} />}
                {page === "receive" && <ReceivePage />}
                {page === "arc-pay" && <ArcPayPage onPay={(request) => { setPaymentRequest(request); setPage("send"); }} />}
                {page === "bridge" && <ActionPage type="bridge" />}
                {page === "swap" && <ArcSwapPage />}
                {page === "unified-balance" && <UnifiedBalancePage />}
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
            <h2 className="mt-3 text-3xl font-extrabold tracking-[-0.05em] text-white">A focused command center for your Arc wallet.</h2>
            <p className="mt-4 text-base leading-7 text-slate-300">
              ORBIT brings together the essentials of a modern onchain portfolio: portfolio value, wallet activity, approvals, discovery, and security signals in one place. It is designed to help you understand what is happening across your wallet without adding unnecessary noise or fake data.
            </p>
            <p className="mt-4 text-base leading-7 text-slate-300">
              The app reads live public data and wallet state where available and keeps the experience focused on real Arc activity, real risk awareness, and practical controls without requiring a separate backend or paid data layer.
            </p>
          </div>
          <div className="rounded-3xl border border-slate-700 bg-slate-950/60 p-5 shadow-[0_18px_40px_rgba(2,6,23,0.28)]">
            <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-slate-400">What it helps with</p>
            <ul className="mt-4 space-y-3 text-sm text-slate-300">
              <li className="flex gap-3"><span className="mt-1 h-2 w-2 rounded-full bg-cyan-500" />Track portfolio and wallet state on Arc Testnet</li>
              <li className="flex gap-3"><span className="mt-1 h-2 w-2 rounded-full bg-cyan-500" />Review recent onchain activity and failed transactions</li>
              <li className="flex gap-3"><span className="mt-1 h-2 w-2 rounded-full bg-cyan-500" />Audit approval risk and wallet security posture</li>
              <li className="flex gap-3"><span className="mt-1 h-2 w-2 rounded-full bg-cyan-500" />Explore opportunities and keep key assets on a watchlist</li>
            </ul>
          </div>
        </div>
      </Card>
    </div>
  );
}

function App() {
  const [launched, setLaunched] = useState(false);
  const [page, setPage] = useState<Page>(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('arcPay') ? 'arc-pay' : 'home');
  const [paymentRequest, setPaymentRequest] = useState<ArcPaymentRequest | null>(null);
  return launched ? (
    <Dashboard page={page} setPage={setPage} paymentRequest={paymentRequest} setPaymentRequest={setPaymentRequest} />
  ) : (
    <Landing onLaunch={() => { setPage(page === 'arc-pay' ? 'arc-pay' : "home"); setLaunched(true); }} onNavigate={setPage} />
  );
}
export default App;

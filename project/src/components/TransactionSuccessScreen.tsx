import { useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, ArrowUpRight, CheckCircle2, Clock3, Copy, ExternalLink, Fuel, Network, UserRound } from 'lucide-react';
import { Button, Card, ChainLogo, TokenIcon } from './ui';

interface SuccessToken {
  symbol: string;
  color: string;
}

interface SuccessNetwork {
  id: number;
  name: string;
}

export interface TransactionSuccessScreenProps {
  title: string;
  description: string;
  amountLabel: string;
  amount: string;
  token: SuccessToken;
  secondaryAmount?: { label: string; amount: string; token: SuccessToken };
  networks: { label: string; network: SuccessNetwork }[];
  recipient?: string;
  transactionHash: string;
  explorerUrl: string;
  gasFee: string;
  completedAt: number;
  primaryLabel: string;
  secondaryLabel: string;
  onBack: () => void;
  onPrimary: () => void;
}

function shortHash(value: string) {
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}

function shortAddress(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function TransactionSuccessScreen({
  title,
  description,
  amountLabel,
  amount,
  token,
  secondaryAmount,
  networks,
  recipient,
  transactionHash,
  explorerUrl,
  gasFee,
  completedAt,
  primaryLabel,
  secondaryLabel,
  onBack,
  onPrimary,
}: TransactionSuccessScreenProps) {
  const [copied, setCopied] = useState(false);
  const formattedTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(completedAt);

  const copyHash = async () => {
    try {
      await navigator.clipboard.writeText(transactionHash);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl pb-8">
      <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-semibold text-slate-400 transition hover:bg-white/[.04] hover:text-white">
        <ArrowLeft size={15} />
        Back
      </button>
      <Card className="overflow-hidden p-5 sm:p-8 lg:p-10" glow>
        <div className="relative overflow-hidden rounded-[1.25rem] border border-sky-300/10 bg-[radial-gradient(circle_at_50%_18%,rgba(14,165,233,0.12),transparent_34%),rgba(2,8,23,0.35)] px-3 py-10 text-center sm:px-8 sm:py-12">
          <div className="pointer-events-none absolute inset-0" aria-hidden="true">
            <span className="absolute left-[22%] top-[18%] h-1.5 w-1.5 rotate-45 rounded-sm bg-sky-300 shadow-[0_0_12px_rgba(125,211,252,0.85)]" />
            <span className="absolute left-[31%] top-[8%] h-2 w-2 rotate-45 rounded-sm bg-blue-500 shadow-[0_0_14px_rgba(59,130,246,0.7)]" />
            <span className="absolute right-[29%] top-[12%] h-1.5 w-1.5 rotate-45 rounded-sm bg-cyan-300 shadow-[0_0_12px_rgba(103,232,249,0.8)]" />
            <span className="absolute right-[20%] top-[27%] h-2 w-2 rotate-45 rounded-sm bg-emerald-300 shadow-[0_0_14px_rgba(110,231,183,0.75)]" />
            <span className="absolute left-[27%] top-[34%] h-1 w-1 rounded-full bg-cyan-200" />
            <span className="absolute right-[27%] top-[38%] h-1 w-1 rounded-full bg-sky-300" />
          </div>
          <motion.div
            initial={{ opacity: 0, scale: 0.82 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            className="relative mx-auto flex h-28 w-28 items-center justify-center rounded-full border border-emerald-300/50 bg-emerald-400/10 text-emerald-300 shadow-[0_0_0_12px_rgba(52,211,153,0.05),0_0_70px_rgba(45,212,191,0.35)] sm:h-32 sm:w-32"
          >
            <CheckCircle2 size={70} strokeWidth={1.6} className="drop-shadow-[0_0_16px_rgba(52,211,153,0.7)] sm:h-20 sm:w-20" />
          </motion.div>
          <p className="relative mt-7 font-mono text-[10px] uppercase tracking-[0.24em] text-emerald-300/80">Transaction confirmed</p>
          <h1 className="relative mt-3 text-3xl font-extrabold tracking-[-0.04em] text-white sm:text-4xl">{title}</h1>
          <p className="relative mx-auto mt-3 max-w-xl text-sm leading-6 text-slate-400">{description}</p>
        </div>

        <div className="mt-5 rounded-2xl border border-slate-700/80 bg-slate-900/55 p-4 sm:p-5">
          <SuccessDetail icon={<TokenIcon symbol={token.symbol} color={token.color} />} label={amountLabel}>
            <span className="text-sm font-bold text-white">{amount} {token.symbol}</span>
          </SuccessDetail>
          {secondaryAmount && (
            <SuccessDetail icon={<TokenIcon symbol={secondaryAmount.token.symbol} color={secondaryAmount.token.color} />} label={secondaryAmount.label}>
              <span className="text-sm font-bold text-white">{secondaryAmount.amount} {secondaryAmount.token.symbol}</span>
            </SuccessDetail>
          )}
          {recipient && (
            <SuccessDetail icon={<UserRound size={16} />} label="Recipient">
              <span className="font-mono text-xs text-slate-200">{shortAddress(recipient)}</span>
            </SuccessDetail>
          )}
          {networks.map(({ label, network }) => (
            <SuccessDetail key={`${label}-${network.id}`} icon={<Network size={16} />} label={label}>
              <span className="flex items-center gap-2 text-xs font-semibold text-slate-200"><ChainLogo chainId={network.id} className="h-5 w-5" />{network.name}</span>
            </SuccessDetail>
          ))}
          <SuccessDetail icon={<ExternalLink size={16} />} label="Transaction Hash">
            <span className="flex min-w-0 items-center gap-2">
              <a href={explorerUrl} target="_blank" rel="noopener noreferrer" className="truncate font-mono text-xs text-slate-200 underline decoration-slate-600 underline-offset-4 hover:text-cyan-200">{shortHash(transactionHash)}</a>
              <button type="button" onClick={() => void copyHash()} title="Copy transaction hash" className="shrink-0 rounded-md p-1 text-slate-500 transition hover:bg-white/[.06] hover:text-white"><Copy size={14} /></button>
              {copied && <span className="shrink-0 text-[10px] text-emerald-300">Copied</span>}
            </span>
          </SuccessDetail>
          <SuccessDetail icon={<CheckCircle2 size={16} />} label="Status">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-200"><CheckCircle2 size={13} />Confirmed</span>
          </SuccessDetail>
          <SuccessDetail icon={<Clock3 size={16} />} label="Time">
            <span className="text-xs text-slate-200">{formattedTime}</span>
          </SuccessDetail>
          <SuccessDetail icon={<Fuel size={16} />} label="Estimated Gas Fee">
            <span className="text-xs text-slate-200">{gasFee}</span>
          </SuccessDetail>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <Button variant="secondary" className="min-h-12 w-full" onClick={() => window.open(explorerUrl, '_blank', 'noopener,noreferrer')}>
            <ExternalLink size={16} />
            View on ArcScan
          </Button>
          <Button className="min-h-12 w-full" onClick={onPrimary}>
            <ArrowUpRight size={16} />
            {primaryLabel}
          </Button>
        </div>
        <Button variant="ghost" className="mt-3 min-h-11 w-full" onClick={onPrimary}>{secondaryLabel}</Button>
        <p className="mt-6 text-center text-xs text-slate-500">Thank you for using ORBIT <span className="text-slate-400">&#9829;</span></p>
      </Card>
    </div>
  );
}

function SuccessDetail({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-3 border-b border-white/[.07] py-3.5 last:border-b-0 sm:gap-4">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-800/80 text-slate-300">{icon}</span>
      <span className="shrink-0 text-xs text-slate-400 sm:w-36">{label}</span>
      <span className="ml-auto min-w-0 text-right">{children}</span>
    </div>
  );
}

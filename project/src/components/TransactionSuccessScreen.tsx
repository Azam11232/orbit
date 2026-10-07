import { useEffect, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ExternalLink, X } from 'lucide-react';
import { Button } from './ui';

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
  description: ReactNode;
  amountLabel: string;
  amount: string;
  token: SuccessToken;
  secondaryAmount?: { label: string; amount: string; token: SuccessToken };
  networks: { label: string; network: SuccessNetwork }[];
  recipient?: string;
  transactionLabel?: string;
  transactionHash: string;
  successChimeKey?: string;
  explorerUrl: string | null;
  additionalTransactions?: { label: string; transactionHash?: string; explorerUrl?: string | null }[];
  gasFee?: string;
  completedAt: number;
  primaryLabel: string;
  onBack: () => void;
  onPrimary: () => void;
}

function shortHash(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function shortAddress(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

const playedSuccessChimes = new Set<string>();

function playSuccessChime(key: string) {
  if (playedSuccessChimes.has(key)) return;
  playedSuccessChimes.add(key);

  if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') return;

  let context: AudioContext;
  try {
    context = new window.AudioContext();
  } catch {
    return;
  }

  const closeContext = () => { void context.close().catch(() => {}); };
  const play = () => {
    try {
      if (context.state !== 'running') {
        closeContext();
        return;
      }

      const startedAt = context.currentTime;
      const output = context.createGain();
      output.gain.setValueAtTime(0.0001, startedAt);
      output.gain.exponentialRampToValueAtTime(0.08, startedAt + 0.025);
      output.gain.exponentialRampToValueAtTime(0.0001, startedAt + 0.68);
      output.connect(context.destination);

      [523.25, 659.25, 783.99].forEach((frequency, index) => {
        const noteStart = startedAt + index * 0.085;
        const noteEnd = noteStart + 0.42;
        const oscillator = context.createOscillator();
        const voice = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, noteStart);
        voice.gain.setValueAtTime(0.0001, noteStart);
        voice.gain.exponentialRampToValueAtTime(index === 2 ? 0.16 : 0.12, noteStart + 0.025);
        voice.gain.exponentialRampToValueAtTime(0.0001, noteEnd);
        oscillator.connect(voice);
        voice.connect(output);
        oscillator.start(noteStart);
        oscillator.stop(noteEnd + 0.02);
      });

      window.setTimeout(closeContext, 900);
    } catch {
      closeContext();
    }
  };

  if (context.state === 'running') {
    play();
    return;
  }

  const closeTimeout = window.setTimeout(closeContext, 1200);
  try {
    void context.resume().then(() => {
      window.clearTimeout(closeTimeout);
      play();
    }).catch(() => {
      window.clearTimeout(closeTimeout);
      closeContext();
    });
  } catch {
    window.clearTimeout(closeTimeout);
    closeContext();
  }
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
  transactionLabel = 'Transaction',
  transactionHash,
  successChimeKey,
  explorerUrl,
  additionalTransactions = [],
  gasFee,
  completedAt,
  primaryLabel,
  onBack,
  onPrimary,
}: TransactionSuccessScreenProps) {
  const shouldReduceMotion = useReducedMotion();
  useEffect(() => {
    if (successChimeKey) playSuccessChime(successChimeKey);
  }, [successChimeKey]);
  const formattedTime = new Date(completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const transactions = [{ label: transactionLabel, transactionHash, explorerUrl }, ...additionalTransactions];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: shouldReduceMotion ? 0 : 0.2 }}
      className="orbit-success-overlay fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-sm sm:p-6"
    >
      <motion.div
        initial={{ opacity: 0, y: shouldReduceMotion ? 0 : 12, scale: shouldReduceMotion ? 1 : 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: shouldReduceMotion ? 0 : 8, scale: shouldReduceMotion ? 1 : 0.98 }}
        transition={{ duration: shouldReduceMotion ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
        className="orbit-success-dialog w-full max-w-xl overflow-hidden rounded-2xl border border-emerald-300/25 bg-slate-900/95 p-5 shadow-2xl shadow-emerald-500/10 sm:p-6"
      >
        <div className="orbit-success-header flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <motion.div
              initial={{ scale: shouldReduceMotion ? 1 : 0.75, opacity: shouldReduceMotion ? 1 : 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: shouldReduceMotion ? 0 : 0.08, duration: shouldReduceMotion ? 0 : 0.25 }}
              className="orbit-success-mark relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-emerald-300/40 bg-emerald-300/10 text-emerald-300 shadow-[0_0_28px_rgba(52,211,153,0.22)]"
            >
              <span className="absolute inset-1 rounded-full border border-emerald-300/20" />
              <svg viewBox="0 0 24 24" className="relative h-6 w-6" fill="none" aria-hidden="true">
                <motion.path d="m5 12 4 4L19 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: shouldReduceMotion ? 1 : 0, opacity: shouldReduceMotion ? 1 : 0 }} animate={{ pathLength: 1, opacity: 1 }} transition={{ delay: shouldReduceMotion ? 0 : 0.16, duration: shouldReduceMotion ? 0 : 0.32 }} />
              </svg>
            </motion.div>
            <div>
              <p className="orbit-success-eyebrow text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-300">Transaction confirmed</p>
              <h3 className="orbit-success-title mt-1 text-2xl font-bold tracking-tight text-white">{title}</h3>
            </div>
          </div>
          <button type="button" onClick={onBack} className="rounded-full border border-white/10 bg-white/5 p-2 text-slate-300 transition hover:bg-white/10 hover:text-white" aria-label="Close transaction success popup"><X size={17} /></button>
        </div>
        <p className="orbit-success-description mt-4 text-sm leading-6 text-slate-400">{description}</p>
        <div className="orbit-success-summary-grid mt-5 grid gap-2 sm:grid-cols-3">
          <SuccessSummary label={amountLabel} value={`${amount} ${token.symbol}`} />
          {secondaryAmount && <SuccessSummary label={secondaryAmount.label} value={`${secondaryAmount.amount} ${secondaryAmount.token.symbol}`} />}
          {recipient && <SuccessSummary label="Recipient" value={shortAddress(recipient)} />}
          {networks.map(({ label, network }) => <SuccessSummary key={`${label}-${network.id}`} label={label} value={network.name} />)}
        </div>
        <div className="orbit-success-details mt-4 divide-y divide-white/10 rounded-xl border border-white/10 bg-slate-950/35">
          {transactions.map(({ label, transactionHash: hash, explorerUrl: txExplorerUrl }) => (
            <div key={label} className="orbit-success-row flex items-center justify-between gap-4 px-4 py-3 text-xs">
              <span className="text-slate-500">{label}</span>
              {hash ? (
                txExplorerUrl ? <a href={txExplorerUrl} target="_blank" rel="noopener noreferrer" className="orbit-success-link inline-flex min-w-0 items-center gap-1 font-mono text-cyan-300 underline">{shortHash(hash)} <ExternalLink size={12} /></a> : <span className="truncate font-mono text-slate-300">{shortHash(hash)}</span>
              ) : <span className="font-mono text-slate-500">Pending</span>}
            </div>
          ))}
          <div className="orbit-success-row orbit-success-status flex items-center justify-between gap-4 px-4 py-3 text-xs">
            <span className="text-slate-500">Status</span>
            <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />Confirmed</span>
          </div>
          <div className="orbit-success-row flex items-center justify-between gap-4 px-4 py-3 text-xs">
            <span className="text-slate-500">Time</span>
            <span className="font-mono text-slate-300">{formattedTime}</span>
          </div>
          {gasFee && <div className="orbit-success-row flex items-center justify-between gap-4 px-4 py-3 text-xs"><span className="text-slate-500">Estimated gas fee</span><span className="font-mono text-slate-300">{gasFee}</span></div>}
        </div>
        <div className="orbit-success-action mt-5 flex justify-end">
          <Button onClick={onPrimary} className="px-5">{primaryLabel}</Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function SuccessSummary({ label, value }: { label: string; value: string }) {
  return (
    <div className="orbit-success-summary min-w-0 rounded-xl border border-white/10 bg-white/[.035] p-3">
      <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold text-white">{value}</p>
    </div>
  );
}

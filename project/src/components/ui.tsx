import { motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { ArrowUpRight, ChevronDown } from 'lucide-react';
import { getOrbitNetwork } from '../data/networks';
import usdcLogo from '../assets/tokens/usdc.svg';
import eurcLogo from '../assets/tokens/eurc.svg';

export function Card({ children, className = '', glow = false }: { children: ReactNode; className?: string; glow?: boolean }) {
  return (
    <motion.div
      whileHover={{ y: -1 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className={`premium-card ${glow ? 'panel-glow' : ''} ${className}`}
    >
      {children}
    </motion.div>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <p className="orbit-label font-mono text-[10px] uppercase tracking-[0.24em] text-slate-400">{children}</p>;
}

export function Pill({ children, color = 'cyan' }: { children: ReactNode; color?: 'cyan' | 'green' | 'amber' | 'red' | 'purple' }) {
  const c = {
    cyan: 'border-sky-400/30 bg-sky-500/10 text-sky-200',
    green: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200',
    amber: 'border-amber-400/30 bg-amber-500/10 text-amber-200',
    red: 'border-rose-400/30 bg-rose-500/10 text-rose-200',
    purple: 'border-violet-400/30 bg-violet-500/10 text-violet-200',
  }[color];

  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-semibold tracking-[0.12em] uppercase ${c}`}>{children}</span>;
}

export function Button({ children, variant = 'primary', onClick, className = '', icon = false, disabled = false }: { children: ReactNode; variant?: 'primary' | 'secondary' | 'ghost'; onClick?: () => void; className?: string; icon?: boolean; disabled?: boolean }) {
  return (
    <motion.button
      whileTap={{ scale: 0.985 }}
      onClick={onClick}
      disabled={disabled}
      className={`orbit-button group inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-60 ${variant === 'primary'
        ? 'orbit-button--primary'
        : variant === 'secondary'
          ? 'orbit-button--secondary'
          : 'orbit-button--ghost'} ${className}`}
    >
      {children}
      {icon && <ArrowUpRight size={15} className="transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />}
    </motion.button>
  );
}

export function SelectPill({ children }: { children: ReactNode }) {
  return (
    <button className="premium-select flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2 text-xs font-medium text-slate-200 shadow-[0_12px_20px_rgba(2,6,23,0.28)] transition hover:border-sky-400/40 hover:bg-slate-800">
      <span className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
      {children}
      <ChevronDown size={13} className="text-slate-400" />
    </button>
  );
}

export function AssetLogo({ symbol, color, className = '' }: { symbol: string; color: string; className?: string }) {
  const common = `block ${className}`;

  if (symbol === 'ETH') {
    return (
      <svg viewBox="0 0 32 32" className={common} aria-hidden="true">
        <path d="M16 3.5 8.5 15.8l7.5 4.4 7.5-4.4L16 3.5Zm0 9.6 4.7 2.6-4.7 2.7-4.7-2.7 4.7-2.6ZM8.5 17.9l7.5 11.6 7.5-11.6-7.5 4.4-7.5-4.4Z" fill="currentColor" />
      </svg>
    );
  }

  if (symbol === 'USDC') {
    return <img src={usdcLogo} className={`${common} object-contain`} alt="" aria-hidden="true" />;
  }

  if (symbol === 'EURC') {
    return <img src={eurcLogo} className={`${common} object-contain`} alt="" aria-hidden="true" />;
  }

  if (symbol === 'cbBTC') {
    return (
      <svg viewBox="0 0 32 32" className={common} aria-hidden="true">
        <circle cx="16" cy="16" r="14" fill="#F7931A" />
        <path d="M18.3 9.8h-3.1a4.5 4.5 0 0 0-4.4 4.4v4.2a4.5 4.5 0 0 0 4.4 4.4h3.1a4.5 4.5 0 0 0 4.4-4.4v-4.2a4.5 4.5 0 0 0-4.4-4.4Zm-1.6 2.7h1.2c1.7 0 2.7 1.1 2.7 2.5 0 1.3-.9 2.3-2.5 2.3h-1.5v-4.8Zm-2.3 1.6h1.9v1.7h-1.9v-1.7Zm0 3.1h2.1v1.6h-2.1v-1.6Zm4.5-4.7h1.5v1.4h-1.5v-1.4Zm-3.1 7.5h2.5v1.4h-2.5v-1.4Z" fill="white" />
        <path d="M11.7 14.1h8.3" stroke="rgba(255,255,255,0.75)" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <span className={`inline-flex items-center justify-center text-[10px] font-extrabold tracking-[0.12em] ${common}`} style={{ color }}>
      {symbol.slice(0, 2)}
    </span>
  );
}

export function TokenIcon({ symbol, color }: { symbol: string; color: string }) {
  const isOfficialTokenLogo = symbol === 'USDC' || symbol === 'EURC';

  return (
    <span
      className={`flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full text-white shadow-[0_12px_22px_rgba(15,23,42,0.14)] ${isOfficialTokenLogo ? '' : 'ring-2 ring-white/70'}`}
      style={{ background: isOfficialTokenLogo ? 'transparent' : `linear-gradient(135deg, ${color}, rgba(15, 23, 42, 0.88))` }}
    >
      <AssetLogo symbol={symbol} color={color} className={isOfficialTokenLogo ? 'h-9 w-9' : 'h-5 w-5'} />
    </span>
  );
}

export function ChainLogo({ chainId, className = '' }: { chainId: number; className?: string }) {
  const common = `block ${className}`;

  const network = getOrbitNetwork(chainId);
  const src = network?.logo;
  if (!src) {
    return <span className={`inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-500 bg-slate-700 ${common}`} aria-hidden="true" />;
  }

  return <img src={src} alt={`${network.name} logo`} className={`${common} select-none object-contain`} draggable={false} />;
}

import { useState } from 'react';
import { useAccount, useConnect, useSwitchChain } from 'wagmi';
import { formatUnits } from 'viem';
import { ArrowDownToLine, ArrowUpRight, RefreshCw, Wallet } from 'lucide-react';
import { getOrbitNetwork } from '../data/networks';
import { gatewayNetworks, gatewayNetworkForDomain } from '../services/gateway';
import { useGateway } from '../hooks/useGateway';
import { explorerTransactionUrl } from '../data/networks';
import { getPreferredConnector } from '../wallet';
import { Button, Card, ChainLogo, Label } from './ui';

const ARC_ID = 5042002;
const DEFAULT_DESTINATION = gatewayNetworks.find((network) => network.id !== ARC_ID)?.id ?? ARC_ID;

function amountLabel(raw: bigint) {
  return formatUnits(raw, 6);
}

export function UnifiedBalancePage() {
  const { address, chainId, isConnected } = useAccount();
  const { connectors, connect, isPending: isConnecting } = useConnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const [sourceId, setSourceId] = useState(chainId && gatewayNetworks.some((network) => network.id === chainId) ? chainId : ARC_ID);
  const [destinationId, setDestinationId] = useState(DEFAULT_DESTINATION);
  const [depositAmount, setDepositAmount] = useState('');
  const [spendAmount, setSpendAmount] = useState('');
  const gateway = useGateway(sourceId, destinationId);
  const source = getOrbitNetwork(sourceId)!;
  const destination = getOrbitNetwork(destinationId)!;
  const connectWallet = () => {
    const connector = getPreferredConnector(connectors);
    if (connector) connect({ connector });
  };
  const sourceNetworkMismatch = Boolean(isConnected && chainId !== sourceId);
  const operationMessage = gateway.error?.message
    ?? (sourceNetworkMismatch ? `Switch wallet to ${source.name} before signing.` : null)
    ?? (gateway.depositState === 'confirmed' ? 'Gateway deposit confirmed. Circle balance availability follows Gateway finality.' : null)
    ?? (gateway.spendState === 'confirmed' ? 'Gateway spend confirmed on the destination chain.' : null);
  const gatewayBalanceValue = gateway.isGatewayBalanceLoading
    ? 'Loading...'
    : gateway.isGatewayBalanceError || !gateway.hasGatewayBalanceData
      ? 'Unavailable'
      : `${amountLabel(gateway.totalGatewayBalance)} USDC`;

  if (!isConnected || !address) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader />
        <Card className="flex flex-col items-center p-12 text-center" glow>
          <Wallet size={30} className="text-cyan-300" />
          <h2 className="mt-4 text-xl font-bold text-white">Connect your wallet</h2>
          <p className="mt-2 max-w-md text-sm leading-6 text-slate-400">Gateway balances are read from Circle for the connected EVM wallet. ORBIT does not display placeholder balances.</p>
          <Button className="mt-6" onClick={connectWallet} disabled={isConnecting}>{isConnecting ? 'Connecting...' : 'Connect wallet'}</Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader />
      <Card className="p-6" glow>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Label>Total unified USDC</Label>
            <h2 className="mt-2 text-3xl font-extrabold text-white">{gatewayBalanceValue}</h2>
            <p className="mt-1 text-xs text-slate-500">Circle Gateway available balance across verified supported networks.</p>
          </div>
          <Button variant="secondary" onClick={() => void gateway.refresh()} disabled={gateway.isBalanceLoading}><RefreshCw size={15} className={gateway.isBalanceLoading ? 'animate-spin' : ''} /> Refresh</Button>
        </div>
        {gateway.isBalanceError && <p className="mt-4 text-sm text-rose-200">Gateway balance unavailable. Retry when the Circle Gateway API is reachable.</p>}
        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <BalanceTile label="Available" value={gatewayBalanceValue} detail="Circle Gateway API" />
          <BalanceTile label="Pending" value="Unavailable" detail="Not returned by the verified browser balance endpoint" />
          <BalanceTile label="Gateway balance" value={gatewayBalanceValue} detail="Not added to wallet balances" />
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
        <Card className="p-5" glow>
          <div className="flex items-center gap-3"><div className="rounded-xl bg-cyan-300/10 p-3 text-cyan-200"><ArrowDownToLine size={19} /></div><div><Label>Fund Gateway</Label><h2 className="mt-1 text-xl font-bold text-white">Deposit USDC</h2></div></div>
          <p className="mt-3 text-sm leading-6 text-slate-400">Move wallet USDC into your Circle Gateway balance. This is separate from CCTP Bridge.</p>
          <NetworkSelect label="Source network" value={sourceId} onChange={(value) => { setSourceId(value); setDepositAmount(''); }} options={gatewayNetworks} />
          <div className="mt-4 flex items-center justify-between text-xs"><span className="text-slate-500">Wallet USDC on {source.name}</span><span className="font-mono text-slate-200">{gateway.sourceBalanceDisplay}</span></div>
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[.04] px-4"><input value={depositAmount} onChange={(event) => setDepositAmount(event.target.value)} inputMode="decimal" placeholder="0.00" className="min-w-0 flex-1 bg-transparent py-3 text-xl font-bold text-white outline-none placeholder:text-slate-600" /><span className="font-mono text-xs text-slate-500">USDC</span></div>
          {sourceNetworkMismatch && <NetworkGuard network={source.name} onSwitch={() => switchChain({ chainId: sourceId })} disabled={isSwitching} />}
          <Button className="mt-4 w-full" onClick={() => void gateway.deposit(depositAmount)} disabled={gateway.busy || sourceNetworkMismatch || !depositAmount}>{gateway.depositState === 'approval' ? 'Approve USDC...' : gateway.depositState === 'deposit' ? 'Confirm Gateway deposit...' : gateway.depositState === 'pending' ? 'Deposit pending...' : gateway.depositState === 'confirmed' ? 'Deposit confirmed' : 'Review deposit'}</Button>
          {gateway.depositHash && <TxLink label="Deposit transaction" hash={gateway.depositHash} chainId={sourceId} />}
        </Card>

        <Card className="p-5" glow>
          <div className="flex items-center gap-3"><div className="rounded-xl bg-blue-300/10 p-3 text-blue-200"><ArrowUpRight size={19} /></div><div><Label>Spend Gateway balance</Label><h2 className="mt-1 text-xl font-bold text-white">Transfer USDC</h2></div></div>
          <p className="mt-3 text-sm leading-6 text-slate-400">Authorize a Gateway burn intent, receive Circle’s attestation, and mint on the selected destination.</p>
          <NetworkSelect label="Source Gateway balance" value={sourceId} onChange={setSourceId} options={gatewayNetworks} />
          <div className="mt-3 flex items-center justify-between text-xs"><span className="text-slate-500">Available on {source.name}</span><span className="font-mono text-slate-200">{amountLabel(gateway.sourceGatewayBalance)} USDC</span></div>
          <NetworkSelect label="Destination network" value={destinationId} onChange={setDestinationId} options={gatewayNetworks.filter((network) => network.id !== sourceId)} />
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[.04] px-4"><input value={spendAmount} onChange={(event) => setSpendAmount(event.target.value)} inputMode="decimal" placeholder="0.00" className="min-w-0 flex-1 bg-transparent py-3 text-xl font-bold text-white outline-none placeholder:text-slate-600" /><span className="font-mono text-xs text-slate-500">USDC</span></div>
          {sourceNetworkMismatch && <NetworkGuard network={source.name} onSwitch={() => switchChain({ chainId: sourceId })} disabled={isSwitching} />}
          <Button className="mt-4 w-full" onClick={() => void gateway.spend(spendAmount)} disabled={gateway.busy || sourceNetworkMismatch || !spendAmount || sourceId === destinationId}>{gateway.spendState === 'signing' ? 'Confirm Gateway authorization...' : gateway.spendState === 'minting' ? `Minting on ${destination.name}...` : gateway.spendState === 'pending' ? 'Transfer pending...' : gateway.spendState === 'confirmed' ? 'Transfer confirmed' : 'Review transfer'}</Button>
          {gateway.mintHash && <TxLink label="Destination transaction" hash={gateway.mintHash} chainId={destinationId} />}
        </Card>
      </div>

      <Card className="p-5">
        <div className="flex items-center justify-between gap-3"><div><Label>Balance sources</Label><h2 className="mt-1 text-lg font-bold text-white">Wallet balances</h2></div><span className="text-xs text-slate-500">EVM USDC, 6 decimals</span></div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{gateway.walletBalances.map(({ network, raw, isLoading, isError }) => <div key={network.id} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[.03] p-3"><span className="flex min-w-0 items-center gap-2 text-xs font-semibold text-slate-200"><ChainLogo chainId={network.id} className="h-5 w-5" /><span className="truncate">{network.name}</span></span><span className="font-mono text-xs text-slate-300">{isLoading ? 'Loading...' : isError || raw === undefined ? 'Unavailable' : `${amountLabel(raw)} USDC`}</span></div>)}</div>
        <div className="mt-6 border-t border-white/10 pt-5"><div className="flex items-center justify-between gap-3"><div><Label>Circle Gateway balance</Label><h2 className="mt-1 text-lg font-bold text-white">Available by source</h2></div><span className="text-xs text-slate-500">Not wallet balances</span></div><div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{gateway.gatewayBalances.map((balance) => { const network = gatewayNetworkForDomain(balance.domain); return network ? <div key={balance.domain} className="flex items-center justify-between rounded-xl border border-cyan-300/10 bg-cyan-300/[.04] p-3"><span className="flex min-w-0 items-center gap-2 text-xs font-semibold text-slate-200"><ChainLogo chainId={network.id} className="h-5 w-5" /><span className="truncate">{network.name}</span></span><span className="font-mono text-xs text-cyan-100">{balance.formatted} USDC</span></div> : null; })}</div>{!gateway.isGatewayBalanceLoading && !gateway.isGatewayBalanceError && !gateway.hasGatewayBalanceData && <p className="mt-3 text-xs text-slate-500">No confirmed Gateway balance was returned for this wallet.</p>}</div>
      </Card>
      {operationMessage && <p className={`text-xs ${gateway.error ? 'text-rose-300' : 'text-cyan-200'}`}>{operationMessage}</p>}
    </div>
  );
}

function PageHeader() {
  return <div><Label>Move / Unified Balance</Label><h1 className="mt-2 text-3xl font-extrabold tracking-tight text-white">Unified Balance</h1><p className="mt-2 text-sm text-slate-400">One USDC balance across supported networks.</p></div>;
}

function BalanceTile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="rounded-xl border border-white/10 bg-white/[.03] p-4"><p className="text-xs font-semibold text-slate-400">{label}</p><p className="mt-2 font-mono text-lg text-white">{value}</p><p className="mt-1 text-[10px] leading-4 text-slate-500">{detail}</p></div>;
}

function NetworkSelect({ label, value, onChange, options }: { label: string; value: number; onChange: (value: number) => void; options: typeof gatewayNetworks }) {
  return <label className="mt-4 block"><span className="mb-2 block text-xs font-semibold text-slate-400">{label}</span><div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[.04] px-3"><ChainLogo chainId={value} className="h-6 w-6" /><select value={value} onChange={(event) => onChange(Number(event.target.value))} className="min-w-0 flex-1 bg-transparent py-3 text-sm font-bold text-white outline-none">{options.map((network) => <option key={network.id} value={network.id} className="bg-[#101725]">{network.name}</option>)}</select></div></label>;
}

function NetworkGuard({ network, onSwitch, disabled }: { network: string; onSwitch: () => void; disabled: boolean }) {
  return <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-amber-300/20 bg-amber-300/[.06] p-3 text-xs text-amber-100"><span>Switch wallet to {network}</span><Button variant="secondary" onClick={onSwitch} disabled={disabled}>{disabled ? 'Switching...' : 'Switch wallet'}</Button></div>;
}

function TxLink({ label, hash, chainId }: { label: string; hash: `0x${string}`; chainId: number }) {
  const href = explorerTransactionUrl(chainId, hash);
  return href ? <p className="mt-3 text-xs text-emerald-300">{label}: <a className="underline" href={href} target="_blank" rel="noopener noreferrer">{hash.slice(0, 10)}...{hash.slice(-8)}</a></p> : null;
}

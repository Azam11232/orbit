import { useReducer, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useAccount, useConnect, useSwitchChain } from 'wagmi';
import { formatUnits } from 'viem';
import { ArrowDownToLine, ArrowUpRight, RefreshCw, Wallet } from 'lucide-react';
import { getOrbitNetwork } from '../data/networks';
import { gatewayNetworks, isGatewayTransferRouteValid } from '../services/gateway';
import { useGateway } from '../hooks/useGateway';
import { explorerTransactionUrl } from '../data/networks';
import { getPreferredConnector } from '../wallet';
import { Button, Card, ChainLogo, Label } from './ui';
import { getInitialTransferDestination, shouldShowFastGatewayDepositOption, updateUnifiedBalanceNetworkState } from './unifiedBalanceNetworkState';
import { TransactionSuccessScreen } from './TransactionSuccessScreen';

const ARC_ID = 5042002;

function amountLabel(raw: bigint) {
  return formatUnits(raw, 6);
}

export function UnifiedBalancePage() {
  const { address, chainId, isConnected } = useAccount();
  const { connectors, connect, isPending: isConnecting } = useConnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const initialSourceId = chainId && gatewayNetworks.some((network) => network.id === chainId) ? chainId : ARC_ID;
  const [networkSelection, dispatchNetworkSelection] = useReducer(updateUnifiedBalanceNetworkState, {
    depositSourceId: initialSourceId,
    transferSourceId: initialSourceId,
    transferDestinationId: getInitialTransferDestination(initialSourceId, gatewayNetworks.map((network) => network.id)),
  });
  const { depositSourceId, transferSourceId, transferDestinationId: destinationId } = networkSelection;
  const [depositAmount, setDepositAmount] = useState('');
  const [spendAmount, setSpendAmount] = useState('');
  const gateway = useGateway(depositSourceId, transferSourceId, destinationId);
  const depositSource = getOrbitNetwork(depositSourceId)!;
  const transferSource = getOrbitNetwork(transferSourceId)!;
  const destination = getOrbitNetwork(destinationId)!;
  const connectWallet = () => {
    const connector = getPreferredConnector(connectors);
    if (connector) connect({ connector });
  };
  const depositNetworkMismatch = Boolean(isConnected && chainId !== depositSourceId);
  const transferNetworkMismatch = Boolean(isConnected && chainId !== transferSourceId);
  const previousDepositPending = gateway.depositAvailability !== null && gateway.depositAvailability.status !== 'available';
  const transferRouteValid = isGatewayTransferRouteValid(transferSourceId, destinationId);
  const operationMessage = gateway.error?.message
    ?? (depositNetworkMismatch ? `Switch wallet to ${depositSource.name} before depositing.` : null)
    ?? (transferNetworkMismatch ? `Switch wallet to ${transferSource.name} before transferring.` : null);
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
          <Button variant="secondary" onClick={() => void gateway.refresh()} disabled={gateway.isRefreshing || gateway.busy}><RefreshCw size={15} className={gateway.isRefreshing ? 'animate-spin' : ''} /> {gateway.isRefreshing ? 'Refreshing...' : 'Refresh'}</Button>
        </div>
        {gateway.refreshError && <p role="alert" className="mt-4 text-sm text-rose-200">Balance refresh failed: {gateway.refreshError.message} Retry using Refresh.</p>}
        {gateway.isGatewayBalanceError && <p role="alert" className="mt-4 text-sm text-rose-200">Gateway balances unavailable: {gateway.gatewayBalanceError instanceof Error ? gateway.gatewayBalanceError.message : 'Circle Gateway API request failed.'} Retry using Refresh.</p>}
        {gateway.isWalletBalancesError && <p role="alert" className="mt-4 text-sm text-rose-200">One or more wallet balances could not be refreshed. Retry using Refresh.</p>}
        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <BalanceTile label="Available" value={gatewayBalanceValue} detail="Circle Gateway API" />
          <BalanceTile label="Pending batch" value={gateway.isGatewayBalanceLoading ? 'Loading...' : gateway.isGatewayBalanceError || !gateway.hasGatewayBalanceData ? 'Unavailable' : `${amountLabel(gateway.totalGatewayPendingBatch)} USDC`} detail="Awaiting Circle Gateway batch processing; not available to transfer" />
          <BalanceTile label="Gateway balance" value={gatewayBalanceValue} detail="Not added to wallet balances" />
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
        <Card className="p-5" glow>
          <div className="flex items-center gap-3"><div className="rounded-xl bg-cyan-300/10 p-3 text-cyan-200"><ArrowDownToLine size={19} /></div><div><Label>Fund Gateway</Label><h2 className="mt-1 text-xl font-bold text-white">Deposit USDC</h2></div></div>
          <p className="mt-3 text-sm leading-6 text-slate-400">Move wallet USDC into your Circle Gateway balance. This is separate from CCTP Bridge.</p>
          <NetworkSelect label="Source network" value={depositSourceId} onChange={(value) => { dispatchNetworkSelection({ type: 'deposit-source', chainId: value }); setDepositAmount(''); gateway.clearFastDepositEstimate(); }} options={gatewayNetworks} />
          <div className="mt-4 flex items-center justify-between text-xs"><span className="text-slate-500">Wallet USDC on {depositSource.name}</span><span className="font-mono text-slate-200">{gateway.sourceBalanceDisplay}</span></div>
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[.04] px-4"><input value={depositAmount} onChange={(event) => { setDepositAmount(event.target.value); gateway.clearFastDepositEstimate(); }} inputMode="decimal" placeholder="0.00" className="min-w-0 flex-1 bg-transparent py-3 text-xl font-bold text-white outline-none placeholder:text-slate-600" /><span className="font-mono text-xs text-slate-500">USDC</span></div>
          {depositNetworkMismatch && <NetworkGuard network={depositSource.name} onSwitch={() => switchChain({ chainId: depositSourceId })} disabled={isSwitching} />}
          <Button className="mt-4 w-full" onClick={() => void gateway.deposit(depositAmount)} disabled={gateway.busy || depositNetworkMismatch || !depositAmount || (gateway.depositAvailability !== null && gateway.depositAvailability.status !== 'available')}>{gateway.depositState === 'checking' ? 'Checking Gateway balance...' : gateway.depositState === 'estimating' ? 'Estimating fast deposit...' : gateway.depositState === 'approval' ? 'Approve USDC...' : gateway.depositState === 'deposit' ? 'Confirm Gateway deposit...' : gateway.depositState === 'pending' ? 'Deposit pending...' : gateway.depositState === 'relaying' ? 'Circle is relaying...' : gateway.depositState === 'confirmed' ? 'Deposit confirmed' : gateway.depositAvailability?.status === 'timeout' ? 'Retry Gateway check first' : 'Review standard deposit'}</Button>
          {shouldShowFastGatewayDepositOption(depositSourceId) && <div className="mt-3 rounded-xl border border-cyan-300/15 bg-cyan-300/[.04] p-3">
            <p className="text-xs font-semibold text-cyan-100">Fast Deposit — Ethereum Sepolia to Arc Testnet</p>
            <p className="mt-1 text-[11px] leading-5 text-slate-400">Separate opt-in route: Ethereum Sepolia to Arc Testnet. The Transfer destination selector does not affect this route. Circle returns a live fee and source-gas estimate for review before confirmation.</p>
            {previousDepositPending && <p role="status" className="mt-2 rounded-lg border border-amber-300/20 bg-amber-300/[.06] p-2 text-[11px] leading-5 text-amber-100">
              {gateway.depositAvailability?.status === 'timeout'
                ? 'A previous deposit is still awaiting Gateway availability. Fast Deposit remains visible, but a new estimate or deposit is disabled until that deposit is resolved.'
                : `A ${gateway.depositAvailability?.transferSpeed === 'FAST' ? 'Fast' : 'Standard'} deposit is still awaiting Gateway availability. Fast Deposit remains visible, but a new estimate or deposit is disabled until it is resolved.`}
            </p>}
            {!gateway.fastDepositEstimate ? <Button className="mt-2 w-full" variant="secondary" onClick={() => void gateway.prepareFastDeposit(depositAmount)} disabled={gateway.busy || depositNetworkMismatch || !depositAmount || previousDepositPending}>{previousDepositPending ? 'Fast Deposit unavailable while previous deposit is pending' : 'Get Fast Deposit estimate'}</Button> : <div className="mt-3">
              <p className="text-xs text-slate-300">Destination: <span className="font-semibold text-white">Arc Testnet</span></p>
              <p className="text-xs text-slate-300">Deposit amount: <span className="font-mono text-white">{formatUnits(gateway.fastDepositEstimate.amount, 6)} USDC</span></p>
              <p className="text-[11px] font-semibold text-slate-300">Estimated costs</p>
              <div className="mt-2 space-y-1">{gateway.fastDepositEstimate.estimate.fees.map((fee, index) => <div key={`${fee.type}-${fee.token}-${index}`} className="flex justify-between gap-3 text-[11px]"><span className="text-slate-400">{fee.type} ({fee.token})</span><span className="font-mono text-slate-200">{fee.amount ?? 'Unavailable'} {fee.token}</span></div>)}</div>
              <p className="mt-2 text-[10px] leading-4 text-amber-200">This is an opt-in cross-chain deposit: USDC is burned on Sepolia, then Circle relays a fast mint and Gateway deposit to Arc. A confirmed source transaction does not alone make the funds spendable.</p>
              <div className="mt-3 flex gap-2"><Button className="flex-1" variant="secondary" onClick={gateway.clearFastDepositEstimate} disabled={gateway.busy}>Cancel</Button><Button className="flex-1" onClick={() => void gateway.confirmFastDeposit(depositAmount)} disabled={gateway.busy || depositNetworkMismatch}>Confirm fast deposit</Button></div>
            </div>}
          </div>}
          {gateway.depositAvailability?.status === 'waiting' && <div role="status" className="mt-3 rounded-xl border border-amber-300/20 bg-amber-300/[.06] p-3 text-xs leading-5 text-amber-100">
            <p className="font-semibold">{gateway.depositAvailability.transferSpeed === 'FAST'
              ? gateway.fastRelayStatus === 'FAILED' ? 'Fast relay failed'
                : gateway.fastDestinationHash ? 'Fast relay confirmed; waiting for Gateway credit'
                  : gateway.fastRelayStatus === 'DONE' ? 'Verifying Arc relay receipt'
                    : gateway.fastRelayStatus === 'PENDING' ? 'Fast relay pending' : 'Awaiting Circle relay status'
              : 'Waiting for Gateway finality'}</p>
            {gateway.depositAvailability.transferSpeed === 'FAST' && gateway.fastRelayStatus === 'FAILED'
              ? <p className="mt-1">Circle reported a terminal relay failure after the source burn was confirmed. Arc completion was not verified; do not submit another deposit. Check the source transaction and contact Circle support.</p>
              : <p className="mt-1">The {gateway.depositAvailability.amount} USDC deposit transaction is confirmed on {gateway.depositAvailability.networkName}, but Circle has not yet reported it as available. Funds remain unavailable to transfer until then.</p>}
            {gateway.depositAvailability.transferSpeed === 'FAST' && gateway.fastRelayStatus !== 'FAILED'
              ? <p className="mt-1">{gateway.fastDestinationHash
                ? 'Circle’s destination relay transaction is confirmed on Arc. The amount remains unavailable until the Gateway balance API confirms it.'
                : gateway.fastRelayStatus === 'DONE'
                  ? 'Circle reports relay completion. ORBIT is verifying the Arc transaction receipt before treating the relay as complete.'
                  : gateway.fastRelayStatus === 'PENDING'
                    ? `Circle’s relay is pending for ${gateway.depositAvailability.networkName}. Funds remain unavailable until the relay receipt and Gateway balance are verified.`
                    : `ORBIT is waiting for Circle’s relay status for ${gateway.depositAvailability.networkName}. Funds remain unavailable until the relay receipt and Gateway balance are verified.`}</p>
              : gateway.depositAvailability.transferSpeed === 'STANDARD' && gateway.depositAvailability.networkName === 'Ethereum Sepolia' && <p className="mt-1">Circle requires 65 Ethereum confirmations for standard Sepolia deposits, typically about 13–19 minutes.</p>}
            {gateway.depositAvailability.checkError && <p className="mt-1 text-amber-200">Balance check will retry automatically: {gateway.depositAvailability.checkError}</p>}
          </div>}
          {gateway.depositAvailability?.status === 'available' && <p role="status" className="mt-3 rounded-xl border border-emerald-300/20 bg-emerald-300/[.06] p-3 text-xs leading-5 text-emerald-100">Gateway reports the additional {gateway.depositAvailability.amount} USDC available on {gateway.depositAvailability.networkName}.</p>}
          {gateway.depositAvailability?.status === 'timeout' && <div role="status" className="mt-3 rounded-xl border border-amber-300/20 bg-amber-300/[.06] p-3 text-xs leading-5 text-amber-100">
            <p className="font-semibold">{gateway.depositAvailability.transferSpeed === 'FAST' && gateway.fastRelayStatus === 'FAILED' ? 'Fast relay failed; Gateway balance is unavailable' : 'Deposit confirmed; Gateway balance is still pending'}</p>
            <p className="mt-1">Circle has not reported the additional {gateway.depositAvailability.amount} USDC as available yet. Your source transaction remains confirmed; {gateway.depositAvailability.transferSpeed === 'FAST' ? gateway.fastRelayStatus === 'FAILED' ? 'do not submit another deposit; contact Circle support and retry only the balance check if advised.' : 'check the Circle relay and retry the balance check.' : 'wait for source-chain finality or retry the balance check.'}</p>
            <Button className="mt-2" variant="secondary" onClick={gateway.retryDepositAvailability}>Retry Gateway check</Button>
          </div>}
          {gateway.depositHash && <TxLink label="Deposit source transaction" hash={gateway.depositHash} chainId={gateway.depositHashChainId ?? depositSourceId} />}
          {gateway.fastDestinationHash && <TxLink label="Fast relay transaction" hash={gateway.fastDestinationHash} chainId={ARC_ID} />}
        </Card>

        <Card className="p-5" glow>
          <div className="flex items-center gap-3"><div className="rounded-xl bg-blue-300/10 p-3 text-blue-200"><ArrowUpRight size={19} /></div><div><Label>Spend Gateway balance</Label><h2 className="mt-1 text-xl font-bold text-white">Transfer USDC</h2></div></div>
          <p className="mt-3 text-sm leading-6 text-slate-400">Authorize a Gateway burn intent, receive Circle’s attestation, and mint on the selected destination.</p>
          <NetworkSelect label="Source Gateway balance" value={transferSourceId} onChange={(value) => dispatchNetworkSelection({ type: 'transfer-source', chainId: value })} options={gatewayNetworks} />
          <div className="mt-3 flex items-center justify-between text-xs"><span className="text-slate-500">Available on {transferSource.name}</span><span className="font-mono text-slate-200">{gateway.sourceGatewayBalance === null ? 'Unavailable' : `${amountLabel(gateway.sourceGatewayBalance)} USDC`}</span></div>
          <NetworkSelect label="Destination network" value={destinationId} onChange={(value) => dispatchNetworkSelection({ type: 'transfer-destination', chainId: value })} options={gatewayNetworks} />
          {!transferRouteValid && <p role="alert" className="mt-2 text-xs text-rose-300">Choose a destination network different from the Gateway source.</p>}
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[.04] px-4"><input value={spendAmount} onChange={(event) => setSpendAmount(event.target.value)} inputMode="decimal" placeholder="0.00" className="min-w-0 flex-1 bg-transparent py-3 text-xl font-bold text-white outline-none placeholder:text-slate-600" /><span className="font-mono text-xs text-slate-500">USDC</span></div>
          {transferNetworkMismatch && <NetworkGuard network={transferSource.name} onSwitch={() => switchChain({ chainId: transferSourceId })} disabled={isSwitching} />}
          <Button className="mt-4 w-full" onClick={() => void gateway.spend(spendAmount)} disabled={gateway.busy || transferNetworkMismatch || !spendAmount || !transferRouteValid}>{gateway.spendState === 'signing' ? 'Confirm Gateway authorization...' : gateway.spendState === 'minting' ? `Minting on ${destination.name}...` : gateway.spendState === 'pending' ? 'Transfer pending...' : gateway.spendState === 'confirmed' ? 'Transfer confirmed' : 'Review transfer'}</Button>
          {gateway.mintHash && <TxLink label="Destination transaction" hash={gateway.mintHash} chainId={destinationId} />}
        </Card>
      </div>

      <Card className="p-5">
        <div className="flex items-center justify-between gap-3"><div><Label>Balance sources</Label><h2 className="mt-1 text-lg font-bold text-white">Wallet balances</h2></div><span className="text-xs text-slate-500">EVM USDC, 6 decimals</span></div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{gateway.walletBalances.map(({ network, raw, isLoading, isError }) => <div key={network.id} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[.03] p-3"><span className="flex min-w-0 items-center gap-2 text-xs font-semibold text-slate-200"><ChainLogo chainId={network.id} className="h-5 w-5" /><span className="truncate">{network.name}</span></span><span className="font-mono text-xs text-slate-300">{isLoading ? 'Loading...' : isError || raw === undefined ? 'Unavailable' : `${amountLabel(raw)} USDC`}</span></div>)}</div>
        <div className="mt-6 border-t border-white/10 pt-5"><div className="flex items-center justify-between gap-3"><div><Label>Circle Gateway balance</Label><h2 className="mt-1 text-lg font-bold text-white">Available by source</h2></div><span className="text-xs text-slate-500">Not wallet balances</span></div><div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{gateway.gatewayNetworks.map((network) => { const balance = gateway.gatewayBalances.find((item) => item.domain === network.cctpDomain); return <div key={network.id} className="flex items-center justify-between rounded-xl border border-cyan-300/10 bg-cyan-300/[.04] p-3"><span className="flex min-w-0 items-center gap-2 text-xs font-semibold text-slate-200"><ChainLogo chainId={network.id} className="h-5 w-5" /><span className="truncate">{network.name}</span></span><span className="text-right font-mono text-xs text-cyan-100">{gateway.isGatewayBalanceError || !balance ? 'Unavailable' : <>{balance.formatted} USDC{balance.pendingBatchRaw > 0n && <span className="block text-[10px] text-amber-200">{balance.pendingBatchFormatted} pending</span>}</>}</span></div>; })}</div>{!gateway.isGatewayBalanceLoading && !gateway.isGatewayBalanceError && !gateway.hasGatewayBalanceData && <p className="mt-3 text-xs text-slate-500">No confirmed Gateway balance was returned for this wallet.</p>}</div>
      </Card>
      <AnimatePresence>
        {gateway.successNotification && <TransactionSuccessScreen
          key={gateway.successNotification.successChimeKey}
          title={gateway.successNotification.title}
          description={gateway.successNotification.description}
          amountLabel={gateway.successNotification.title.startsWith('Transfer') ? 'Amount transferred' : 'Amount deposited'}
          amount={gateway.successNotification.amount}
          token={{ symbol: 'USDC', color: '#22d3ee' }}
          networks={[{ label: gateway.successNotification.title.startsWith('Transfer') ? 'Destination network' : 'Source network', network: { id: gateway.successNotification.chainId, name: gateway.successNotification.networkName } }]}
          transactionLabel={gateway.successNotification.title.startsWith('Transfer') ? 'Destination transaction' : 'Source transaction'}
          transactionHash={gateway.successNotification.hash}
          successChimeKey={gateway.successNotification.successChimeKey}
          explorerUrl={explorerTransactionUrl(gateway.successNotification.chainId, gateway.successNotification.hash) ?? null}
          additionalTransactions={gateway.successNotification.additionalTransactions}
          completedAt={Date.now()}
          primaryLabel="Done"
          onBack={gateway.clearSuccessNotification}
          onPrimary={gateway.clearSuccessNotification}
        />}
      </AnimatePresence>
      {operationMessage && <p role={gateway.error ? 'alert' : 'status'} className={`text-xs ${gateway.error ? 'text-rose-300' : 'text-cyan-200'}`}>{operationMessage}</p>}
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

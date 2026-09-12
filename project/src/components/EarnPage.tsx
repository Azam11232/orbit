import { useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { useAccount, useConnect, useSwitchChain } from "wagmi";
import { base } from "wagmi/chains";
import { TrendingUp, ShieldCheck, Wallet } from "lucide-react";
import { useLendingApproval } from "../hooks/useLendingApproval";
import { useLendingBalance } from "../hooks/useLendingBalance";
import { useLendingOperation } from "../hooks/useLendingOperation";
import { useLendingPositions } from "../hooks/useLendingPositions";
import { AAVE_BASE_ASSETS, AAVE_BASE_POOL } from "../services/lending/aave";
import { explorerTxUrl, shortAddr } from "../services/transactions";
import { Card, Button, Label } from "./ui";
import { getPreferredConnector } from "../wallet";

type EarnOperation = "supply" | "withdraw";

function WalletButton() {
  const { connectors, connect, isPending } = useConnect();
  const connector = getPreferredConnector(connectors);
  return <Button onClick={() => connector && connect({ connector })} disabled={!connector || isPending}>{isPending ? "Connecting..." : "Connect Wallet"}</Button>;
}

export function EarnPage() {
  const { address, isConnected, chainId } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const lending = useLendingPositions();
  const [symbol, setSymbol] = useState<"USDC" | "WETH">("USDC");
  const [amount, setAmount] = useState("");
  const [operation, setOperation] = useState<EarnOperation>("supply");
  const [showConfirmation, setShowConfirmation] = useState(false);
  const asset = AAVE_BASE_ASSETS.find((item) => item.symbol === symbol) ?? AAVE_BASE_ASSETS[0];
  const position = lending.position?.assets.find((item) => item.symbol === symbol);
  const balance = useLendingBalance(asset, address, isConnected && chainId === base.id);
  let rawAmount: bigint | null = null;
  try { rawAmount = amount ? parseUnits(amount, asset.decimals) : null; } catch { rawAmount = null; }
  const approval = useLendingApproval(asset, rawAmount, isConnected && chainId === base.id && operation === "supply");
  const action = useLendingOperation(operation, asset, rawAmount, lending.position);
  const amountError = amount && rawAmount === null
    ? `Enter a valid ${asset.symbol} amount with up to ${asset.decimals} decimals.`
    : rawAmount !== null && rawAmount <= 0n
      ? "Amount must be greater than zero."
      : rawAmount !== null && operation === "supply" && rawAmount > balance.raw
        ? `Insufficient ${asset.symbol} wallet balance.`
        : rawAmount !== null && operation === "withdraw" && position && rawAmount > position.supplied
          ? `Amount exceeds your supplied ${asset.symbol} position.`
          : null;
  const ready = Boolean(isConnected && chainId === base.id && lending.position && rawAmount && !amountError && !approval.required && !lending.isLoading);
  const maxAmount = operation === "supply" ? balance.raw : position?.supplied ?? 0n;
  const statusMessage = amountError ?? action.error?.message ?? (lending.isError ? "Live Aave position data is unavailable. Try refreshing." : lending.isLoading ? "Loading live Base market data..." : approval.required ? "Approve the exact amount before supplying." : action.status === "confirmed" ? "Transaction confirmed and position refreshed." : action.status === "pending" ? "Transaction pending on Base..." : lending.position ? "Ready to review transaction." : "Connect a wallet to load your position.");

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div><Label>Earn / Base Mainnet</Label><h1 className="mt-2 text-3xl font-extrabold tracking-tight">Put your assets to work.</h1></div>
      <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
        <Card className="p-5" glow>
          <div className="mb-5"><Label>Live yield</Label><h2 className="mt-2 text-xl font-bold">Aave V3 on Base</h2><p className="mt-2 text-xs leading-5 text-slate-500">Supply supported Base assets and earn the current onchain rate. Rates are variable.</p></div>
          {!isConnected ? <div className="rounded-xl border border-cyan-300/20 bg-cyan-300/[.05] p-5 text-center"><Wallet size={24} className="mx-auto text-cyan-300" /><p className="mt-3 text-sm font-semibold">Connect your wallet to start earning.</p><div className="mt-4"><WalletButton /></div></div> : chainId !== base.id ? <div className="rounded-xl border border-amber-300/20 bg-amber-300/[.06] p-5"><div className="flex items-center gap-2 text-amber-200"><ShieldCheck size={17} /><span className="text-sm font-semibold">Base Mainnet required</span></div><p className="mt-2 text-xs text-slate-400">Earn transactions and live positions are available on Base only.</p><Button variant="secondary" className="mt-4" onClick={() => switchChain({ chainId: base.id })} disabled={isSwitching}>{isSwitching ? "Switching..." : "Switch to Base"}</Button></div> : <>
            {lending.isError && <p className="mb-4 rounded-xl border border-rose-300/20 bg-rose-300/[.06] p-4 text-xs text-rose-200">Live Aave position data is unavailable. Try refreshing.</p>}
            <div className="grid grid-cols-2 gap-2"><button onClick={() => { setOperation("supply"); setAmount(""); }} className={`rounded-lg px-3 py-2 text-xs font-bold ${operation === "supply" ? "bg-cyan-300 text-slate-950" : "bg-white/[.04] text-slate-400"}`}>Supply</button><button onClick={() => { setOperation("withdraw"); setAmount(""); }} className={`rounded-lg px-3 py-2 text-xs font-bold ${operation === "withdraw" ? "bg-cyan-300 text-slate-950" : "bg-white/[.04] text-slate-400"}`}>Withdraw</button></div>
            <div className="mt-4 flex items-center justify-between rounded-xl border border-white/10 bg-white/[.03] p-4"><select value={symbol} onChange={(event) => { setSymbol(event.target.value as "USDC" | "WETH"); setAmount(""); }} className="rounded-lg border border-white/10 bg-[#101725] p-2 font-bold text-white outline-none"><option value="USDC">USDC</option><option value="WETH">WETH</option></select><span className="font-mono text-[10px] text-slate-500">Wallet {balance.isLoading ? "..." : formatUnits(balance.raw, asset.decimals)}</span></div>
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[.04] px-4"><input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="0.00" className="min-w-0 flex-1 bg-transparent py-3 text-lg font-bold text-white outline-none placeholder:text-slate-600" /><button type="button" onClick={() => setAmount(formatUnits(maxAmount, asset.decimals))} className="font-mono text-[10px] font-bold text-cyan-300">MAX</button><span className="font-mono text-xs text-slate-500">{symbol}</span></div>
            <div className="mt-4 space-y-2 rounded-xl bg-white/[.03] p-4 text-xs"><div className="flex justify-between"><span className="text-slate-500">Your supplied position</span><span>{position ? formatUnits(position.supplied, asset.decimals) : "Unavailable"} {symbol}</span></div><div className="flex justify-between"><span className="text-slate-500">Current supply APY</span><span className="font-semibold text-emerald-300">{position?.supplyApy !== null && position?.supplyApy !== undefined ? `${position.supplyApy.toFixed(2)}%` : "Unavailable"}</span></div><div className="flex justify-between"><span className="text-slate-500">Available liquidity</span><span>{position?.liquidity !== null && position?.liquidity !== undefined ? formatUnits(position.liquidity, asset.decimals) : "Unavailable"} {symbol}</span></div><div className="flex justify-between"><span className="text-slate-500">Protocol</span><span>Aave V3</span></div></div>
            <p className={`mt-4 text-xs ${amountError || action.status === "failed" || lending.isError ? "text-rose-300" : action.status === "confirmed" ? "text-emerald-300" : "text-slate-500"}`}>{statusMessage}</p>
            {approval.required ? <Button className="mt-4 w-full" onClick={() => void approval.approve()} disabled={approval.status === "confirmation" || approval.status === "pending"} icon>{approval.status === "pending" ? "Approval pending..." : approval.status === "confirmation" ? "Confirm in wallet" : `Approve exact ${symbol} amount`}</Button> : <Button className="mt-4 w-full" onClick={() => setShowConfirmation(true)} disabled={!ready || action.status === "pending"} icon>{action.status === "pending" ? "Transaction pending..." : `Review ${operation}`}</Button>}
            {approval.hash && <p className="mt-2 text-xs text-cyan-300">Approval: <a className="underline" href={explorerTxUrl(approval.hash)} target="_blank" rel="noopener noreferrer">{shortAddr(approval.hash)}</a></p>}
            {action.hash && <p className="mt-2 text-xs text-emerald-300">Transaction: <a className="underline" href={explorerTxUrl(action.hash)} target="_blank" rel="noopener noreferrer">{shortAddr(action.hash)}</a></p>}
            {showConfirmation && ready && <div className="mt-4 rounded-xl border border-cyan-300/20 bg-cyan-300/[.05] p-4"><Label>Final confirmation</Label><div className="mt-3 space-y-2 text-xs"><div className="flex justify-between"><span className="text-slate-500">Protocol</span><span>Aave V3</span></div><div className="flex justify-between"><span className="text-slate-500">Operation</span><span>{operation}</span></div><div className="flex justify-between"><span className="text-slate-500">Asset / amount</span><span>{amount} {symbol}</span></div><div className="flex justify-between"><span className="text-slate-500">Network</span><span>Base Mainnet</span></div><div className="flex justify-between"><span className="text-slate-500">Transaction target</span><span>{shortAddr(AAVE_BASE_POOL)}</span></div></div><p className="mt-3 text-[10px] leading-4 text-amber-300">Review the transaction in your wallet before signing. Rates are variable and supplied assets carry smart-contract and market risk.</p><div className="mt-4 flex gap-2"><Button variant="secondary" className="flex-1" onClick={() => setShowConfirmation(false)}>Cancel</Button><Button className="flex-1" onClick={() => { setShowConfirmation(false); void action.execute(); }} icon>Confirm</Button></div></div>}
+          </>}
        </Card>
        <Card className="h-fit p-5"><div className="flex items-center gap-3"><div className="rounded-lg bg-cyan-300/10 p-2 text-cyan-300"><TrendingUp size={18} /></div><div><Label>Live position</Label><h2 className="mt-1 text-lg font-bold">Your Base yield</h2></div></div><div className="mt-6 space-y-4">{[["Supported assets", `${AAVE_BASE_ASSETS.length}`], ["USDC supply APY", lending.position?.assets[0]?.supplyApy !== null && lending.position?.assets[0]?.supplyApy !== undefined ? `${lending.position.assets[0].supplyApy.toFixed(2)}%` : "Unavailable"], ["WETH supply APY", lending.position?.assets[1]?.supplyApy !== null && lending.position?.assets[1]?.supplyApy !== undefined ? `${lending.position.assets[1].supplyApy.toFixed(2)}%` : "Unavailable"], ["Total supplied", lending.position ? "Live onchain position" : "Unavailable"]].map(([label, value], index) => <div key={label} className="flex items-center justify-between border-b border-white/[.06] pb-3 text-xs"><span className="text-slate-500">{label}</span><span className={index > 0 ? "font-semibold text-slate-200" : "font-semibold text-cyan-300"}>{value}</span></div>)}</div><p className="mt-6 text-[11px] leading-5 text-slate-500">Rates, liquidity, and positions are read directly from Aave V3 contracts on Base Mainnet. No estimated or fallback financial data is shown.</p></Card>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { arcTestnet } from 'wagmi/chains';
import { useAccount, useConnect, useSwitchChain } from 'wagmi';
import type { Address } from 'viem';
import { Copy, QrCode, RefreshCw, ShieldCheck, Wallet } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useTransactions } from '../hooks/useTransactions';
import {
  arcPaymentRequestUrl,
  createArcPaymentRequest,
  decodeArcPaymentRequest,
  verifyArcPayment,
  type ArcPaymentRequest,
} from '../services/arcPayment';
import { Button, Card, Label, Pill } from './ui';
import { getPreferredConnector } from '../wallet';

export function ArcPayPage({ onPay }: { onPay: (request: ArcPaymentRequest) => void }) {
  const { address, chainId, isConnected } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const { connectors, connect, isPending: isConnecting } = useConnect();
  const [amount, setAmount] = useState('');
  const [label, setLabel] = useState('');
  const [recipient, setRecipient] = useState(address ?? '');
  const [createdRequest, setCreatedRequest] = useState<ArcPaymentRequest | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const importedRequestResult = useMemo(() => {
    if (typeof window === 'undefined') return { request: null, error: null };
    const encoded = new URLSearchParams(window.location.search).get('arcPay');
    if (!encoded) return { request: null, error: null };
    try {
      return { request: decodeArcPaymentRequest(encoded), error: null };
    } catch (error) {
      return { request: null, error: error instanceof Error ? error.message : 'Invalid Arc payment request' };
    }
  }, []);
  const importedRequest = importedRequestResult.request;
  const decodedRequestError = importedRequestResult.error;
  const displayedRequestError = decodedRequestError;
  const request = importedRequest ?? createdRequest;
  const requestUrl = request ? arcPaymentRequestUrl(request) : '';
  const verificationQuery = useTransactions(
    request?.recipient as Address | undefined,
    Boolean(request) && chainId === arcTestnet.id,
    arcTestnet.id,
  );
  const verification = request
    ? verificationQuery.isError
      ? { status: 'unavailable' as const, matches: [], reason: 'Unable to verify payment' }
      : verificationQuery.isLoading
        ? null
        : verifyArcPayment(request, verificationQuery.transactions, chainId ?? 0)
    : null;

  useEffect(() => {
    if (address && !createdRequest && !importedRequest) setRecipient(address);
  }, [address, createdRequest, importedRequest]);

  const createRequest = () => {
    setCreateError(null);
    try {
      const next = createArcPaymentRequest({ recipient, amount, label });
      setCreatedRequest(next);
      const url = arcPaymentRequestUrl(next);
      window.history.replaceState({}, '', url);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Unable to create payment request');
    }
  };

  const copyRequest = async () => {
    if (!requestUrl) return;
    await navigator.clipboard.writeText(requestUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const connectWallet = () => {
    const connector = getPreferredConnector(connectors);
    if (connector) connect({ connector });
  };

  const statusLabel = verification?.status === 'confirmed'
    ? 'Payment Confirmed'
    : verification?.status === 'detected'
      ? 'Payment Detected'
      : verification?.status === 'not-found'
        ? createdRequest && !importedRequest ? 'Awaiting Payment' : 'Payment Not Found'
    : verification?.status === 'unavailable'
      ? 'Unable to verify payment'
      : 'Awaiting Payment';
  const statusColor = verification?.status === 'confirmed' ? 'green' : verification?.status === 'unavailable' ? 'red' : verification?.status === 'detected' ? 'cyan' : 'amber';

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="page-shell flex flex-wrap items-end justify-between gap-4 rounded-2xl px-4 py-3 sm:px-5">
        <div>
          <Label>Move / Arc Pay</Label>
          <h1 className="mt-2 text-2xl font-extrabold tracking-[-0.04em] text-white sm:text-3xl">USDC Payment Request</h1>
        </div>
        {request && <Pill color={statusColor}>{statusLabel}</Pill>}
      </div>

      {displayedRequestError && (
        <Card className="border border-rose-300/20 bg-rose-300/[.06] p-5 text-sm text-rose-200">
          <p className="font-semibold">Unable to load payment request</p>
          <p className="mt-2">{displayedRequestError}</p>
        </Card>
      )}

      {request ? (
        <div className="grid gap-5 lg:grid-cols-[1fr_0.9fr]">
          <Card className="p-6" glow>
            <div className="flex items-start justify-between gap-3">
              <div>
                <Label>Payment request</Label>
                <h2 className="mt-2 text-2xl font-bold text-white">{request.amount} USDC</h2>
                <p className="mt-1 text-sm text-slate-400">{request.label || 'Arc Testnet payment'}</p>
              </div>
              <div className="rounded-xl bg-cyan-300/10 p-3 text-cyan-200"><QrCode size={20} /></div>
            </div>
            <div className="mt-6 space-y-3 rounded-2xl border border-white/10 bg-white/[.03] p-4 text-sm">
              <div className="flex justify-between gap-4"><span className="text-slate-500">Network</span><span className="font-semibold text-slate-200">Arc Testnet</span></div>
              <div className="flex justify-between gap-4"><span className="text-slate-500">Token</span><span className="font-semibold text-slate-200">USDC</span></div>
              <div><span className="text-slate-500">Recipient</span><p className="mt-1 break-all font-mono text-xs text-slate-300">{request.recipient}</p></div>
            </div>
            {verification?.status === 'confirmed' && (
              <div className="mt-4 rounded-xl border border-emerald-300/20 bg-emerald-300/[.06] p-4 text-sm text-emerald-100">
                <p className="font-semibold">Payment detected and confirmed on Arc.</p>
                <div className="mt-2 space-y-1 font-mono text-xs text-emerald-200/80">
                  {verification.matches.map((match) => <a key={match.hash} href={`https://testnet.arcscan.app/tx/${match.hash}`} target="_blank" rel="noopener noreferrer" className="block underline">{match.hash}</a>)}
                </div>
              </div>
            )}
            {verification?.status === 'detected' && <p className="mt-4 text-sm text-cyan-100">A matching Arc USDC transfer was detected, but the transaction is not confirmed yet.</p>}
            {verification?.status === 'not-found' && <p className="mt-4 text-sm text-slate-400">No matching confirmed payment was found in the current Arc activity response.</p>}
            {verification?.status === 'unavailable' && <p className="mt-4 text-sm text-rose-200">Unable to verify payment. The Arc activity provider did not return reliable evidence.</p>}
            {isConnected && chainId !== arcTestnet.id && <div className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/[.06] p-4 text-sm text-amber-100"><p className="font-semibold">Arc Testnet required</p><p className="mt-1 text-xs text-amber-100/80">Switch networks before paying or verifying this request.</p><Button variant="secondary" className="mt-3" onClick={() => switchChain({ chainId: arcTestnet.id })} disabled={isSwitching}>{isSwitching ? 'Switching...' : 'Switch to Arc Testnet'}</Button></div>}
            <div className="mt-5 flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => void verificationQuery.refetch()} disabled={verificationQuery.isFetching}><RefreshCw size={15} className={verificationQuery.isFetching ? 'animate-spin' : ''} />Refresh verification</Button>
              <Button variant="secondary" onClick={() => void copyRequest()}><Copy size={15} />{copied ? 'Copied' : 'Copy request'}</Button>
              {(verification?.status === 'awaiting' || verification?.status === 'not-found') && <Button onClick={() => { if (!isConnected) connectWallet(); else if (chainId !== arcTestnet.id) switchChain({ chainId: arcTestnet.id }); else onPay(request); }} disabled={isConnecting || isSwitching}>{!isConnected ? 'Connect wallet to pay' : chainId !== arcTestnet.id ? 'Switch to Arc Testnet' : 'Pay request'}</Button>}
            </div>
          </Card>
          <Card className="flex flex-col items-center p-6" glow>
            <Label>Shareable request</Label>
            <div className="mt-5 rounded-2xl bg-white p-4"><QRCodeSVG value={requestUrl} size={220} bgColor="#ffffff" fgColor="#070a11" includeMargin /></div>
            <p className="mt-4 break-all text-center font-mono text-[10px] text-slate-500">{requestUrl}</p>
            <p className="mt-4 text-center text-xs leading-5 text-slate-400">The QR contains the exact Arc Testnet, USDC, amount, recipient, and optional label shown here.</p>
          </Card>
        </div>
      ) : (
        <Card className="p-6" glow>
          <div className="mb-5"><Label>Create / Arc Testnet</Label><h2 className="mt-2 text-xl font-bold">Request Arc USDC</h2><p className="mt-2 text-sm text-slate-400">Create a deterministic request that another wallet can open and pay through ORBIT.</p></div>
          {!isConnected ? <div className="rounded-xl border border-cyan-300/20 bg-cyan-300/[.05] p-5 text-center"><Wallet size={24} className="mx-auto text-cyan-300" /><p className="mt-3 text-sm text-slate-300">Connect a wallet to create a request.</p><Button className="mt-4" onClick={connectWallet} disabled={isConnecting}>Connect wallet</Button></div> : chainId !== arcTestnet.id ? <div className="rounded-xl border border-amber-300/20 bg-amber-300/[.06] p-5"><div className="flex items-center gap-2 text-amber-200"><ShieldCheck size={17} /><span className="text-sm font-semibold">Arc Testnet required</span></div><p className="mt-2 text-xs text-slate-400">Payment requests are Arc-only and use the official Arc USDC contract.</p><Button variant="secondary" className="mt-4" onClick={() => switchChain({ chainId: arcTestnet.id })} disabled={isSwitching}>{isSwitching ? 'Switching...' : 'Switch to Arc Testnet'}</Button></div> : <div className="grid gap-4 md:grid-cols-2"><label className="block"><span className="mb-2 block text-xs font-semibold text-slate-400">Amount</span><div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[.04] px-4"><input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="0.00" className="min-w-0 flex-1 bg-transparent py-3 text-lg font-bold text-white outline-none placeholder:text-slate-600" /><span className="font-mono text-xs text-slate-500">USDC</span></div></label><label className="block"><span className="mb-2 block text-xs font-semibold text-slate-400">Recipient wallet</span><input value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="0x..." className="w-full rounded-xl border border-white/10 bg-white/[.04] px-4 py-3 font-mono text-sm text-white outline-none placeholder:text-slate-600" /></label><label className="block md:col-span-2"><span className="mb-2 block text-xs font-semibold text-slate-400">Merchant label (optional)</span><input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={120} placeholder="e.g. Orbit Coffee" className="w-full rounded-xl border border-white/10 bg-white/[.04] px-4 py-3 text-sm text-white outline-none placeholder:text-slate-600" /></label><div className="md:col-span-2">{createError && <p className="mb-3 text-sm text-rose-200">{createError}</p>}<Button onClick={createRequest}>Generate request</Button></div></div>}
        </Card>
      )}
    </div>
  );
}

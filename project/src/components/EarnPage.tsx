import { ShieldCheck } from 'lucide-react';
import { Card, Label } from './ui';

export function EarnPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Label>Earn / Arc Testnet</Label>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight">Arc yield is not available yet.</h1>
      </div>
      <Card className="p-6" glow>
        <div className="flex items-center gap-2 text-amber-200">
          <ShieldCheck size={17} />
          <span className="text-sm font-semibold">Not available on Arc yet</span>
        </div>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          ORBIT does not expose unverified yield or lending integrations on Arc Testnet.
        </p>
      </Card>
    </div>
  );
}

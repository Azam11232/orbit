export interface DiscoverEcosystem {
  name: string;
  color: string;
  protocolCount: number;
  tvlUsd: number | null;
}

export interface DiscoverOpportunity {
  id: string;
  name: string;
  type: string;
  apy: number;
  tvlUsd: number;
  symbol: string;
  riskSignal: string;
  poolUrl: string;
}

export interface DiscoverData {
  ecosystems: DiscoverEcosystem[];
  opportunities: DiscoverOpportunity[];
}

interface ChainRecord {
  name?: string;
  tvl?: number;
}

interface ProtocolRecord {
  chains?: string[];
}

interface YieldPoolRecord {
  pool?: string;
  project?: string;
  symbol?: string;
  chain?: string;
  tvlUsd?: number;
  apy?: number | null;
  exposure?: string;
  ilRisk?: string;
}

interface ChainResponse extends Array<ChainRecord> {}
interface ProtocolResponse extends Array<ProtocolRecord> {}
interface YieldResponse {
  data?: YieldPoolRecord[];
}

const DEFILLAMA_API = 'https://api.llama.fi';
const DEFILLAMA_YIELDS_API = 'https://yields.llama.fi';
const ECOSYSTEMS = [
  { name: 'Base', color: '#4B8BFF' },
  { name: 'Ethereum', color: '#627EEA' },
  { name: 'Arbitrum', color: '#28A0F0' },
] as const;

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Discover API error: ${response.status}`);
  return response.json() as Promise<T>;
}

function validNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

async function fetchEcosystems(): Promise<DiscoverEcosystem[]> {
  const [chains, protocols] = await Promise.all([
    readJson<ChainResponse>(`${DEFILLAMA_API}/v2/chains`),
    readJson<ProtocolResponse>(`${DEFILLAMA_API}/protocols`),
  ]);

  return ECOSYSTEMS.map((ecosystem) => ({
    ...ecosystem,
    protocolCount: protocols.filter((protocol) => protocol.chains?.includes(ecosystem.name)).length,
    tvlUsd: validNumber(chains.find((chain) => chain.name === ecosystem.name)?.tvl)
      ? chains.find((chain) => chain.name === ecosystem.name)?.tvl ?? null
      : null,
  }));
}

async function fetchOpportunities(): Promise<DiscoverOpportunity[]> {
  const response = await readJson<YieldResponse>(`${DEFILLAMA_YIELDS_API}/pools`);
  const pools = (response.data ?? [])
    .filter((pool) => pool.chain === 'Base')
    .filter((pool) => validNumber(pool.apy) && pool.apy >= 0 && pool.apy <= 1000)
    .filter((pool) => validNumber(pool.tvlUsd) && pool.tvlUsd >= 10_000)
    .sort((first, second) => (second.apy ?? 0) - (first.apy ?? 0))
    .slice(0, 12);

  return pools.flatMap((pool) => {
    if (!pool.pool || !pool.project || !validNumber(pool.apy) || !validNumber(pool.tvlUsd)) return [];
    const riskSignal = [pool.ilRisk, pool.exposure].filter(Boolean).join(' / ') || 'Not reported';
    return [{
      id: pool.pool,
      name: pool.project,
      type: 'Base yield pool',
      apy: pool.apy,
      tvlUsd: pool.tvlUsd,
      symbol: pool.symbol ?? 'Unknown assets',
      riskSignal,
      poolUrl: `https://defillama.com/yields/pool/${encodeURIComponent(pool.pool)}`,
    }];
  });
}

export async function fetchDiscoverData(): Promise<DiscoverData> {
  const [ecosystems, opportunities] = await Promise.all([
    fetchEcosystems(),
    fetchOpportunities(),
  ]);
  return { ecosystems, opportunities };
}

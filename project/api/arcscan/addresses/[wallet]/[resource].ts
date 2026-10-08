const ARC_SCAN_API_BASE_URL = 'https://testnet.arcscan.app/api/v2';
const WALLET_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const ALLOWED_RESOURCES = new Set(['transactions', 'token-transfers']);
const TRANSACTION_PAGE_PARAMS = new Set(['index', 'value', 'hash', 'inserted_at', 'block_number', 'fee']);
const TRANSFER_PAGE_PARAMS = new Set(['index', 'block_number']);
const PAGE_PARAM_PATTERNS: Record<string, RegExp> = {
  index: /^\d+$/,
  value: /^\d+$/,
  hash: /^0x[a-fA-F0-9]{64}$/,
  inserted_at: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
  block_number: /^\d+$/,
  fee: /^\d+$/,
};

interface VercelRequest {
  method?: string;
  url?: string;
  query?: {
    wallet?: string | string[];
    resource?: string | string[];
  };
}

interface VercelResponse {
  status(code: number): VercelResponse;
  setHeader(name: string, value: string): VercelResponse;
  json(body: unknown): VercelResponse;
  send(body: string): VercelResponse;
}

function isValidPaginationQuery(searchParams: URLSearchParams, resource: string): boolean {
  const cursorParams = resource === 'transactions' ? TRANSACTION_PAGE_PARAMS : TRANSFER_PAGE_PARAMS;
  const allowedParams = new Set(['items_count', ...cursorParams]);
  const seenParams = new Set<string>();
  let valid = true;

  searchParams.forEach((value, key) => {
    if (key === 'wallet' || key === 'resource') {
      return;
    }

    if (
      !allowedParams.has(key) ||
      seenParams.has(key) ||
      (key === 'items_count' ? value !== '20' : !PAGE_PARAM_PATTERNS[key].test(value))
    ) {
      valid = false;
    }
    seenParams.add(key);
  });

  return valid && seenParams.has('items_count');
}

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  if (request.method !== 'GET') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const requestUrl = new URL(request.url ?? '/', 'https://orbit.local');
  const pathParts = requestUrl.pathname.split('/').filter(Boolean);
  const pathAddress = pathParts[pathParts.length - 2];
  const pathResource = pathParts[pathParts.length - 1];
  const address =
    typeof request.query?.wallet === 'string'
      ? request.query.wallet
      : request.query?.wallet === undefined
        ? pathAddress
        : undefined;
  const resource =
    typeof request.query?.resource === 'string'
      ? request.query.resource
      : request.query?.resource === undefined
        ? pathResource
        : undefined;

  if (!address || !WALLET_ADDRESS_PATTERN.test(address) || !resource || !ALLOWED_RESOURCES.has(resource)) {
    response.status(400).json({ error: 'Invalid ArcScan transaction request' });
    return;
  }

  if (!isValidPaginationQuery(requestUrl.searchParams, resource)) {
    response.status(400).json({ error: 'Invalid ArcScan transaction request' });
    return;
  }

  const upstreamParams = new URLSearchParams();
  requestUrl.searchParams.forEach((value, key) => upstreamParams.set(key, value));
  const upstreamUrl = `${ARC_SCAN_API_BASE_URL}/addresses/${address}/${resource}?${upstreamParams}`;

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      headers: { Accept: 'application/json' },
    });
    const body = await upstreamResponse.text();

    response
      .status(upstreamResponse.status)
      .setHeader('Content-Type', upstreamResponse.headers.get('content-type') ?? 'application/json')
      .send(body);
  } catch {
    response.status(502).json({ error: 'Unable to reach ArcScan' });
  }
}

const ARC_SCAN_API_BASE_URL = 'https://explorer.testnet.arc.io/api/v2';
const WALLET_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const ALLOWED_RESOURCES = new Set(['transactions', 'token-transfers', 'contract-info']);
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

function invalidPaginationParameter(searchParams: URLSearchParams, resource: string): string | undefined {
  const cursorParams = resource === 'transactions' ? TRANSACTION_PAGE_PARAMS : TRANSFER_PAGE_PARAMS;
  const allowedParams = new Set(['items_count', ...cursorParams]);
  const seenParams = new Set<string>();
  for (const [key, value] of searchParams.entries()) {
    if (!allowedParams.has(key)) return `Unsupported query parameter "${key}".`;
    if (seenParams.has(key)) return `Duplicate query parameter "${key}".`;
    seenParams.add(key);
    if (key === 'items_count' && value !== '20') return 'items_count must be 20.';
    if (key !== 'items_count' && !PAGE_PARAM_PATTERNS[key].test(value)) {
      return `Invalid value for query parameter "${key}".`;
    }
  }
  return seenParams.has('items_count') ? undefined : 'items_count is required.';
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
  const address = pathAddress;
  const resource = pathResource;

  if (!address || !WALLET_ADDRESS_PATTERN.test(address) || !resource || !ALLOWED_RESOURCES.has(resource)) {
    response.status(400).json({
      error: 'Invalid ArcScan transaction request',
      details: 'Expected a valid address and supported resource in the request path.',
    });
    return;
  }

  if (resource === 'contract-info') {
    if (requestUrl.searchParams.toString() !== '') {
      response.status(400).json({
        error: 'Invalid ArcScan transaction request',
        details: 'Contract verification does not accept query parameters.',
      });
      return;
    }
  } else {
    const invalidParameter = invalidPaginationParameter(requestUrl.searchParams, resource);
    if (invalidParameter) {
      response.status(400).json({
        error: 'Invalid ArcScan transaction request',
        details: invalidParameter,
      });
      return;
    }
  }

  const upstreamParams = new URLSearchParams();
  requestUrl.searchParams.forEach((value, key) => {
    if (key !== 'wallet' && key !== 'resource') {
      upstreamParams.set(key, value);
    }
  });
  const upstreamPath = resource === 'contract-info'
    ? `addresses/${address}`
    : `addresses/${address}/${resource}`;
  const upstreamUrl = new URL(upstreamPath, `${ARC_SCAN_API_BASE_URL}/`);
  upstreamUrl.search = upstreamParams.toString();

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      headers: { Accept: 'application/json' },
    });
    const body = await upstreamResponse.text();

    response.status(upstreamResponse.status);
    response.setHeader('Content-Type', upstreamResponse.headers.get('content-type') ?? 'application/json');
    const retryAfter = upstreamResponse.headers.get('retry-after');
    if (retryAfter) response.setHeader('Retry-After', retryAfter);
    response.send(body);
  } catch {
    response.status(502).json({ error: 'Unable to reach ArcScan' });
  }
}

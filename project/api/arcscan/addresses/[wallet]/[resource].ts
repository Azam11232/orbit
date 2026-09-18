const ARC_SCAN_API_BASE_URL = 'https://testnet.arcscan.app/api/v2';
const WALLET_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const ALLOWED_RESOURCES = new Set(['transactions', 'token-transfers']);

interface VercelRequest {
  method?: string;
  url?: string;
}

interface VercelResponse {
  status(code: number): VercelResponse;
  setHeader(name: string, value: string): VercelResponse;
  json(body: unknown): VercelResponse;
  send(body: string): VercelResponse;
}

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  if (request.method !== 'GET') {
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const requestUrl = new URL(request.url ?? '/', 'https://orbit.local');
  const pathParts = requestUrl.pathname.split('/').filter(Boolean);
  const address = pathParts.at(-2);
  const resource = pathParts.at(-1);

  if (!address || !WALLET_ADDRESS_PATTERN.test(address) || !resource || !ALLOWED_RESOURCES.has(resource)) {
    response.status(400).json({ error: 'Invalid ArcScan transaction request' });
    return;
  }

  if (requestUrl.searchParams.get('items_count') !== '20') {
    response.status(400).json({ error: 'Invalid ArcScan transaction request' });
    return;
  }

  const upstreamUrl = `${ARC_SCAN_API_BASE_URL}/addresses/${address}/${resource}?items_count=20`;

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

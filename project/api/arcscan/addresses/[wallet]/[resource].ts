const ARC_SCAN_API_BASE_URL = 'https://testnet.arcscan.app/api/v2';
const WALLET_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const ALLOWED_RESOURCES = new Set(['transactions', 'token-transfers']);

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const requestUrl = new URL(request.url);
  const pathParts = requestUrl.pathname.split('/').filter(Boolean);
  const address = pathParts.at(-2);
  const resource = pathParts.at(-1);

  if (!address || !WALLET_ADDRESS_PATTERN.test(address) || !resource || !ALLOWED_RESOURCES.has(resource)) {
    return Response.json({ error: 'Invalid ArcScan transaction request' }, { status: 400 });
  }

  if (requestUrl.searchParams.get('items_count') !== '20') {
    return Response.json({ error: 'Invalid ArcScan transaction request' }, { status: 400 });
  }

  const upstreamUrl = `${ARC_SCAN_API_BASE_URL}/addresses/${address}/${resource}?items_count=20`;

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      headers: { Accept: 'application/json' },
    });
    const body = await upstreamResponse.text();

    return new Response(body, {
      status: upstreamResponse.status,
      headers: {
        'Content-Type': upstreamResponse.headers.get('content-type') ?? 'application/json',
      },
    });
  } catch {
    return Response.json({ error: 'Unable to reach ArcScan' }, { status: 502 });
  }
}

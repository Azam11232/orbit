import { afterEach, describe, expect, it, vi } from 'vitest';
import handler from './[resource]';

const address = '0x3600000000000000000000000000000000000000';

function responseRecorder() {
  const state: {
    statusCode?: number;
    headers: Record<string, string>;
    body?: string;
  } = { headers: {} };
  const response = {
    status(code: number) {
      state.statusCode = code;
      return response;
    },
    setHeader(name: string, value: string) {
      state.headers[name.toLowerCase()] = value;
      return response;
    },
    json(body: unknown) {
      state.body = JSON.stringify(body);
      return response;
    },
    send(body: string) {
      state.body = body;
      return response;
    },
  };
  return { response, state };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ArcScan contract-info proxy', () => {
  it('uses the live supported address endpoint and returns verified metadata', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ is_contract: true, is_verified: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = responseRecorder();

    await handler({
      method: 'GET',
      url: `/api/arcscan/addresses/${address}/contract-info`,
      query: { wallet: address, resource: 'contract-info' },
    }, response);

    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://explorer.testnet.arc.io/api/v2/addresses/${address}`);
    expect(options).toEqual({ headers: { Accept: 'application/json' } });
    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body ?? '')).toEqual({ is_contract: true, is_verified: true });
  });

  it('does not let query fields override the address and resource from the route path', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ is_contract: true, is_verified: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = responseRecorder();

    await handler({
      method: 'GET',
      url: `/api/arcscan/addresses/${address}/contract-info`,
      query: { wallet: ['invalid'], resource: ['transactions'] },
    }, response);

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `https://explorer.testnet.arc.io/api/v2/addresses/${address}`,
    );
    expect(state.statusCode).toBe(200);
  });

  it('forwards live ArcScan transaction cursor fields without changing their values', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ items: [], next_page_params: null }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const params = new URLSearchParams({
      items_count: '20',
      index: '1',
      value: '0',
      hash: `0x${'a'.repeat(64)}`,
      inserted_at: '2026-05-20T12:34:56.000000Z',
      block_number: '123',
      fee: '0',
    });
    const { response, state } = responseRecorder();

    await handler({
      method: 'GET',
      url: `/api/arcscan/addresses/${address}/transactions?${params.toString()}`,
    }, response);

    const upstreamUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(upstreamUrl.origin).toBe('https://explorer.testnet.arc.io');
    expect(upstreamUrl.pathname).toBe(`/api/v2/addresses/${address}/transactions`);
    expect(upstreamUrl.searchParams.toString()).toBe(params.toString());
    expect(state.statusCode).toBe(200);
  });

  it('returns the specific local validation reason for an unsupported cursor field', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { response, state } = responseRecorder();

    await handler({
      method: 'GET',
      url: `/api/arcscan/addresses/${address}/transactions?items_count=20&unsupported=1`,
    }, response);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body ?? '')).toEqual({
      error: 'Invalid ArcScan transaction request',
      details: 'Unsupported query parameter "unsupported".',
    });
  });

  it('passes upstream HTTP 400 responses through with their diagnostic body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ message: 'Invalid address request' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )));
    const { response, state } = responseRecorder();

    await handler({
      method: 'GET',
      url: `/api/arcscan/addresses/${address}/contract-info`,
      query: { wallet: address, resource: 'contract-info' },
    }, response);

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body ?? '')).toEqual({ message: 'Invalid address request' });
  });

  it('passes upstream rate limits and Retry-After through to the caller', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ message: 'rate limit exceeded' }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '2' } },
    )));
    const { response, state } = responseRecorder();

    await handler({
      method: 'GET',
      url: `/api/arcscan/addresses/${address}/contract-info`,
      query: { wallet: address, resource: 'contract-info' },
    }, response);

    expect(state.statusCode).toBe(429);
    expect(state.headers['retry-after']).toBe('2');
    expect(JSON.parse(state.body ?? '')).toEqual({ message: 'rate limit exceeded' });
  });
});

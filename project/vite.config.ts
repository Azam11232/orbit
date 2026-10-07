import { defineConfig, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as {
  version?: string;
};

const ARC_SCAN_PROXY_PREFIX = '/api/arcscan';
const ARC_SCAN_API_BASE_URL = 'https://testnet.arcscan.app/api/v2';
const ARC_SCAN_ADDRESS_PATH = /^\/api\/arcscan\/addresses\/(0x[a-fA-F0-9]{40})\/(transactions|token-transfers)$/;
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

function isValidPaginationQuery(searchParams: URLSearchParams, resource: string): boolean {
  const cursorParams = resource === 'transactions' ? TRANSACTION_PAGE_PARAMS : TRANSFER_PAGE_PARAMS;
  const allowedParams = new Set(['items_count', ...cursorParams]);
  const seenParams = new Set<string>();
  let valid = true;

  searchParams.forEach((value, key) => {
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

function arcScanProxy(): Plugin {
  const middleware: Connect.HandleFunction = async (request, response, next) => {
    const requestUrl = request.url ?? '';
    if (!requestUrl.startsWith(ARC_SCAN_PROXY_PREFIX)) {
      next();
      return;
    }

    const parsedUrl = new URL(requestUrl, 'http://localhost');
    const match = parsedUrl.pathname.match(ARC_SCAN_ADDRESS_PATH);
    if (!match || !isValidPaginationQuery(parsedUrl.searchParams, match[2])) {
      response.statusCode = 400;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ error: 'Invalid ArcScan transaction request' }));
      return;
    }

    const [, address, resource] = match;
    const upstreamParams = new URLSearchParams();
    parsedUrl.searchParams.forEach((value, key) => upstreamParams.set(key, value));
    const upstreamUrl = `${ARC_SCAN_API_BASE_URL}/addresses/${address}/${resource}?${upstreamParams}`;

    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        headers: { Accept: 'application/json' },
      });
      const body = await upstreamResponse.text();
      response.statusCode = upstreamResponse.status;
      response.setHeader('Content-Type', upstreamResponse.headers.get('content-type') ?? 'application/json');
      response.end(body);
    } catch {
      response.statusCode = 502;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ error: 'Unable to reach ArcScan' }));
    }
  };

  return {
    name: 'arcscan-transaction-proxy',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), arcScanProxy()],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version ?? '1.0.0'),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
});

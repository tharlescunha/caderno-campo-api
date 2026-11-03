/** The only thing the providers need from the network. Tests pass a fake one. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export const BROWSER_HEADERS = {
  'accept-language': 'pt-BR,pt;q=0.9',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * GET/POST with a timeout and one extra try after a short wait (docs/mercado-provedores.md, section 4).
 * A 4xx answer is returned as is (no retry); network errors and 5xx are retried once.
 */
export async function request(
  fetcher: Fetcher,
  url: string,
  init: RequestInit = {},
  options: { timeoutMs?: number; retries?: number; waitMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 15000, retries = 1, waitMs = 500 } = options;
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (response.status < 500) return response;
      last = new ProviderError(`HTTP ${response.status}`, response.status);
    } catch (e) {
      last = e;
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, waitMs));
  }
  throw last instanceof ProviderError ? last : new ProviderError(`No connection: ${(last as Error)?.message ?? 'unknown error'}`);
}

export async function getJson<T>(fetcher: Fetcher, url: string, init: RequestInit = {}, options = {}): Promise<T> {
  const response = await request(fetcher, url, init, options);
  if (!response.ok) throw new ProviderError(`HTTP ${response.status}`, response.status);
  return (await response.json()) as T;
}

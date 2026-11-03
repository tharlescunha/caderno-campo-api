import { getJson, ProviderError, type Fetcher } from './http.js';

const URL = 'https://scanner.tradingview.com/forex/scan';

export interface Dollar {
  pair: 'USD/BRL';
  value: number;
  change_abs: number;
  change_pct: number;
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

/** USD/BRL from the TradingView scanner (an unofficial route: it may change without notice). */
export async function fetchDollar(fetcher: Fetcher): Promise<Dollar> {
  const body = await getJson<{ data?: { d: [number, number, number] }[] }>(fetcher, URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbols: { tickers: ['FX_IDC:USDBRL'] }, columns: ['close', 'change_abs', 'change'] }),
  });
  const row = body.data?.[0]?.d;
  if (!row) throw new ProviderError('TradingView answered without the USD/BRL row');
  const [value, changeAbs, changePct] = row;
  return { pair: 'USD/BRL', value: round(value, 4), change_abs: round(changeAbs, 4), change_pct: round(changePct, 2) };
}

import { BROWSER_HEADERS, getJson, type Fetcher } from './http.js';

const BASE_URL = 'https://www.agrolink.com.br/api/cotacoes/busca/lista';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Agrolink slugs. Price is R$ per 60 kg bag. */
export const PRODUCTS = { soy: 'soja-em-grao-sc-60kg', corn: 'milho-seco-sc-60kg' } as const;
export type Product = keyof typeof PRODUCTS;
export const PRODUCT_DB: Record<Product, string> = { soy: 'soja', corn: 'milho' };

export interface Quote {
  date: string; // YYYY-MM-DD
  price: number;
  change_pct: number;
  updated_at: string; // ISO UTC
  frequency: string;
}

export interface CityRef {
  uf: string;
  city: string;
  /** "to/palmas": what Agrolink wants in the `cidade` parameter */
  key: string;
}

/** "Palmas-TO" -> { uf: "to", city: "palmas" }. Lowercase, no accents, spaces become hyphens. */
export function cityRef(label: string): CityRef {
  const match = /^(.+)-([A-Za-z]{2})$/.exec(label.trim());
  const name = match ? match[1]! : 'Palmas';
  const uf = (match ? match[2]! : 'TO').toLowerCase();
  const city = name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-');
  return { uf, city, key: `${uf}/${city}` };
}

interface AgrolinkRow {
  preco: number;
  variacaoPct: number;
  freq: string;
  dia: number; // days since 1970-01-01
  favKey: string;
  atualizacaoMs: number; // ms since 1970, UTC
}

interface AgrolinkPage {
  soltos: { linhas: AgrolinkRow[]; totalPaginas: number };
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Quotes of one product in one city between two dates, newest first. Reads every page (30 rows each). */
export async function fetchQuotes(
  fetcher: Fetcher,
  product: Product,
  ref: CityRef,
  from: Date,
  to: Date,
  timeoutMs = 30000,
): Promise<Quote[]> {
  const slug = PRODUCTS[product];
  const rows: AgrolinkRow[] = [];
  for (let page = 1; ; page++) {
    const params = new URLSearchParams({
      pagina: String(page),
      formato: 'solta',
      produto: slug,
      uf: ref.uf,
      cidade: ref.key,
      de: isoDay(from),
      ate: isoDay(to),
    });
    const body = await getJson<AgrolinkPage>(
      fetcher,
      `${BASE_URL}?${params}`,
      { headers: { accept: 'application/json', ...BROWSER_HEADERS } },
      { timeoutMs },
    );
    rows.push(...body.soltos.linhas);
    if (page >= body.soltos.totalPaginas) break;
  }
  return (
    rows
      // a wrong slug makes Agrolink answer with every product: keep only the one asked for
      .filter((r) => r.favKey.startsWith(`${slug}|`))
      .map((r) => ({
        date: isoDay(new Date(r.dia * DAY_MS)),
        price: r.preco,
        change_pct: Math.round(r.variacaoPct * 100) / 100,
        updated_at: new Date(r.atualizacaoMs).toISOString(),
        frequency: r.freq,
      }))
      .sort((a, b) => b.date.localeCompare(a.date))
  );
}

/** Latest quote of soy and corn (searches the last `days` and keeps the newest of each). */
export async function fetchLatestQuotes(fetcher: Fetcher, ref: CityRef, now = new Date(), days = 7) {
  const from = new Date(now.getTime() - days * DAY_MS);
  const [soy, corn] = await Promise.all([fetchQuotes(fetcher, 'soy', ref, from, now), fetchQuotes(fetcher, 'corn', ref, from, now)]);
  return { soy: soy[0] ?? null, corn: corn[0] ?? null };
}

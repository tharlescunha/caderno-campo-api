import type { Pool, RowDataPacket } from 'mysql2/promise';
import { cityRef, fetchLatestQuotes, fetchQuotes, PRODUCT_DB, type CityRef, type Product, type Quote } from './agrolink.js';
import { fetchDollar, type Dollar } from './dollar.js';
import type { Fetcher } from './http.js';
import { fetchArticle, fetchNewsList, NewsNotFoundError, type Article, type NewsItem } from './news.js';
import { fetchWeather, type Weather } from './weather.js';

export interface MarketOptions {
  openWeatherKey?: string | undefined;
  defaultLatitude: number;
  defaultLongitude: number;
  log?: { error: (msg: string) => void };
}

/** One source of the summary: the value, whether it is an old copy, and the error that made it old. */
export interface Block<T> {
  value: T | null;
  stale: boolean;
  updatedAt: string | null;
  error?: string;
}

// Validities of docs/mercado-provedores.md, section 4
const TTL = { quotes: 15 * 60, dollar: 5 * 60, weather: 15 * 60, news: 30 * 60, article: 7 * 24 * 3600 };

/** Coordinates rounded to 2 decimals (about 1 km) share one cache entry: "clima:-10.19:-48.31". */
export const roundCoordinate = (n: number) => n.toFixed(2);

export class MarketService {
  private readonly inFlight = new Map<string, Promise<Block<unknown>>>();

  constructor(
    private readonly pool: Pool,
    private readonly fetcher: Fetcher,
    private readonly options: MarketOptions,
  ) {}

  get defaultLocation() {
    return { latitude: this.options.defaultLatitude, longitude: this.options.defaultLongitude };
  }

  // ---- cache --------------------------------------------------------------------------------------------

  /**
   * Fresh cache -> as is. Otherwise ask the provider; if it fails, answer with the last copy and `stale: true`
   * (the app shows "updated at …"). Only when there never was data is the value null, with the error.
   * Concurrent calls for the same key share one request.
   */
  private cached<T>(key: string, ttlSeconds: number, load: () => Promise<T>, force = false): Promise<Block<T>> {
    const running = this.inFlight.get(key);
    if (running) return running as Promise<Block<T>>;
    const promise = this.read(key, ttlSeconds, load, force).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise as Promise<Block<unknown>>);
    return promise;
  }

  private async read<T>(key: string, ttlSeconds: number, load: () => Promise<T>, force: boolean): Promise<Block<T>> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT conteudo, atualizado_em, expira_em > NOW(3) AS fresh FROM mercado_cache WHERE chave = ?',
      [key],
    );
    const row = rows[0];
    const old = row ? (typeof row.conteudo === 'string' ? (JSON.parse(row.conteudo) as T) : (row.conteudo as T)) : null;
    const oldAt = row ? new Date(`${(row.atualizado_em as string).replace(' ', 'T')}Z`).toISOString() : null;
    if (row && row.fresh === 1 && !force) return { value: old, stale: false, updatedAt: oldAt };

    try {
      const value = await load();
      await this.pool.query(
        `INSERT INTO mercado_cache (chave, conteudo, expira_em, atualizado_em) VALUES (?, ?, DATE_ADD(NOW(3), INTERVAL ? SECOND), NOW(3))
         ON DUPLICATE KEY UPDATE conteudo = VALUES(conteudo), expira_em = VALUES(expira_em), atualizado_em = VALUES(atualizado_em)`,
        [key, JSON.stringify(value), ttlSeconds],
      );
      return { value, stale: false, updatedAt: new Date().toISOString() };
    } catch (e) {
      if (e instanceof NewsNotFoundError) throw e;
      const message = (e as Error).message;
      this.options.log?.error(`market ${key}: ${message}`);
      return { value: old, stale: old !== null, updatedAt: oldAt, error: message };
    }
  }

  // ---- sources ------------------------------------------------------------------------------------------

  quotes(cityLabel: string, force = false): Promise<Block<{ soy: Quote | null; corn: Quote | null }>> {
    const ref = cityRef(cityLabel);
    return this.cached(`cotacao:${ref.key}`, TTL.quotes, () => fetchLatestQuotes(this.fetcher, ref), force);
  }

  dollar(force = false): Promise<Block<Dollar>> {
    return this.cached('dolar', TTL.dollar, () => fetchDollar(this.fetcher), force);
  }

  weather(latitude: number, longitude: number, force = false): Promise<Block<Weather>> {
    const key = `clima:${roundCoordinate(latitude)}:${roundCoordinate(longitude)}`;
    return this.cached(key, TTL.weather, () => fetchWeather(this.fetcher, this.options.openWeatherKey, latitude, longitude), force);
  }

  news(force = false): Promise<Block<NewsItem[]>> {
    return this.cached('noticias', TTL.news, () => fetchNewsList(this.fetcher), force);
  }

  /** A full article. A missing one is not cached and reaches the caller as NewsNotFoundError (the route answers 404). */
  article(id: string): Promise<Block<Article>> {
    return this.cached(`noticia:${id}`, TTL.article, () => fetchArticle(this.fetcher, id));
  }

  /**
   * The weather now at a place for a new entry, or null if the provider is slow or down (the entry stays
   * "pending" and the scheduler fills it in). A field user never waits more than `waitMs`.
   */
  async currentWeather(latitude: number, longitude: number, waitMs = 8000): Promise<Weather | null> {
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs).unref());
    const block = await Promise.race([this.weather(latitude, longitude), timeout]);
    return block?.value ?? null;
  }

  // ---- history ------------------------------------------------------------------------------------------

  /** Saves quotes in `mercado_cotacao`. Repeating is safe (unique on product, city, date). */
  async storeQuotes(cityLabel: string, product: Product, quotes: Quote[]): Promise<number> {
    for (const q of quotes) {
      await this.pool.query(
        `INSERT INTO mercado_cotacao (produto, cidade, data, preco, variacao_pct, atualizado_em) VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE preco = VALUES(preco), variacao_pct = VALUES(variacao_pct), atualizado_em = VALUES(atualizado_em)`,
        [PRODUCT_DB[product], cityLabel, q.date, q.price, q.change_pct, new Date(q.updated_at)],
      );
    }
    return quotes.length;
  }

  /** Fetches the last `days` days of both products and stores them. */
  async collectQuotes(cityLabel: string, days: number): Promise<number> {
    const ref: CityRef = cityRef(cityLabel);
    const now = new Date();
    const from = new Date(now.getTime() - days * 24 * 3600 * 1000);
    let total = 0;
    for (const product of ['soy', 'corn'] as const) {
      total += await this.storeQuotes(cityLabel, product, await fetchQuotes(this.fetcher, product, ref, from, now));
    }
    return total;
  }

  async history(cityLabel: string, days: number, product?: Product) {
    const result: Record<Product, { date: string; price: number; change_pct: number | null }[]> = { soy: [], corn: [] };
    const products = product ? [product] : (['soy', 'corn'] as const);
    for (const p of products) {
      const [rows] = await this.pool.query<RowDataPacket[]>(
        `SELECT data, preco, variacao_pct FROM mercado_cotacao WHERE produto = ? AND cidade = ? AND data >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ORDER BY data`,
        [PRODUCT_DB[p], cityLabel, days],
      );
      result[p] = rows.map((r) => ({
        date: r.data as string,
        price: Number(r.preco),
        change_pct: r.variacao_pct == null ? null : Number(r.variacao_pct),
      }));
    }
    return result;
  }

  async hasHistory(cityLabel: string): Promise<boolean> {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT 1 FROM mercado_cotacao WHERE cidade = ? LIMIT 1', [cityLabel]);
    return rows.length > 0;
  }
}

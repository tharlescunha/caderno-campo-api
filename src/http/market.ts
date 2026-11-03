import type { FastifyPluginAsync } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { pageOf } from '../lib/common.js';
import { type Product } from '../market/agrolink.js';
import { NewsNotFoundError } from '../market/news.js';
import type { Block, MarketService } from '../market/service.js';
import { ApiError, validate } from './errors.js';
import { requireAuth } from './require-auth.js';

/** How many news items `GET /market/summary` carries (the app shows 10 on the market tab, 1 on the home screen). */
const SUMMARY_NEWS = 10;

const latitude = z.coerce.number().min(-90).max(90);
const longitude = z.coerce.number().min(-180).max(180);

export const summaryQuery = z.object({ lat: latitude.optional(), lon: longitude.optional() });
export const weatherQuery = z.object({ lat: latitude, lon: longitude });
export const historyQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  product: z.enum(['soy', 'corn']).optional(),
});
export const newsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(30).default(10),
});

const unavailable = (what: string, error?: string) =>
  new ApiError(502, 'provider_unavailable', `${what} is unavailable right now.${error ? ` (${error})` : ''}`);

/** For the summary: the value plus how old it is. A source that never worked is null with its error. */
function meta<T>(block: Block<T>) {
  return { stale: block.stale, updated_at: block.updatedAt, ...(block.error ? { error: block.error } : {}) };
}

export const marketRoutes =
  (ctx: AppContext, market: MarketService): FastifyPluginAsync =>
  async (app) => {
    const { pool } = ctx;
    app.addHook('preHandler', requireAuth(ctx));

    /** The user's quote city and default place for the weather. */
    async function preferences(userId: string) {
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT cidade_cotacoes, latitude_padrao, longitude_padrao FROM usuario WHERE id = ?',
        [userId],
      );
      const r = rows[0];
      const fallback = market.defaultLocation;
      return {
        city: (r?.cidade_cotacoes as string | undefined) ?? 'Palmas-TO',
        location:
          r?.latitude_padrao == null || r?.longitude_padrao == null
            ? fallback
            : { latitude: Number(r.latitude_padrao), longitude: Number(r.longitude_padrao) },
      };
    }

    // All four sources in parallel; a failure of one never takes down the others.
    app.get('/market/summary', async (req) => {
      const q = validate(summaryQuery, req.query);
      if ((q.lat === undefined) !== (q.lon === undefined)) {
        throw new ApiError(422, 'validation', 'Some fields are invalid.', [{ field: 'lon', message: 'Send lat and lon together.' }]);
      }
      const prefs = await preferences(req.userId);
      const spot = q.lat !== undefined && q.lon !== undefined ? { latitude: q.lat, longitude: q.lon } : prefs.location;
      const [quotes, dollar, weather, news] = await Promise.all([
        market.quotes(prefs.city),
        market.dollar(),
        market.weather(spot.latitude, spot.longitude),
        market.news(),
      ]);
      return {
        city: prefs.city,
        quotes: quotes.value,
        dollar: dollar.value,
        weather: weather.value,
        news: news.value?.slice(0, SUMMARY_NEWS) ?? null,
        sources: { quotes: meta(quotes), dollar: meta(dollar), weather: meta(weather), news: meta(news) },
      };
    });

    // Read from the history the server keeps, not from the provider.
    app.get('/market/history', async (req) => {
      const q = validate(historyQuery, req.query);
      const prefs = await preferences(req.userId);
      // first time for this city (for example a user created after the server started): load the last 90 days now
      if (!(await market.hasHistory(prefs.city))) await market.collectQuotes(prefs.city, 90).catch(() => 0);
      const series = await market.history(prefs.city, q.days, q.product as Product | undefined);
      const stats = (points: { price: number }[]) =>
        points.length
          ? {
              max: Math.max(...points.map((p) => p.price)),
              min: Math.min(...points.map((p) => p.price)),
              average: Math.round((points.reduce((s, p) => s + p.price, 0) / points.length) * 100) / 100,
              change_pct: Math.round(((points.at(-1)!.price - points[0]!.price) / points[0]!.price) * 10000) / 100,
            }
          : null;
      const to = new Date();
      const from = new Date(to.getTime() - q.days * 24 * 3600 * 1000);
      return {
        city: prefs.city,
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
        quotes: Object.fromEntries(Object.entries(series).filter(([key]) => !q.product || key === q.product)),
        summary: Object.fromEntries(
          Object.entries(series)
            .filter(([key]) => !q.product || key === q.product)
            .map(([key, points]) => [key, stats(points)]),
        ),
      };
    });

    app.get('/market/news', async (req) => {
      const q = validate(newsQuery, req.query);
      const news = await market.news();
      if (!news.value) throw unavailable('The news list', news.error);
      const start = (q.page - 1) * q.limit;
      return { ...pageOf(news.value.slice(start, start + q.limit), q.page, q.limit, news.value.length), ...meta(news) };
    });

    app.get<{ Params: { id: string } }>('/market/news/:id', async (req) => {
      try {
        const article = await market.article(req.params.id);
        if (!article.value) throw unavailable('The article', article.error);
        return { ...article.value, ...meta(article) };
      } catch (e) {
        if (e instanceof NewsNotFoundError) throw new ApiError(404, 'not_found', 'News article not found.');
        throw e;
      }
    });

    app.get('/weather', async (req) => {
      const q = validate(weatherQuery, req.query);
      const weather = await market.weather(q.lat, q.lon);
      if (!weather.value) throw unavailable('The weather', weather.error);
      return { ...weather.value, ...meta(weather) };
    });
  };

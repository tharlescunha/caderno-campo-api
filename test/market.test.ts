import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cityRef, fetchQuotes } from '../src/market/agrolink.js';
import { fetchDollar } from '../src/market/dollar.js';
import type { Fetcher } from '../src/market/http.js';
import { fetchArticle, fetchNewsList, NewsNotFoundError } from '../src/market/news.js';
import { MarketScheduler } from '../src/market/scheduler.js';
import { MarketService } from '../src/market/service.js';
import { fetchWeather } from '../src/market/weather.js';
import { FakeNetwork, fixture } from './fake-network.js';
import { createTestApp, createTestDatabase, registerUser, type TestDatabase, type TestUser } from './helpers.js';

const soyPage = JSON.parse(fixture('agrolink-soy.json'));

describe('providers (recorded answers)', () => {
  const net = new FakeNetwork();

  it('city label -> Agrolink reference', () => {
    expect(cityRef('Palmas-TO')).toEqual({ uf: 'to', city: 'palmas', key: 'to/palmas' });
    expect(cityRef('São José do Rio Preto-SP').key).toBe('sp/sao-jose-do-rio-preto');
    expect(cityRef('whatever').key).toBe('to/palmas'); // unreadable label falls back to the default
  });

  it('quotes: converts day number and ms, rounds, newest first, one product only', async () => {
    const q = await fetchQuotes(net.fetch, 'soy', cityRef('Palmas-TO'), new Date('2026-10-01'), new Date('2026-11-02'));
    expect(q.length).toBe(soyPage.soltos.linhas.length);
    expect(q[0]).toMatchObject({ date: '2026-11-02', price: 146, change_pct: -0.68 });
    expect(q[0]!.updated_at).toBe('2026-10-30T13:56:00.000Z');
    expect(q.map((x) => x.date)).toEqual([...q.map((x) => x.date)].sort().reverse());
    expect(net.calls.at(-1)).toContain('cidade=to%2Fpalmas');
    expect(net.calls.at(-1)).toContain('produto=soja-em-grao-sc-60kg');
  });

  it('quotes: reads every page and drops rows of another product (wrong slug case)', async () => {
    const rows = soyPage.soltos.linhas;
    const stranger = { ...rows[0], favKey: 'milho-seco-sc-60kg|to|palmas|a-vista', preco: 1 };
    const pages = [
      { soltos: { linhas: rows.slice(0, 10), totalPaginas: 2 } },
      { soltos: { linhas: [...rows.slice(10), stranger], totalPaginas: 2 } },
    ];
    const seen: string[] = [];
    const paged: Fetcher = async (url) => {
      seen.push(new URL(url).searchParams.get('pagina')!);
      return new Response(JSON.stringify(pages[seen.length - 1]), { status: 200 });
    };
    const q = await fetchQuotes(paged, 'soy', cityRef('Palmas-TO'), new Date('2026-10-01'), new Date('2026-11-02'));
    expect(seen).toEqual(['1', '2']);
    expect(q.length).toBe(rows.length); // the stranger is gone
    expect(q.every((x) => x.price !== 1)).toBe(true);
  });

  it('dollar: USD/BRL with 4 / 4 / 2 decimals', async () => {
    expect(await fetchDollar(net.fetch)).toEqual({ pair: 'USD/BRL', value: 5.4366, change_abs: -0.0031, change_pct: -0.06 });
  });

  it('news list: ids come from the URL; entries without an id are dropped', async () => {
    const list = await fetchNewsList(net.fetch);
    expect(list.length).toBeGreaterThan(0);
    for (const n of list) {
      expect(n.id).toMatch(/^\d+$/);
      expect(n.url).toContain(`_${n.id}.html`);
      expect(n.title).not.toBe('');
      expect(n.published_at).toMatch(/Z$/);
    }
    expect(list.some((n) => n.image && n.image.startsWith('http'))).toBe(true);
    expect((await fetchNewsList(net.fetch, 2)).length).toBe(2);
  });

  it('article: title, blocks, text and Brasília date as UTC', async () => {
    const a = await fetchArticle(net.fetch, '520484');
    expect(a.id).toBe('520484');
    expect(a.title).toBeTruthy();
    expect(a.author).toBe('Leonardo Gottems');
    expect(a.published_at).toBe('2026-11-02T19:07:00.000Z'); // 16h07 in Brasília
    expect(a.content.length).toBeGreaterThan(5); // all the blocks of the body, not only the first
    expect(a.content.every((b) => ['p', 'h2', 'h3', 'li'].includes(b.type) && b.text.trim() === b.text)).toBe(true);
    expect(a.text).toBe(a.content.map((b) => b.text).join('\n\n'));
    expect(a.published_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
    expect(a.image).toMatch(/^https?:\/\//);
  });

  it('article: non-numeric id and a 404 from the site are "not found"', async () => {
    await expect(fetchArticle(net.fetch, 'abc')).rejects.toBeInstanceOf(NewsNotFoundError);
    await expect(fetchArticle(net.fetch, '1; DROP')).rejects.toBeInstanceOf(NewsNotFoundError);
    const gone = new FakeNetwork();
    gone.articleStatus = 404;
    await expect(fetchArticle(gone.fetch, '999')).rejects.toBeInstanceOf(NewsNotFoundError);
  });

  it('weather: unit and clock conversions, next rain, forecast days, air quality', async () => {
    const w = await fetchWeather(net.fetch, 'test-key', -10.19, -48.31);
    expect(w).toMatchObject({
      observed_at: '2026-11-02T18:50:00.000Z',
      description: 'nuvens dispersas',
      temperature_c: 36.61,
      humidity_pct: 39,
      wind_kmh: 13,
      wind_direction: 'SE',
      rain_1h_mm: 0,
      sunrise: '05:42',
      sunset: '18:11',
      air_quality: 'good',
      air_quality_index: 1,
    });
    expect(w.next_rain).toEqual({ when: '2026-11-04T18:00:00.000Z', rain_chance_pct: 80, mm: 2.5, description: 'chuva moderada' });
    expect(w.forecast_days).toEqual(
      [
        { date: '2026-11-02', min: 28, max: 31, rain_chance_pct: 10, rain_mm: 0 },
        { date: '2026-11-03', min: 26, max: 35.34, rain_chance_pct: 45, rain_mm: 0.8 },
        { date: '2026-11-04', min: 25, max: 31, rain_chance_pct: 80, rain_mm: 3.7 },
      ].map((d) => d),
    ); // blocks at 21:00Z+ of the 3rd count as the 3rd local date until 21:00 local
    const call = net.calls.filter((u) => u.includes('openweathermap'));
    expect(call.some((u) => u.includes('/weather?') && u.includes('units=metric') && u.includes('lang=pt_br'))).toBe(true);
    expect(call.find((u) => u.includes('air_pollution'))).not.toContain('units=');
  });

  it('weather: no key means a clear error, not a call', async () => {
    const fresh = new FakeNetwork();
    await expect(fetchWeather(fresh.fetch, undefined, 0, 0)).rejects.toThrow('OPENWEATHER_API_KEY');
    expect(fresh.calls).toHaveLength(0);
  });
});

describe('service, routes and scheduler', () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let net: FakeNetwork;
  let market: MarketService;
  let me: TestUser;

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, user = me) =>
    app.inject({ method, url: `/api/v1${url}`, headers: user.headers, ...(payload === undefined ? {} : { payload: payload as object }) });

  beforeAll(async () => {
    t = await createTestDatabase();
    net = new FakeNetwork();
    market = new MarketService(t.pool, net.fetch, { openWeatherKey: 'test-key', defaultLatitude: -10.1927, defaultLongitude: -48.3132 });
    app = createTestApp(t.pool, true, mkdtempSync(join(tmpdir(), 'caderno-market-')), market);
    me = await registerUser(app, 'me@example.test');
  });
  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });
  beforeEach(async () => {
    net.down = false;
    net.noWeather = false;
    net.calls = [];
    await t.pool.query('DELETE FROM mercado_cache');
  });

  it('summary: the four sources, fresh, and the second call comes from the cache', async () => {
    const first = await call('GET', '/market/summary');
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.city).toBe('Palmas-TO');
    expect(body.quotes.soy).toMatchObject({ date: '2026-11-02', price: 146 });
    expect(body.quotes.corn.price).toBeTypeOf('number');
    expect(body.dollar).toMatchObject({ pair: 'USD/BRL', value: 5.4366 });
    expect(body.weather).toMatchObject({ temperature_c: 36.61, wind_direction: 'SE' });
    expect(body.news.length).toBeLessThanOrEqual(10);
    expect(body.sources.quotes.stale).toBe(false);
    const callsAfterFirst = net.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(5);
    await call('GET', '/market/summary');
    expect(net.calls.length).toBe(callsAfterFirst); // all four from the cache
  });

  it('weather cache key uses coordinates rounded to 2 decimals', async () => {
    await call('GET', '/weather?lat=-10.1901&lon=-48.3099');
    await call('GET', '/weather?lat=-10.1949&lon=-48.3149'); // same ~1 km square
    expect(net.count('/weather?')).toBe(1);
    const [rows] = await t.pool.query<RowDataPacket[]>("SELECT chave FROM mercado_cache WHERE chave LIKE 'clima:%'");
    expect(rows.map((r) => r.chave)).toEqual(['clima:-10.19:-48.31']);
    await call('GET', '/weather?lat=-9.5&lon=-48.3');
    expect(net.count('/weather?')).toBe(2);
  });

  it('one source down does not take the others: the block is null with its error', async () => {
    net.noWeather = true;
    const r = await call('GET', '/market/summary');
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.weather).toBeNull();
    expect(body.sources.weather).toMatchObject({ stale: false, updated_at: null });
    expect(body.sources.weather.error).toContain('503');
    expect(body.dollar.value).toBe(5.4366);
    expect(body.quotes.soy.price).toBe(146);
  });

  it('provider down after the cache expired: the last copy comes back with stale = true', async () => {
    await call('GET', '/market/summary');
    await t.pool.query('UPDATE mercado_cache SET expira_em = NOW(3) - INTERVAL 1 HOUR');
    net.down = true;
    const r = (await call('GET', '/market/summary')).json();
    expect(r.dollar.value).toBe(5.4366);
    expect(r.weather.temperature_c).toBe(36.61);
    for (const s of ['quotes', 'dollar', 'weather', 'news']) {
      expect(r.sources[s].stale, s).toBe(true);
      expect(r.sources[s].updated_at, s).toMatch(/Z$/);
      expect(r.sources[s].error, s).toBeTruthy();
    }
  });

  it('summary validates lat/lon and needs a token; /weather needs both coordinates', async () => {
    expect((await call('GET', '/market/summary?lat=-10')).statusCode).toBe(422);
    expect((await call('GET', '/market/summary?lat=100&lon=0')).statusCode).toBe(422);
    expect((await call('GET', '/weather?lat=-10')).statusCode).toBe(422);
    for (const url of ['/market/summary', '/market/history', '/market/news', '/market/news/520484', '/weather?lat=1&lon=1']) {
      expect((await app.inject({ method: 'GET', url: `/api/v1${url}` })).statusCode, url).toBe(401);
    }
    net.noWeather = true;
    expect((await call('GET', '/weather?lat=-1&lon=-1')).statusCode).toBe(502); // never had data
  });

  it('news: paged list and full article (404 for unknown or non-numeric ids)', async () => {
    const list = (await call('GET', '/market/news?limit=2&page=1')).json();
    expect(list).toMatchObject({ page: 1, limit: 2, stale: false });
    expect(list.items).toHaveLength(2);
    expect(list.total).toBeGreaterThan(2);
    const article = (await call('GET', `/market/news/${list.items[0].id}`)).json();
    expect(article.content.length).toBeGreaterThan(0);
    await call('GET', `/market/news/${list.items[0].id}`);
    expect(net.count('/noticias/x_')).toBe(1); // article cached for 7 days
    expect((await call('GET', '/market/news/abc')).statusCode).toBe(404);
    net.articleStatus = 404;
    expect((await call('GET', '/market/news/123456')).statusCode).toBe(404);
    net.articleStatus = 200;
  });

  it('history: stored by the daily task, read from the table (not the provider), with a summary', async () => {
    const scheduler = new MarketScheduler(t.pool, market);
    await scheduler.daily();
    const callsBefore = net.calls.length;
    const h = (await call('GET', '/market/history?days=365')).json();
    expect(net.calls.length).toBe(callsBefore); // no provider call
    expect(h.city).toBe('Palmas-TO');
    expect(h.quotes.soy.length).toBe(soyPage.soltos.linhas.length);
    expect(h.quotes.soy[0]).toMatchObject({ price: expect.any(Number), change_pct: expect.any(Number) });
    expect(h.summary.soy).toMatchObject({ max: expect.any(Number), min: expect.any(Number), average: expect.any(Number) });
    const onlyCorn = (await call('GET', '/market/history?days=365&product=corn')).json();
    expect(Object.keys(onlyCorn.quotes)).toEqual(['corn']);
    expect((await call('GET', '/market/history?days=0')).statusCode).toBe(422);
    // running again changes nothing (unique on product, city and date)
    await scheduler.daily();
    const [count] = await t.pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM mercado_cotacao WHERE produto = 'soja'");
    expect(count[0]?.n).toBe(soyPage.soltos.linhas.length);
  });

  it('backfill loads 90 days only when the city has no history yet', async () => {
    await t.pool.query('DELETE FROM mercado_cotacao');
    const scheduler = new MarketScheduler(t.pool, market);
    await scheduler.backfill();
    expect(net.count('de=')).toBeGreaterThan(0);
    const calls = net.calls.length;
    await scheduler.backfill();
    expect(net.calls.length).toBe(calls);
  });

  it('refresh warms the cache for the users’ places', async () => {
    const scheduler = new MarketScheduler(t.pool, market);
    await scheduler.refresh();
    const [rows] = await t.pool.query<RowDataPacket[]>('SELECT chave FROM mercado_cache ORDER BY chave');
    expect(rows.map((r) => r.chave)).toEqual(['clima:-10.19:-48.31', 'cotacao:to/palmas', 'dolar', 'noticias']);
  });

  describe('entry weather by GPS', () => {
    let report: string;

    beforeAll(async () => {
      await call('POST', '/periods', { name: '5th term', start_date: '2026-08-03' });
      const subject = (await call('POST', '/subjects', { name: 'Phytopathology', weekdays: [2] })).json().id;
      report = (await call('POST', '/reports', { title: 'Corn plot', subject_id: subject, type: 'continuous' })).json().id;
    });

    const entry = (payload: object) => call('POST', `/reports/${report}/entries`, payload);

    it('with coordinates the provider answers at once: origin "gps", values frozen', async () => {
      const r = await entry({ latitude: -10.2491, longitude: -48.3243 });
      expect(r.json()).toMatchObject({
        weather_origin: 'gps',
        weather: { description: 'nuvens dispersas', temperature_c: 36.6, humidity_pct: 39, wind_kmh: 13, rain_1h_mm: 0 },
      });
      expect(r.json().weather.measured_at).toBe('2026-11-02T18:50:00.000Z');
    });

    it('typed weather wins over the provider and the provider is not even asked', async () => {
      net.calls = [];
      const r = await entry({ latitude: -10.2, longitude: -48.3, weather: { origin: 'manual', temperature_c: 20 } });
      expect(r.json()).toMatchObject({ weather_origin: 'manual', weather: { temperature_c: 20 } });
      expect(net.count('openweathermap')).toBe(0);
    });

    it('provider down: "pending"; later the task fills it ("gps" if the visit was recent, "gps_late" if not)', async () => {
      net.noWeather = true;
      const recent = (await entry({ latitude: -10.2491, longitude: -48.3243, recorded_at: new Date().toISOString() })).json();
      const old = (
        await entry({ latitude: -10.2491, longitude: -48.3243, recorded_at: new Date(Date.now() - 5 * 3600 * 1000).toISOString() })
      ).json();
      const noPlace = (await entry({})).json();
      expect(recent).toMatchObject({ weather_origin: 'pending', weather: null });
      expect(noPlace).toMatchObject({ weather_origin: null, weather: null });

      const scheduler = new MarketScheduler(t.pool, market);
      expect(await scheduler.fillPendingWeather()).toBe(0); // still down
      net.noWeather = false;
      await t.pool.query('DELETE FROM mercado_cache');
      expect(await scheduler.fillPendingWeather()).toBe(2);
      expect((await call('GET', `/entries/${recent.id}`)).json()).toMatchObject({
        weather_origin: 'gps',
        weather: { temperature_c: 36.6 },
      });
      expect((await call('GET', `/entries/${old.id}`)).json()).toMatchObject({
        weather_origin: 'gps_late',
        weather: { temperature_c: 36.6 },
      });
      expect((await call('GET', `/entries/${noPlace.id}`)).json().weather).toBeNull();
      expect(await scheduler.fillPendingWeather()).toBe(0); // nothing pending any more
    });

    it('after 24 hours without an answer the entry becomes "manual"', async () => {
      net.noWeather = true;
      const e = (await entry({ latitude: -1, longitude: -1 })).json();
      await t.pool.query('UPDATE registro SET criado_em = NOW(3) - INTERVAL 25 HOUR, versao = versao + 1 WHERE id = ?', [e.id]);
      expect(await new MarketScheduler(t.pool, market).fillPendingWeather()).toBe(0);
      expect((await call('GET', `/entries/${e.id}`)).json()).toMatchObject({ weather_origin: 'manual', weather: null });
    });

    it('a slow provider never makes the entry wait: it is saved as pending', async () => {
      const slow = new MarketService(t.pool, () => new Promise<Response>(() => {}), {
        openWeatherKey: 'k',
        defaultLatitude: 0,
        defaultLongitude: 0,
      });
      const started = Date.now();
      expect(await slow.currentWeather(1, 1, 150)).toBeNull();
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });
});

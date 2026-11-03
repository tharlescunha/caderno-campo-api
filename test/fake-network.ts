import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { Fetcher } from '../src/market/http.js';
import { owAir, owCurrent, owForecast } from './fixtures/openweather.js';

export const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const soyPage = JSON.parse(fixture('agrolink-soy.json'));
const cornPage = JSON.parse(fixture('agrolink-corn.json'));

/** A network we control: serves the recorded answers, counts calls and can be switched off. */
export class FakeNetwork {
  down = false;
  noWeather = false; // simulate OpenWeather being down only
  calls: string[] = [];
  articleStatus = 200;

  fetch: Fetcher = async (url, init) => {
    this.calls.push(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (this.down) throw new Error('network is down');
    if (url.includes('openweathermap.org')) {
      if (this.noWeather) return json({ message: 'down' }, 503);
      if (url.includes('/weather?')) return json(owCurrent);
      if (url.includes('/forecast?')) return json(owForecast);
      if (url.includes('/air_pollution?')) return json(owAir);
    }
    if (url.includes('agrolink.com.br/api/cotacoes')) return json(url.includes('soja') ? soyPage : cornPage);
    if (url.includes('scanner.tradingview.com')) {
      expect(init?.method).toBe('POST');
      return json(JSON.parse(fixture('tradingview-usdbrl.json')));
    }
    if (url.includes('/rss/noticias.rss'))
      return new Response(fixture('agrolink-news.rss'), { headers: { 'content-type': 'application/rss+xml' } });
    if (url.includes('/noticias/x_')) {
      return this.articleStatus === 200
        ? new Response(fixture('agrolink-article.html'), { headers: { 'content-type': 'text/html; charset=utf-8' } })
        : new Response('', { status: this.articleStatus });
    }
    return json({}, 404);
  };

  count = (part: string) => this.calls.filter((u) => u.includes(part)).length;
}

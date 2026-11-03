import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { MarketService } from './service.js';

type Log = { info: (msg: string) => void; error: (msg: string) => void };

const HOUR_MS = 3600 * 1000;
export const BACKFILL_DAYS = 90;
/** A pending weather older than this is given up: the entry becomes "manual" (docs/api.md, section 7). */
export const PENDING_WEATHER_HOURS = 24;
/** Weather fetched later than this after the visit is flagged "gps_late". */
const ON_TIME_HOURS = 2;

/**
 * Background work of the market module (docs/mercado-provedores.md, section 4):
 *  - every N minutes: refresh quotes, dollar, news and the weather of the users' places, and fill pending entry weather;
 *  - every day after 22:00 (local time): store the day's quotes in `mercado_cotacao`.
 * Every step is independent and logs its own failure.
 */
export class MarketScheduler {
  private refreshTimer: NodeJS.Timeout | null = null;
  private dailyTimer: NodeJS.Timeout | null = null;
  private lastDaily = '';

  constructor(
    private readonly pool: Pool,
    private readonly market: MarketService,
    private readonly log: Log = { info: () => {}, error: () => {} },
    private readonly options: { refreshMinutes: number; timezone: string } = { refreshMinutes: 15, timezone: 'America/Araguaina' },
  ) {}

  start(): void {
    void this.backfill();
    void this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), this.options.refreshMinutes * 60 * 1000);
    this.dailyTimer = setInterval(() => void this.dailyIfDue(), 60 * 1000);
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.dailyTimer) clearInterval(this.dailyTimer);
    this.refreshTimer = this.dailyTimer = null;
  }

  private async step(name: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.log.error(`market ${name}: ${(e as Error).message}`);
    }
  }

  /** The distinct quote cities and weather places of the users. */
  private async places(): Promise<{ cities: string[]; spots: { latitude: number; longitude: number }[] }> {
    const [users] = await this.pool.query<RowDataPacket[]>(
      'SELECT DISTINCT cidade_cotacoes AS city, latitude_padrao AS lat, longitude_padrao AS lon FROM usuario',
    );
    const cities = [...new Set(users.map((u) => u.city as string))];
    const spots = new Map<string, { latitude: number; longitude: number }>();
    const fallback = this.market.defaultLocation;
    for (const u of users) {
      const spot = u.lat == null || u.lon == null ? fallback : { latitude: Number(u.lat), longitude: Number(u.lon) };
      spots.set(`${spot.latitude.toFixed(2)}:${spot.longitude.toFixed(2)}`, spot);
    }
    return { cities, spots: [...spots.values()] };
  }

  /** Renews what is old, so that the app almost always finds a fresh cache. */
  async refresh(): Promise<void> {
    const { cities, spots } = await this.places();
    for (const city of cities) await this.step(`quotes ${city}`, () => this.market.quotes(city));
    await this.step('dollar', () => this.market.dollar());
    await this.step('news', () => this.market.news());
    for (const spot of spots) await this.step('weather', () => this.market.weather(spot.latitude, spot.longitude));
    await this.step('pending weather', () => this.fillPendingWeather());
  }

  /** First run for a new city: load the last 90 days so the history screen has data. */
  async backfill(): Promise<void> {
    const { cities } = await this.places();
    for (const city of cities) {
      await this.step(`backfill ${city}`, async () => {
        if (!(await this.market.hasHistory(city)))
          this.log.info(`market: loaded ${await this.market.collectQuotes(city, BACKFILL_DAYS)} quotes for ${city}.`);
      });
    }
  }

  /** The day's quotes go to the history (repeating is safe). The last 7 days are re-read to catch late updates. */
  async daily(): Promise<void> {
    const { cities } = await this.places();
    for (const city of cities) await this.step(`daily ${city}`, () => this.market.collectQuotes(city, 7));
  }

  private async dailyIfDue(): Promise<void> {
    const now = new Date();
    const date = now.toLocaleDateString('en-CA', { timeZone: this.options.timezone });
    const hour = Number(now.toLocaleTimeString('en-GB', { timeZone: this.options.timezone, hour: '2-digit', hour12: false }));
    if (hour >= 22 && this.lastDaily !== date) {
      this.lastDaily = date;
      await this.daily();
    }
  }

  /**
   * Entries saved with coordinates but without weather (provider was down): try again with the visit's place.
   * A late answer is "gps_late" (current conditions, not the ones of the visit); after 24 hours it is "manual".
   */
  async fillPendingWeather(): Promise<number> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, latitude, longitude, data_hora, criado_em FROM registro WHERE clima_origem = 'pendente' AND latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY criado_em LIMIT 100`,
    );
    let filled = 0;
    for (const row of rows) {
      const createdAt = new Date(`${(row.criado_em as string).replace(' ', 'T')}Z`).getTime();
      if (Date.now() - createdAt > PENDING_WEATHER_HOURS * HOUR_MS) {
        await this.pool.query("UPDATE registro SET clima_origem = 'manual' WHERE id = ?", [row.id]);
        continue;
      }
      const weather = await this.market.currentWeather(Number(row.latitude), Number(row.longitude));
      if (!weather) continue;
      const visit = new Date(`${(row.data_hora as string).replace(' ', 'T')}Z`).getTime();
      const origin = Date.now() - visit <= ON_TIME_HOURS * HOUR_MS ? 'gps' : 'gps_atrasado';
      await this.pool.query(
        `UPDATE registro SET clima_origem = ?, clima_descricao = ?, clima_temperatura_c = ?, clima_sensacao_c = ?, clima_umidade_pct = ?,
                clima_vento_kmh = ?, clima_chuva_1h_mm = ?, clima_medido_em = ? WHERE id = ? AND clima_origem = 'pendente'`,
        [
          origin,
          weather.description.slice(0, 80),
          weather.temperature_c,
          weather.feels_like_c,
          weather.humidity_pct,
          weather.wind_kmh,
          weather.rain_1h_mm,
          new Date(weather.observed_at),
          row.id,
        ],
      );
      filled++;
    }
    return filled;
  }
}

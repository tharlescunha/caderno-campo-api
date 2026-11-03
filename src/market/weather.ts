import { getJson, ProviderError, type Fetcher } from './http.js';

const BASE_URL = 'https://api.openweathermap.org/data/2.5';
const RAIN_CHANCE_LIMIT = 0.5; // "it will rain" when the chance is 50% or more

const AIR_QUALITY = ['good', 'fair', 'moderate', 'poor', 'very_poor'] as const;
const DIRECTIONS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'] as const;

export interface Weather {
  observed_at: string; // ISO UTC
  description: string;
  temperature_c: number;
  feels_like_c: number;
  humidity_pct: number;
  pressure_hpa: number;
  clouds_pct: number | null;
  wind_kmh: number;
  wind_direction: string;
  rain_1h_mm: number;
  sunrise: string; // HH:MM, local time of the place
  sunset: string;
  next_rain: { when: string; rain_chance_pct: number; mm: number; description: string } | null;
  forecast_days: { date: string; min: number; max: number; rain_chance_pct: number; rain_mm: number }[];
  air_quality: (typeof AIR_QUALITY)[number];
  air_quality_index: number;
}

interface Current {
  dt: number;
  timezone: number;
  weather: { description: string }[];
  main: { temp: number; feels_like: number; humidity: number; pressure: number };
  clouds?: { all?: number };
  wind?: { speed?: number; deg?: number };
  rain?: { '1h'?: number };
  sys: { sunrise: number; sunset: number };
}

interface Forecast {
  city: { timezone: number };
  list: {
    dt: number;
    pop?: number;
    rain?: { '3h'?: number };
    main: { temp_min: number; temp_max: number };
    weather: { description: string }[];
  }[];
}

interface Air {
  list: { main: { aqi: number } }[];
}

/** Local clock of the place: shift the UTC time by the provider's `timezone` (seconds), then read it as UTC. */
const local = (ts: number, tz: number) => new Date((ts + tz) * 1000).toISOString();
const iso = (ts: number) => new Date(ts * 1000).toISOString();
const direction = (degrees: number) => DIRECTIONS[Math.round(degrees / 22.5) % 16]!;

/** The first 3-hour block with a chance of 50% or more, or at least 1 mm of rain. */
function nextRain(forecast: Forecast): Weather['next_rain'] {
  for (const item of forecast.list) {
    const mm = item.rain?.['3h'] ?? 0;
    const pop = item.pop ?? 0;
    if (pop >= RAIN_CHANCE_LIMIT || mm >= 1) {
      return { when: iso(item.dt), rain_chance_pct: Math.round(pop * 100), mm, description: item.weather[0]?.description ?? '' };
    }
  }
  return null;
}

/** Group the 3-hour blocks by local date: lowest min, highest max, highest chance, summed rain. */
function forecastDays(forecast: Forecast): Weather['forecast_days'] {
  const days = new Map<string, { min: number; max: number; rain_chance_pct: number; rain_mm: number }>();
  for (const item of forecast.list) {
    const date = local(item.dt, forecast.city.timezone).slice(0, 10);
    const day = days.get(date) ?? { min: 99, max: -99, rain_chance_pct: 0, rain_mm: 0 };
    day.min = Math.min(day.min, item.main.temp_min);
    day.max = Math.max(day.max, item.main.temp_max);
    day.rain_chance_pct = Math.max(day.rain_chance_pct, Math.round((item.pop ?? 0) * 100));
    day.rain_mm = Math.round((day.rain_mm + (item.rain?.['3h'] ?? 0)) * 10) / 10;
    days.set(date, day);
  }
  return [...days].map(([date, day]) => ({ date, ...day }));
}

/** Current weather, forecast and air quality for a place (3 calls to OpenWeather). */
export async function fetchWeather(fetcher: Fetcher, apiKey: string | undefined, latitude: number, longitude: number): Promise<Weather> {
  if (!apiKey) throw new ProviderError('OPENWEATHER_API_KEY is not set.');
  const call = <T>(path: string, withLanguage = true) => {
    const params = new URLSearchParams({ lat: String(latitude), lon: String(longitude), appid: apiKey });
    if (withLanguage) {
      params.set('units', 'metric');
      params.set('lang', 'pt_br');
    }
    return getJson<T>(fetcher, `${BASE_URL}/${path}?${params}`);
  };
  const [now, forecast, air] = await Promise.all([call<Current>('weather'), call<Forecast>('forecast'), call<Air>('air_pollution', false)]);

  const aqi = air.list[0]?.main.aqi ?? 1;
  const wind = now.wind ?? {};
  return {
    observed_at: iso(now.dt),
    description: now.weather[0]?.description ?? '',
    temperature_c: now.main.temp,
    feels_like_c: now.main.feels_like,
    humidity_pct: now.main.humidity,
    pressure_hpa: now.main.pressure,
    clouds_pct: now.clouds?.all ?? null,
    wind_kmh: Math.round((wind.speed ?? 0) * 3.6),
    wind_direction: direction(wind.deg ?? 0),
    rain_1h_mm: now.rain?.['1h'] ?? 0,
    sunrise: local(now.sys.sunrise, now.timezone).slice(11, 16),
    sunset: local(now.sys.sunset, now.timezone).slice(11, 16),
    next_rain: nextRain(forecast),
    forecast_days: forecastDays(forecast),
    air_quality: AIR_QUALITY[aqi - 1] ?? 'good',
    air_quality_index: aqi,
  };
}

// Responses shaped like the OpenWeather 2.5 API (weather, forecast, air_pollution).
// SYNTHETIC: written by hand from the documented format, because the real ones need the account key.
// Replace by recorded answers when the key is set (docs/mercado-provedores.md, section 5).

const TZ = -10800; // Palmas, UTC-3
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export const owCurrent = {
  dt: at('2026-11-02T18:50:00Z'), // 15:50 local
  timezone: TZ,
  weather: [{ description: 'nuvens dispersas' }],
  main: { temp: 36.61, feels_like: 40.01, humidity: 39, pressure: 1007 },
  clouds: { all: 40 },
  wind: { speed: 3.6, deg: 135 }, // 3.6 m/s = 13 km/h, southeast
  sys: { sunrise: at('2026-11-02T08:42:00Z'), sunset: at('2026-11-02T21:11:00Z') }, // 05:42 and 18:11 local
};

function block(iso: string, min: number, max: number, pop: number, rain3h?: number, description = 'céu limpo') {
  return {
    dt: at(iso),
    pop,
    ...(rain3h ? { rain: { '3h': rain3h } } : {}),
    main: { temp_min: min, temp_max: max },
    weather: [{ description }],
  };
}

export const owForecast = {
  city: { timezone: TZ },
  list: [
    // 2026-11-02 (local): 21:00Z = 18:00 local
    block('2026-11-02T21:00:00Z', 30, 31, 0),
    block('2026-11-03T00:00:00Z', 28, 29, 0.1), // 21:00 local
    // 2026-11-03 local
    block('2026-11-03T12:00:00Z', 26, 33, 0.3, 0.4),
    block('2026-11-03T15:00:00Z', 30, 35.34, 0.45, 0.4),
    // 2026-11-04 local: the first block that counts as rain (chance >= 50%)
    block('2026-11-04T18:00:00Z', 29, 31, 0.8, 2.5, 'chuva moderada'),
    block('2026-11-04T21:00:00Z', 25, 28, 0.6, 1.2, 'chuva leve'),
  ],
};

export const owAir = { list: [{ main: { aqi: 1 } }] };

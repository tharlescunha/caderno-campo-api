import { AttemptLimiter } from './auth/rate-limit.js';
import { createApp } from './app.js';
import { NotificationGenerator } from './notifications/generator.js';
import { MarketScheduler } from './market/scheduler.js';
import { MarketService } from './market/service.js';
import { TranscriptionWorker } from './audios/worker.js';
import { loadConfig } from './config.js';
import { HttpTranscriber } from './transcription/client.js';
import { MediaStorage } from './media/storage.js';
import { applyMigrations } from './db/migrate.js';
import { poolFromConfig } from './db/connection.js';

const config = loadConfig();
const pool = poolFromConfig(config);
const market = config.market.enabled
  ? new MarketService(pool, (url, init) => fetch(url, init), {
      openWeatherKey: config.openWeatherKey,
      defaultLatitude: config.weatherDefault.latitude,
      defaultLongitude: config.weatherDefault.longitude,
      log: { error: (m) => console.error(m) },
    })
  : undefined;
const context = {
  config,
  pool,
  loginLimiter: new AttemptLimiter(),
  media: new MediaStorage(config.mediaDir),
  ...(market ? { market } : {}),
};
const app = createApp({ context });

const worker = config.transcriptionUrl
  ? new TranscriptionWorker(pool, context.media, new HttpTranscriber(config.transcriptionUrl), {
      info: (m) => app.log.info(m),
      error: (m) => app.log.error(m),
    })
  : null;

const scheduler = market
  ? new MarketScheduler(
      pool,
      market,
      { info: (m) => app.log.info(m), error: (m) => app.log.error(m) },
      { refreshMinutes: config.market.refreshMinutes, timezone: config.market.timezone },
    )
  : null;

const notifications = new NotificationGenerator(pool, market, { info: (m) => app.log.info(m), error: (m) => app.log.error(m) });
let notificationTimer: NodeJS.Timeout | null = null;

try {
  await applyMigrations(pool, config.migrationsDir, (m) => app.log.info(m));
  await app.listen({ host: config.host, port: config.port });
  worker?.start();
  scheduler?.start();
  // reminders are made shortly before they are due: run often (docs/api.md, section 10)
  const tick = () => notifications.run().catch((e) => app.log.error(`notifications: ${(e as Error).message}`));
  void tick();
  notificationTimer = setInterval(tick, 5 * 60 * 1000);
  if (market && !config.openWeatherKey) app.log.warn('OPENWEATHER_API_KEY is not set: the weather is unavailable.');
  if (!worker) app.log.warn('TRANSCRIPTION_URL is not set: audios are stored but not transcribed.');
} catch (e) {
  app.log.error(e);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    worker?.stop();
    scheduler?.stop();
    if (notificationTimer) clearInterval(notificationTimer);
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

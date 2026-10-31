import { buildApp } from './app.js';
import { config } from './config.js';
import { closeDb, query } from './db.js';
import { migrate } from './migrate.js';
import { ensureDirs, streamManager } from './lib/streamManager.js';
import { recordingManager } from './lib/recorder.js';
import { graphics } from './lib/graphics.js';
import { scheduler } from './lib/scheduler.js';
import { getRedis, log, recordSystemEvent } from './lib/events.js';
import { autoRefreshDue } from './services/playlists.js';
import { refreshStaleEpgSources } from './services/epg.js';
import { executeScheduledAction } from './routes/broadcast.js';
import { collectHealth } from './routes/system.js';

async function main(): Promise<void> {
  await ensureDirs();
  const applied = await migrate();
  if (applied.length) log('INFO', 'boot', 'migrations applied', { applied });

  // Stale recordings from a previous process are finalized as FAILED (their FFmpeg died with the host).
  const orphaned = await query("UPDATE recordings SET status = 'FAILED', ended_at = now(), error = 'interrupted by service restart' WHERE status = 'RECORDING' RETURNING id");
  if (orphaned.rowCount) log('WARN', 'boot', 'recordings interrupted by restart', { count: orphaned.rowCount });

  await graphics.syncCatalog();
  graphics.connect().catch((err: Error) => log('WARN', 'graphics', 'CasparCG not reachable at boot', { err: err.message }));

  await streamManager.refreshBackupCache();
  const restored = await streamManager.restoreDesired();
  if (restored.length) await recordSystemEvent('INFO', 'boot', 'STREAMS_RESTORED', `Restored ${restored.length} stream(s) after restart`, { channelIds: restored });
  streamManager.startMonitor();

  scheduler.setExecutor(executeScheduledAction);
  scheduler.start();

  // Periodic maintenance jobs (all tolerate failure and are logged).
  const jobs: NodeJS.Timeout[] = [];
  jobs.push(setInterval(() => { autoRefreshDue().catch(() => undefined); }, 5 * 60_000));
  jobs.push(setInterval(() => { refreshStaleEpgSources(12).catch(() => undefined); }, 60 * 60_000));
  jobs.push(setInterval(() => {
    recordingManager.applyRetention().catch((err: Error) => log('ERROR', 'retention', err.message));
    recordingManager.freeBytes().then(async (free) => {
      if (free < config.recordings.minFreeGb * 1024 ** 3) {
        await recordSystemEvent('WARN', 'storage', 'DISK_LOW', `Recordings volume low: ${(free / 1024 ** 3).toFixed(1)} GB free`, { freeBytes: free });
      }
    }).catch(() => undefined);
  }, 60 * 60_000));
  jobs.push(setInterval(() => { collectHealth(true).catch(() => undefined); }, config.monitoring.healthIntervalMs));
  for (const j of jobs) j.unref();

  const app = await buildApp({ logger: false });
  await app.listen({ port: config.port, host: config.host });
  log('INFO', 'boot', 'IO backend listening', { port: config.port, host: config.host, publicBaseUrl: config.publicBaseUrl });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('INFO', 'shutdown', 'graceful shutdown started', { signal });
    scheduler.stop();
    jobs.forEach(clearInterval);
    await app.close().catch(() => undefined);
    await streamManager.shutdown();
    await recordingManager.shutdown();
    graphics.close();
    getRedis().disconnect();
    await closeDb();
    log('INFO', 'shutdown', 'graceful shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: Error) => {
  log('ERROR', 'boot', 'fatal startup error', { err: err.message, stack: err.stack });
  process.exit(1);
});

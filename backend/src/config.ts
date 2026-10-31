import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '..', '..');

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer`);
  return n;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const dataDir = env('IO_DATA_DIR', path.join(ROOT_DIR, 'data'));

export const config = {
  env: env('NODE_ENV', 'development'),
  port: envInt('PORT', 8080),
  host: env('HOST', '0.0.0.0'),
  publicBaseUrl: env('IO_PUBLIC_BASE_URL', `http://localhost:${envInt('PORT', 8080)}`),
  corsOrigins: env('CORS_ORIGINS', '*'),
  dataDir,
  hlsDir: path.join(dataDir, 'hls'),
  recordingsDir: path.join(dataDir, 'recordings'),
  logsDir: path.join(dataDir, 'logs'),
  database: {
    url: env('DATABASE_URL', 'postgres://io:io_dev_password@127.0.0.1:5432/io'),
    poolMax: envInt('DATABASE_POOL_MAX', 10),
  },
  redis: {
    url: env('REDIS_URL', 'redis://127.0.0.1:6379'),
  },
  jwt: {
    // In production these MUST be provided via secret management. Dev fallback is random per process.
    secret: env('JWT_SECRET', process.env.NODE_ENV === 'production' ? '' : 'dev-only-jwt-secret-change-me-0123456789'),
    accessTtl: env('JWT_ACCESS_TTL', '15m'),
    refreshTtlDays: envInt('JWT_REFRESH_TTL_DAYS', 30),
  },
  mediaTokenSecret: env('MEDIA_TOKEN_SECRET', 'dev-only-media-secret-change-me-0123456789'),
  mediaTokenTtlSeconds: envInt('MEDIA_TOKEN_TTL_SECONDS', 3600),
  ffmpeg: {
    bin: env('FFMPEG_BIN', 'ffmpeg'),
    ffprobeBin: env('FFPROBE_BIN', 'ffprobe'),
    // Comma-separated ABR ladder, format NAME:HEIGHT:VIDEO_KBPS:AUDIO_KBPS. Adjust to hardware.
    ladder: env('HLS_LADDER', '360p:360:1200:128'),
    hlsSegmentSeconds: envInt('HLS_SEGMENT_SECONDS', 4),
    hlsListSize: envInt('HLS_LIST_SIZE', 6),
    preset: env('X264_PRESET', 'veryfast'),
    maxRestarts: envInt('STREAM_MAX_RESTARTS', 5),
    maxConcurrentStreams: envInt('MAX_CONCURRENT_STREAMS', 2),
  },
  recordings: {
    minFreeGb: envInt('RECORDING_MIN_FREE_GB', 5),
    maxRecordingMinutes: envInt('RECORDING_MAX_MINUTES', 240),
  },
  security: {
    // SSRF: private/loopback/link-local addresses are refused for stream and playlist sources unless listed here.
    allowPrivateSourceHosts: env('ALLOW_PRIVATE_SOURCE_HOSTS', '').split(',').map((s) => s.trim()).filter(Boolean),
    allowLavfiSources: envBool('ALLOW_LAVFI_SOURCES', true),
  },
  casparcg: {
    host: env('CASPARCG_HOST', '127.0.0.1'),
    port: envInt('CASPARCG_AMCP_PORT', 5250),
    enabled: envBool('CASPARCG_ENABLED', false),
  },
  scheduler: {
    enabled: envBool('SCHEDULER_ENABLED', true),
    tickMs: envInt('SCHEDULER_TICK_MS', 10000),
  },
  monitoring: {
    healthIntervalMs: envInt('HEALTH_INTERVAL_MS', 30000),
  },
  rateLimit: {
    max: envInt('RATE_LIMIT_MAX', 300),
    timeWindow: env('RATE_LIMIT_WINDOW', '1 minute'),
    loginMax: envInt('LOGIN_RATE_LIMIT_MAX', 10),
  },
} as const;

export type Config = typeof config;

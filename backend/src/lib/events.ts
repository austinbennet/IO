import { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { query } from '../db.js';

export type EventLevel = 'INFO' | 'WARN' | 'ERROR';

export interface IoEvent {
  type: string;
  payload: Record<string, unknown>;
  at: string;
}

/** In-process fan-out for WebSocket clients and internal listeners. */
export const bus = new EventEmitter();
bus.setMaxListeners(200);

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(config.redis.url, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: false,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });
    redis.on('error', (err) => {
      console.error(JSON.stringify({ level: 'WARN', source: 'redis', msg: err.message }));
    });
  }
  return redis;
}

export function publish(type: string, payload: Record<string, unknown>): void {
  const evt: IoEvent = { type, payload, at: new Date().toISOString() };
  bus.emit('event', evt);
  // Best-effort cross-instance fan-out; never block the caller.
  getRedis().publish('io:events', JSON.stringify(evt)).catch(() => undefined);
}

/**
 * Writes a structured system event to PostgreSQL and fans it out to subscribers.
 * Used for operator-visible events (stream failures, failover, disk alerts, schedule runs).
 */
export async function recordSystemEvent(
  level: EventLevel,
  source: string,
  type: string,
  message: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  try {
    await query(
      'INSERT INTO system_events (level, source, type, message, data) VALUES ($1, $2, $3, $4, $5)',
      [level, source, type, message.slice(0, 2000), JSON.stringify(data)],
    );
  } catch (err) {
    console.error(JSON.stringify({ level: 'ERROR', source: 'events', msg: 'failed to persist system event', err: (err as Error).message }));
  }
  publish('system.event', { level, source, type, message, data });
  log(level, source, message, { type, ...data });
}

/** Structured JSON log line to stdout (captured by Docker / journald / log rotation). */
export function log(level: EventLevel | 'DEBUG', source: string, msg: string, extra: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, source, msg, ...extra });
  if (level === 'ERROR') console.error(line);
  else console.log(line);
}

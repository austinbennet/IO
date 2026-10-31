import '@fastify/websocket';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, query } from '../db.js';
import { requirePermission, requireRole, type JwtUser } from '../auth.js';
import { getRedis, bus, type IoEvent } from '../lib/events.js';
import { graphics } from '../lib/graphics.js';
import { recordingManager } from '../lib/recorder.js';
import { streamManager } from '../lib/streamManager.js';
import { scheduler } from '../lib/scheduler.js';
import { signMediaToken, verifyMediaToken } from '../lib/security.js';

const execFileAsync = promisify(execFile);
const STARTED_AT = Date.now();

async function binaryVersion(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, ['-version'], { timeout: 5000 });
    return stdout.split('\n')[0].trim();
  } catch {
    return null;
  }
}

async function probeDb(): Promise<{ status: 'UP' | 'DOWN'; latencyMs: number; error?: string }> {
  const t = Date.now();
  try {
    await pool.query('SELECT 1');
    return { status: 'UP', latencyMs: Date.now() - t };
  } catch (err) {
    return { status: 'DOWN', latencyMs: Date.now() - t, error: (err as Error).message };
  }
}

async function probeRedis(): Promise<{ status: 'UP' | 'DOWN'; latencyMs: number; error?: string }> {
  const t = Date.now();
  try {
    const pong = await getRedis().ping();
    return { status: pong === 'PONG' ? 'UP' : 'DOWN', latencyMs: Date.now() - t };
  } catch (err) {
    return { status: 'DOWN', latencyMs: Date.now() - t, error: (err as Error).message };
  }
}

async function diskStats(dir: string) {
  const s = await fsp.statfs(dir);
  const total = Number(s.blocks) * Number(s.bsize);
  const free = Number(s.bavail) * Number(s.bsize);
  return { path: dir, totalBytes: total, freeBytes: free, usedPercent: total ? Math.round(((total - free) / total) * 1000) / 10 : 0 };
}

function netCounters(): { rxBytes: number; txBytes: number } | null {
  try {
    const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
    let rx = 0;
    let tx = 0;
    for (const line of lines) {
      const [ifaceRaw, rest] = line.split(':');
      if (!rest || ifaceRaw.trim() === 'lo') continue;
      const cols = rest.trim().split(/\s+/).map(Number);
      rx += cols[0] ?? 0;
      tx += cols[8] ?? 0;
    }
    return { rxBytes: rx, txBytes: tx };
  } catch {
    return null; // not available on this platform (e.g. macOS)
  }
}

let lastNet: { at: number; rx: number; tx: number } | null = null;

/** Persists the latest component health into service_health (read by /api/system/services). */
async function persistHealth(entries: Array<{ service: string; status: string; details: Record<string, unknown> }>): Promise<void> {
  for (const e of entries) {
    await query(
      `INSERT INTO service_health (service, status, details, checked_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (service) DO UPDATE SET status = EXCLUDED.status, details = EXCLUDED.details, checked_at = now()`,
      [e.service, e.status, JSON.stringify(e.details)],
    );
  }
}

export async function collectHealth(persist = true) {
  const [db, redis, ffmpeg, ffprobe, disk] = await Promise.all([
    probeDb(),
    probeRedis(),
    binaryVersion(config.ffmpeg.bin),
    binaryVersion(config.ffmpeg.ffprobeBin),
    diskStats(config.dataDir).catch(() => null),
  ]);
  const casparStatus = graphics.status();
  const entries = [
    { service: 'api', status: 'UP', details: { uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000) } },
    { service: 'postgres', status: db.status, details: db },
    { service: 'redis', status: redis.status, details: redis },
    { service: 'ffmpeg', status: ffmpeg ? 'UP' : 'DOWN', details: { version: ffmpeg } },
    { service: 'ffprobe', status: ffprobe ? 'UP' : 'DOWN', details: { version: ffprobe } },
    {
      service: 'casparcg',
      status: !casparStatus.enabled ? 'UNKNOWN' : casparStatus.connected ? 'UP' : 'DOWN',
      details: casparStatus,
    },
    { service: 'scheduler', status: scheduler.status.running ? 'UP' : 'DOWN', details: scheduler.status },
  ];
  if (persist) await persistHealth(entries).catch(() => undefined);
  const critical = db.status === 'UP' && redis.status === 'UP' && Boolean(ffmpeg);
  return {
    status: critical ? 'OK' : 'DEGRADED',
    timestamp: new Date().toISOString(),
    components: entries.map((e) => ({ name: e.service, status: e.status, details: e.details })),
    disk,
    streams: { running: streamManager.snapshot().filter((s) => s.running).length, total: streamManager.snapshot().length },
    recordings: { active: recordingManager.activeCount() },
  };
}

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  // Public liveness probe for Docker/Nginx/load balancers. Contains no internal details.
  app.get('/healthz', async () => ({ status: 'ok', uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000) }));

  app.get('/api/system/health', { preHandler: requirePermission('system:read') }, async () => collectHealth(true));

  app.get('/api/system/metrics', { preHandler: requirePermission('system:read') }, async () => {
    const mem = { totalBytes: os.totalmem(), freeBytes: os.freemem() };
    const net = netCounters();
    let netRate: { rxBytesPerSec: number; txBytesPerSec: number } | null = null;
    if (net) {
      const now = Date.now();
      if (lastNet) {
        const dt = (now - lastNet.at) / 1000;
        netRate = { rxBytesPerSec: Math.max(0, Math.round((net.rxBytes - lastNet.rx) / dt)), txBytesPerSec: Math.max(0, Math.round((net.txBytes - lastNet.tx) / dt)) };
      }
      lastNet = { at: now, rx: net.rxBytes, tx: net.txBytes };
    }
    const streams = streamManager.snapshot();
    const running = streams.filter((s) => s.running);
    const bitrates = running.map((s) => (s.progress as { bitrateKbps: number | null }).bitrateKbps).filter((v): v is number => typeof v === 'number');
    const eventCounts = (await query<{ level: string; n: string }>(
      "SELECT level, count(*)::text n FROM system_events WHERE created_at > now() - interval '24 hours' GROUP BY level",
    )).rows;
    const recordedToday = (await query<{ n: string }>(
      "SELECT count(*)::text n FROM recordings WHERE started_at > now() - interval '24 hours'",
    )).rows[0].n;
    return {
      measuredAt: new Date().toISOString(),
      // Directly measured values:
      cpu: { cores: os.cpus().length, loadAverage: os.loadavg(), loadPerCore: Math.round((os.loadavg()[0] / os.cpus().length) * 100) / 100 },
      memory: { ...mem, usedPercent: Math.round(((mem.totalBytes - mem.freeBytes) / mem.totalBytes) * 1000) / 10, processRssBytes: process.memoryUsage().rss },
      disk: await diskStats(config.dataDir).catch(() => null),
      network: { totals: net, rate: netRate },
      streams: {
        total: streams.length,
        running: running.length,
        degraded: streams.filter((s) => s.state === 'DEGRADED' || s.state === 'FAILING_OVER').length,
        failed: streams.filter((s) => s.state === 'FAILED').length,
        encoderBitrateKbps: bitrates,
        totalEncoderBitrateKbps: bitrates.reduce((a, b) => a + b, 0),
      },
      recordings: { active: recordingManager.activeCount(), startedLast24h: Number(recordedToday) },
      events: { last24h: Object.fromEntries(eventCounts.map((e) => [e.level, Number(e.n)])) },
      scheduler: scheduler.status,
      // Derived from process uptime and counters (labelled as estimates in the API contract):
      estimated: { uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000) },
    };
  });

  app.get('/api/system/services', { preHandler: requirePermission('system:read') }, async () => {
    const rows = (await query('SELECT service, status, details, checked_at FROM service_health ORDER BY service')).rows;
    return {
      items: rows,
      processes: streamManager.snapshot().filter((s) => s.running).map((s) => ({ channelId: s.channelId, pid: s.pid, state: s.state })),
      recordingProcesses: recordingManager.activeCount(),
    };
  });

  app.get('/api/system/events', { preHandler: requirePermission('system:read') }, async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), level: z.enum(['INFO', 'WARN', 'ERROR']).optional() }).parse(req.query);
    const rows = (await query(
      `SELECT id, level, source, type, message, data, created_at FROM system_events
        WHERE ($1::text IS NULL OR level = $1) ORDER BY created_at DESC LIMIT $2`,
      [q.level ?? null, q.limit],
    )).rows;
    return { items: rows };
  });

  app.get('/api/system/audit', { preHandler: requireRole('ADMIN') }, async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const rows = (await query(
      `SELECT a.id, a.action, a.resource, a.resource_id, a.ip, a.status_code, a.created_at, u.email AS user_email
         FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT $1`, [q.limit],
    )).rows;
    return { items: rows };
  });

  // ---------- Analytics (only directly measured events are stored; estimates are labelled) ----------
  app.post('/api/analytics/events', { preHandler: requirePermission('channels:read') }, async (req, reply) => {
    const body = z.object({
      type: z.enum(['PLAYBACK_START', 'PLAYBACK_ERROR', 'BUFFERING_START', 'BUFFERING_END', 'QUALITY_CHANGE', 'CHANNEL_SWITCH']),
      channelId: z.string().uuid().optional(),
      sessionId: z.string().max(80).optional(),
      data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
    }).parse(req.body);
    await query(
      'INSERT INTO analytics_events (type, channel_id, session_id, measured, data) VALUES ($1, $2, $3, TRUE, $4)',
      [body.type, body.channelId ?? null, body.sessionId ?? null, JSON.stringify(body.data)],
    );
    return reply.code(202).send({ accepted: true });
  });

  app.get('/api/analytics/summary', { preHandler: requirePermission('system:read') }, async (req) => {
    const q = z.object({ hours: z.coerce.number().int().min(1).max(24 * 90).default(24) }).parse(req.query);
    const byType = (await query<{ type: string; n: string }>(
      `SELECT type, count(*)::text n FROM analytics_events WHERE created_at > now() - make_interval(hours => $1) GROUP BY type`, [q.hours],
    )).rows;
    const topChannels = (await query<{ name: string; n: string }>(
      `SELECT c.name, count(*)::text n FROM analytics_events a JOIN channels c ON c.id = a.channel_id
        WHERE a.type = 'PLAYBACK_START' AND a.created_at > now() - make_interval(hours => $1) GROUP BY c.name ORDER BY count(*) DESC LIMIT 10`, [q.hours],
    )).rows;
    const sessions = (await query<{ n: string }>(
      `SELECT count(DISTINCT session_id)::text n FROM analytics_events WHERE session_id IS NOT NULL AND created_at > now() - make_interval(hours => $1)`, [q.hours],
    )).rows[0].n;
    return {
      windowHours: q.hours,
      measured: { eventsByType: Object.fromEntries(byType.map((r) => [r.type, Number(r.n)])), playbackSessions: Number(sessions), topChannelsByPlaybackStart: topChannels.map((c) => ({ channel: c.name, starts: Number(c.n) })) },
      estimated: {},
      note: 'Viewer counts are only reported from client-side playback events; no viewer numbers are synthesized.',
    };
  });

  // ---------- HLS media delivery ----------
  // Playlists/segments are served only with a valid signed token (?t=) or an authenticated JWT.
  app.get('/hls/:slug/*', async (req: FastifyRequest, reply: FastifyReply) => {
    const { slug, '*': rel } = req.params as { slug: string; '*': string };
    const token = (req.query as { t?: string }).t;
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) return reply.code(404).send();
    if (!verifyMediaToken(slug, token)) {
      try {
        await req.jwtVerify();
      } catch {
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Media token missing or expired' } });
      }
    }
    const base = path.resolve(config.hlsDir, slug);
    const target = path.resolve(base, rel);
    if (!target.startsWith(base + path.sep)) return reply.code(404).send();
    let stat;
    try {
      stat = await fsp.stat(target);
    } catch {
      return reply.code(404).send();
    }
    if (!stat.isFile()) return reply.code(404).send();
    if (target.endsWith('.m3u8')) {
      // Players resolve relative URIs without the playlist's query string, so every relative
      // URI (variants, segments, URI="..." attributes) is rewritten to carry a fresh media token.
      // Live players refetch playlists continually, so segment tokens never go stale.
      const mediaToken = signMediaToken(slug);
      const text = await fsp.readFile(target, 'utf8');
      const withToken = (uri: string) => (/^(https?:|\/)/.test(uri) ? uri : `${uri}${uri.includes('?') ? '&' : '?'}t=${mediaToken}`);
      const body = text
        .split('\n')
        .map((line) => {
          const l = line.replace(/\r$/, '');
          if (l === '' ) return line;
          if (!l.startsWith('#')) return withToken(l);
          return l.replace(/URI="([^"]+)"/g, (_m, u: string) => `URI="${withToken(u)}"`);
        })
        .join('\n');
      reply.header('Content-Type', 'application/vnd.apple.mpegurl');
      reply.header('Cache-Control', 'no-cache, no-store');
      return reply.send(body);
    } else if (target.endsWith('.ts')) {
      reply.header('Content-Type', 'video/mp2t');
      reply.header('Cache-Control', 'public, max-age=30');
    } else if (target.endsWith('.m4s') || target.endsWith('.mp4')) {
      reply.header('Content-Type', target.endsWith('.mp4') ? 'video/mp4' : 'video/iso.segment');
    } else {
      return reply.code(404).send();
    }
    reply.header('Content-Length', stat.size);
    return reply.send(fs.createReadStream(target));
  });

  // ---------- WebSocket live events ----------
  app.get('/ws', { websocket: true }, (conn, req) => {
    const socket = conn.socket;
    const token = (req.query as { token?: string }).token;
    let user: JwtUser | null = null;
    try {
      user = app.jwt.verify<JwtUser>(token ?? '');
    } catch {
      socket.send(JSON.stringify({ type: 'error', payload: { code: 'UNAUTHORIZED' } }));
      socket.close(4401, 'unauthorized');
      return;
    }
    socket.send(JSON.stringify({ type: 'hello', payload: { user: user.email, role: user.role }, at: new Date().toISOString() }));
    const onEvent = (evt: IoEvent) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(evt));
    };
    bus.on('event', onEvent);
    const ping = setInterval(() => {
      if (socket.readyState === 1) socket.ping();
    }, 25_000);
    socket.on('message', (raw: Buffer) => {
      if (raw.toString() === 'ping') socket.send(JSON.stringify({ type: 'pong', at: new Date().toISOString() }));
    });
    socket.on('close', () => {
      bus.off('event', onEvent);
      clearInterval(ping);
    });
  });
}

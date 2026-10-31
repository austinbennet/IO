import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db.js';
import { requirePermission } from '../auth.js';
import { graphics } from '../lib/graphics.js';
import { recordingManager } from '../lib/recorder.js';
import { streamManager, StreamError } from '../lib/streamManager.js';
import { computeNextRun, type ScheduleRow } from '../lib/scheduler.js';
import { recordSystemEvent, publish } from '../lib/events.js';

const uuid = z.string().uuid();
const CHANNEL_ACTIONS = ['START_STREAM', 'STOP_STREAM', 'RESTART_STREAM', 'START_RECORDING', 'STOP_RECORDING', 'GRAPHICS_PLAY', 'GRAPHICS_STOP'] as const;
const ALL_ACTIONS = [...CHANNEL_ACTIONS, 'SYSTEM_EVENT'] as const;

const scheduleBody = z.object({
  name: z.string().trim().min(1).max(160),
  channelId: uuid.nullable().optional(),
  action: z.enum(ALL_ACTIONS),
  recurrence: z.enum(['ONCE', 'DAILY', 'WEEKLY']),
  timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  runAt: z.string().datetime().nullable().optional(),
  timezone: z.string().trim().min(1).max(64).default('UTC'),
  params: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
}).superRefine((v, ctx) => {
  if (CHANNEL_ACTIONS.includes(v.action as (typeof CHANNEL_ACTIONS)[number]) && !v.channelId) {
    ctx.addIssue({ code: 'custom', path: ['channelId'], message: `${v.action} requires channelId` });
  }
  if (v.recurrence !== 'ONCE' && !v.timeOfDay) ctx.addIssue({ code: 'custom', path: ['timeOfDay'], message: 'timeOfDay (HH:MM) is required' });
  if (v.recurrence === 'WEEKLY' && (!v.daysOfWeek || v.daysOfWeek.length === 0)) ctx.addIssue({ code: 'custom', path: ['daysOfWeek'], message: 'daysOfWeek is required for WEEKLY' });
  if (v.recurrence === 'ONCE' && !v.runAt) ctx.addIssue({ code: 'custom', path: ['runAt'], message: 'runAt is required for ONCE' });
  if (v.action === 'GRAPHICS_PLAY' && (typeof v.params.templateSlug !== 'string' || typeof v.params.layer !== 'number')) {
    ctx.addIssue({ code: 'custom', path: ['params'], message: 'GRAPHICS_PLAY requires params.templateSlug and params.layer' });
  }
  if (!v.timezone || !isValidTimezone(v.timezone)) ctx.addIssue({ code: 'custom', path: ['timezone'], message: 'Unknown IANA timezone' });
});

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof StreamError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
  throw err;
}

/** Executes one scheduled action. Every action is idempotent (starting a running stream is a no-op). */
export async function executeScheduledAction(s: ScheduleRow): Promise<Record<string, unknown> | void> {
  const channelId = s.channel_id ?? '';
  const p = s.params as Record<string, unknown>;
  switch (s.action) {
    case 'START_STREAM': return streamManager.start(channelId, { reason: `schedule:${s.name}` });
    case 'STOP_STREAM': return streamManager.stop(channelId, `schedule:${s.name}`);
    case 'RESTART_STREAM': return streamManager.restart(channelId);
    case 'START_RECORDING': {
      const active = await query<{ id: string }>("SELECT id FROM recordings WHERE channel_id = $1 AND status = 'RECORDING'", [channelId]);
      if (active.rows[0]) return { skipped: true, reason: 'already recording' };
      return recordingManager.start(channelId, null, typeof p.maxMinutes === 'number' ? p.maxMinutes : undefined);
    }
    case 'STOP_RECORDING': {
      const active = await query<{ id: string }>("SELECT id FROM recordings WHERE channel_id = $1 AND status = 'RECORDING'", [channelId]);
      if (!active.rows[0]) return { skipped: true, reason: 'not recording' };
      return recordingManager.stop(active.rows[0].id);
    }
    case 'GRAPHICS_PLAY': return graphics.take(channelId, Number(p.layer), String(p.templateSlug), (p.data as Record<string, string>) ?? {}, null);
    case 'GRAPHICS_STOP': return graphics.stop(channelId, Number(p.layer ?? 1), null);
    case 'SYSTEM_EVENT': {
      await recordSystemEvent('INFO', 'scheduler', 'SCHEDULED_ANNOUNCEMENT', String(p.message ?? s.name), { scheduleId: s.id });
      return { recorded: true };
    }
    default: throw new Error(`Unknown action ${s.action}`);
  }
}

export async function broadcastRoutes(app: FastifyInstance): Promise<void> {
  // ---------- Streams ----------
  app.get('/api/streams', { preHandler: requirePermission('channels:read') }, async () => {
    const rows = (await query<{ id: string; slug: string; name: string; status: string }>(
      "SELECT id, slug, name, status FROM channels WHERE status <> 'ARCHIVED' ORDER BY name",
    )).rows;
    const persisted = (await query<{ channel_id: string; state: string; restart_count: number; last_error: string | null; active_source_role: string | null }>(
      'SELECT channel_id, state, restart_count, last_error, active_source_role FROM streams',
    )).rows;
    return {
      items: rows.map((c) => {
        const live = streamManager.status(c.id) as Record<string, unknown>;
        const row = persisted.find((p) => p.channel_id === c.id);
        return {
          channelId: c.id, slug: c.slug, name: c.name,
          state: live.running ? live.state : row?.state ?? 'STOPPED',
          running: Boolean(live.running),
          activeSourceRole: live.activeSourceRole ?? row?.active_source_role ?? null,
          restartCount: row?.restart_count ?? 0,
          lastError: row?.last_error ?? null,
          progress: live.progress ?? null,
          hls: `/hls/${c.slug}/master.m3u8`,
        };
      }),
      limits: { maxConcurrentStreams: config.ffmpeg.maxConcurrentStreams, ladder: streamManager.ladderNames },
    };
  });

  app.get('/api/streams/:id/status', { preHandler: requirePermission('channels:read') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = (await query('SELECT s.*, c.slug FROM channels c LEFT JOIN streams s ON s.channel_id = c.id WHERE c.id = $1', [id])).rows[0];
    if (!row) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Channel not found' } });
    return { channelId: id, persisted: row, live: streamManager.status(id) };
  });

  const sourceBody = z.object({ source: z.enum(['PRIMARY', 'BACKUP']).optional() }).default({});
  app.post('/api/streams/:id/start', { preHandler: requirePermission('streams:control') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = sourceBody.parse(req.body ?? {});
    try {
      const status = await streamManager.start(uuid.parse(id), { source: body.source, reason: `operator:${req.user!.email}` });
      publish('stream.state', { channelId: id, ...status });
      return status;
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/streams/:id/stop', { preHandler: requirePermission('streams:control') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await streamManager.stop(uuid.parse(id), `operator:${req.user!.email}`);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/streams/:id/restart', { preHandler: requirePermission('streams:control') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await streamManager.restart(uuid.parse(id));
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ---------- Graphics ----------
  app.get('/api/graphics/templates', { preHandler: requirePermission('channels:read') }, async () => {
    const rows = (await query(
      'SELECT slug, name, category, description, template_path AS "templatePath", fields FROM graphics_templates WHERE is_active ORDER BY category, name',
    )).rows;
    return { items: rows };
  });

  app.get('/api/graphics/status', { preHandler: requirePermission('channels:read') }, async (req) => {
    const q = z.object({ channelId: uuid.optional() }).parse(req.query);
    const rows = (await query(
      `SELECT l.channel_id, l.layer, l.state, l.data, l.updated_at, t.slug AS template_slug, t.name AS template_name
         FROM graphics_layers l LEFT JOIN graphics_templates t ON t.id = l.template_id
        WHERE ($1::uuid IS NULL OR l.channel_id = $1) ORDER BY l.channel_id, l.layer`,
      [q.channelId ?? null],
    )).rows;
    return { connection: graphics.status(), layers: rows };
  });

  app.get('/api/graphics/events', { preHandler: requirePermission('channels:read') }, async (req) => {
    const q = z.object({ channelId: uuid.optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const rows = (await query(
      `SELECT id, channel_id, layer, template_slug, action, status, error, payload, created_at, completed_at
         FROM graphics_events WHERE ($1::uuid IS NULL OR channel_id = $1) ORDER BY created_at DESC LIMIT $2`,
      [q.channelId ?? null, q.limit],
    )).rows;
    return { items: rows };
  });

  const layerBody = z.object({ channelId: uuid, layer: z.number().int().min(1).max(8) });
  const dataSchema = z.record(z.string(), z.string().max(500)).default({});

  app.post('/api/graphics/play', { preHandler: requirePermission('graphics:control') }, async (req, reply) => {
    const body = layerBody.extend({ templateSlug: z.string().min(1).max(80), data: dataSchema }).parse(req.body);
    try {
      return await graphics.take(body.channelId, body.layer, body.templateSlug, body.data, req.user!.sub);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/graphics/update', { preHandler: requirePermission('graphics:control') }, async (req, reply) => {
    const body = layerBody.extend({ data: dataSchema }).parse(req.body);
    try {
      return await graphics.update(body.channelId, body.layer, body.data, req.user!.sub);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/graphics/stop', { preHandler: requirePermission('graphics:control') }, async (req, reply) => {
    const body = layerBody.parse(req.body);
    try {
      return await graphics.stop(body.channelId, body.layer, req.user!.sub);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/graphics/reconnect', { preHandler: requirePermission('graphics:control') }, async (_req, reply) => {
    try {
      await graphics.connect();
      return graphics.status();
    } catch (err) {
      return fail(reply, new StreamError((err as Error).message, 503, 'GRAPHICS_UNAVAILABLE'));
    }
  });

  // ---------- Recordings ----------
  app.get('/api/recordings', { preHandler: requirePermission('channels:read') }, async (req) => {
    const q = z.object({
      channelId: uuid.optional(),
      status: z.enum(['RECORDING', 'COMPLETED', 'FAILED', 'STOPPED']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(req.query);
    const rows = (await query(
      `SELECT r.id, r.channel_id, c.name AS channel_name, c.slug, r.status, r.file_size_bytes, r.duration_seconds,
              r.resolution, r.codec, r.started_at, r.ended_at, r.retention_until, r.error
         FROM recordings r LEFT JOIN channels c ON c.id = r.channel_id
        WHERE ($1::uuid IS NULL OR r.channel_id = $1) AND ($2::text IS NULL OR r.status = $2)
        ORDER BY r.started_at DESC LIMIT $3`,
      [q.channelId ?? null, q.status ?? null, q.limit],
    )).rows;
    return { items: rows, activeCount: recordingManager.activeCount() };
  });

  app.get('/api/recordings/storage', { preHandler: requirePermission('system:read') }, async () => {
    const free = await recordingManager.freeBytes();
    const used = (await query<{ n: string }>('SELECT COALESCE(sum(file_size_bytes),0)::text AS n FROM recordings')).rows[0].n;
    return {
      freeBytes: free,
      minFreeBytes: config.recordings.minFreeGb * 1024 ** 3,
      recordedBytes: Number(used),
      alert: free < config.recordings.minFreeGb * 1024 ** 3,
    };
  });

  app.post('/api/recordings/start', { preHandler: requirePermission('recordings:control') }, async (req, reply) => {
    const body = z.object({ channelId: uuid, maxMinutes: z.number().int().min(1).max(config.recordings.maxRecordingMinutes).optional() }).parse(req.body);
    try {
      const rec = await recordingManager.start(body.channelId, req.user!.sub, body.maxMinutes);
      return reply.code(201).send(rec);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/recordings/stop', { preHandler: requirePermission('recordings:control') }, async (req, reply) => {
    const body = z.object({ recordingId: uuid }).parse(req.body);
    try {
      return await recordingManager.stop(body.recordingId);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get('/api/recordings/:id/download', { preHandler: requirePermission('channels:read') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = (await query<{ file_path: string; status: string; channel_id: string | null }>('SELECT file_path, status, channel_id FROM recordings WHERE id = $1', [id])).rows[0];
    if (!rec || !rec.file_path) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Recording file not found' } });
    if (rec.status === 'RECORDING') return reply.code(409).send({ error: { code: 'IN_PROGRESS', message: 'Recording is still in progress' } });
    // Only files inside the recordings directory may be served (defence against path tampering).
    const resolved = await fsp.realpath(rec.file_path).catch(() => null);
    const root = await fsp.realpath(config.recordingsDir);
    if (!resolved || !resolved.startsWith(root + '/')) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Recording file not found' } });
    const stat = await fsp.stat(resolved);
    reply.header('Content-Type', 'video/mp2t');
    reply.header('Content-Length', stat.size);
    reply.header('Content-Disposition', `attachment; filename="recording-${id}.ts"`);
    return reply.send(fs.createReadStream(resolved));
  });

  // ---------- Schedules ----------
  app.get('/api/schedule', { preHandler: requirePermission('channels:read') }, async () => {
    const rows = (await query(
      `SELECT s.id, s.name, s.channel_id, s.action, s.recurrence, s.time_of_day, s.days_of_week, s.run_at, s.timezone,
              s.params, s.enabled, s.next_run_at, s.last_run_at, c.name AS channel_name
         FROM schedules s LEFT JOIN channels c ON c.id = s.channel_id ORDER BY s.next_run_at NULLS LAST, s.name`,
    )).rows;
    return { items: rows };
  });

  app.get('/api/schedule/runs', { preHandler: requirePermission('channels:read') }, async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const rows = (await query(
      `SELECT r.id, r.schedule_id, s.name, r.scheduled_for, r.status, r.started_at, r.finished_at, r.error
         FROM schedule_runs r JOIN schedules s ON s.id = r.schedule_id ORDER BY r.scheduled_for DESC LIMIT $1`,
      [q.limit],
    )).rows;
    return { items: rows };
  });

  app.post('/api/schedule', { preHandler: requirePermission('schedules:write') }, async (req, reply) => {
    const body = scheduleBody.parse(req.body);
    const shape = toShape(body);
    const next = computeNextRun(shape, new Date());
    if (body.recurrence === 'ONCE' && (!next || next <= new Date())) {
      return reply.code(422).send({ error: { code: 'VALIDATION', message: 'runAt must be in the future' } });
    }
    const row = (await query<{ id: string }>(
      `INSERT INTO schedules (name, channel_id, action, recurrence, time_of_day, days_of_week, run_at, timezone, params, enabled, next_run_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [body.name, body.channelId ?? null, body.action, body.recurrence, body.timeOfDay ?? null, body.daysOfWeek ?? [],
        body.runAt ?? null, body.timezone, JSON.stringify(body.params), body.enabled, body.enabled ? next : null, req.user!.sub],
    )).rows[0];
    publish('schedule.changed', { scheduleId: row.id, action: 'CREATED' });
    return reply.code(201).send({ id: row.id, nextRunAt: next });
  });

  app.put('/api/schedule/:id', { preHandler: requirePermission('schedules:write') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = scheduleBody.parse(req.body);
    const shape = toShape(body);
    const next = computeNextRun(shape, new Date());
    const res = await query(
      `UPDATE schedules SET name=$2, channel_id=$3, action=$4, recurrence=$5, time_of_day=$6, days_of_week=$7, run_at=$8,
         timezone=$9, params=$10, enabled=$11, next_run_at=$12, updated_at=now() WHERE id=$1`,
      [id, body.name, body.channelId ?? null, body.action, body.recurrence, body.timeOfDay ?? null, body.daysOfWeek ?? [],
        body.runAt ?? null, body.timezone, JSON.stringify(body.params), body.enabled, body.enabled ? next : null],
    );
    if (res.rowCount === 0) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Schedule not found' } });
    publish('schedule.changed', { scheduleId: id, action: 'UPDATED' });
    return { id, nextRunAt: next };
  });

  app.delete('/api/schedule/:id', { preHandler: requirePermission('schedules:write') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const res = await query('DELETE FROM schedules WHERE id = $1', [id]);
    if (res.rowCount === 0) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Schedule not found' } });
    publish('schedule.changed', { scheduleId: id, action: 'DELETED' });
    return reply.code(204).send();
  });
}

function toShape(b: z.infer<typeof scheduleBody>): Pick<ScheduleRow, 'recurrence' | 'time_of_day' | 'days_of_week' | 'run_at' | 'timezone'> {
  return {
    recurrence: b.recurrence,
    time_of_day: b.timeOfDay ?? null,
    days_of_week: b.daysOfWeek ?? [],
    run_at: b.runAt ? new Date(b.runAt) : null,
    timezone: b.timezone,
  };
}

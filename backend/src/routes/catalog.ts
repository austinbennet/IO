import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import { authenticate, hasPermission, requirePermission } from '../auth.js';
import { assertSafeExternalUrl, signMediaToken, redactUrl, UnsafeUrlError } from '../lib/security.js';
import { buildM3U } from '../lib/m3u.js';
import { streamManager, StreamError } from '../lib/streamManager.js';
import { parseXmltv } from '../lib/xmltv.js';
import { fetchTextSafe } from '../lib/fetchSafe.js';
import { MAX_PLAYLIST_BYTES } from '../lib/m3u.js';
import { createPlaylistFromContent, refreshPlaylist, storeParsedPlaylist, type PlaylistRow } from '../services/playlists.js';
import { EPG_WINDOW_DAYS, importXmltv, refreshEpgSourceFromUrl } from '../services/epg.js';
import { recordSystemEvent, publish } from '../lib/events.js';

// ---------- Validation schemas ----------
const slugSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'slug must be 2-63 chars: a-z, 0-9, dashes');
const sourceSchema = z.object({
  sourceType: z.enum(['URL', 'LAVFI_TEST']),
  sourceUrl: z.string().trim().min(1).max(2048),
});
const channelBase = z.object({
  slug: slugSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  category: z.string().trim().min(1).max(80).optional(),
  language: z.string().trim().min(2).max(16).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
  epgChannelId: z.string().trim().max(200).nullable().optional(),
  logoUrl: z.string().trim().max(2048).nullable().optional(),
  encodingProfile: z.object({ fps: z.number().int().min(10).max(60).optional(), casparChannel: z.number().int().min(1).max(16).optional() }).optional(),
  recordingConfig: z.object({ enabled: z.boolean().optional(), retentionDays: z.number().int().min(1).max(365).optional() }).optional(),
  branding: z.object({
    primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    secondaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    fontFamily: z.string().max(60).optional(),
    logoPosition: z.enum(['TOP_LEFT', 'TOP_RIGHT', 'BOTTOM_LEFT', 'BOTTOM_RIGHT']).optional(),
  }).optional(),
  streams: z.object({
    primary: sourceSchema.nullable().optional(),
    backup: sourceSchema.nullable().optional(),
  }).optional(),
});
const channelCreate = channelBase; // slug and name are required by the base schema; other fields get defaults in the handler
const channelUpdate = channelBase.partial();

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(80).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
});

interface ChannelRow {
  id: string; slug: string; name: string; description: string; category: string; language: string; timezone: string;
  status: string; epg_channel_id: string | null; logo_url: string | null; encoding_profile: Record<string, unknown>;
  recording_config: Record<string, unknown>; created_at: Date; updated_at: Date;
  primary_color?: string; secondary_color?: string; font_family?: string; logo_position?: string;
  stream_state?: string | null; active_source_role?: string | null; last_error?: string | null;
}

function sourceDto(row: { source_type: string; source_url: string; role: string; enabled: boolean } | undefined) {
  if (!row) return null;
  // Never return credentials or query tokens of origin URLs to clients.
  return { sourceType: row.source_type, sourceUrl: row.source_type === 'URL' ? redactUrl(row.source_url) : row.source_url, enabled: row.enabled };
}

async function channelDto(id: string) {
  const row = (await query<ChannelRow>(
    `SELECT c.*, b.primary_color, b.secondary_color, b.font_family, b.logo_position,
            s.state AS stream_state, s.active_source_role, s.last_error
       FROM channels c
       LEFT JOIN channel_branding b ON b.channel_id = c.id
       LEFT JOIN streams s ON s.channel_id = c.id
      WHERE c.id = $1`,
    [id],
  )).rows[0];
  if (!row) return null;
  const sources = (await query<{ role: string; source_type: string; source_url: string; enabled: boolean }>(
    'SELECT role, source_type, source_url, enabled FROM channel_streams WHERE channel_id = $1', [id],
  )).rows;
  return toDto(row, sources);
}

function toDto(row: ChannelRow, sources: Array<{ role: string; source_type: string; source_url: string; enabled: boolean }>) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    category: row.category,
    language: row.language,
    timezone: row.timezone,
    status: row.status,
    epgChannelId: row.epg_channel_id,
    logoUrl: row.logo_url,
    encodingProfile: row.encoding_profile,
    recordingConfig: row.recording_config,
    branding: {
      primaryColor: row.primary_color ?? '#FFFFFF',
      secondaryColor: row.secondary_color ?? '#1A1A1A',
      fontFamily: row.font_family ?? 'Inter',
      logoPosition: row.logo_position ?? 'TOP_RIGHT',
    },
    streams: {
      primary: sourceDto(sources.find((s) => s.role === 'PRIMARY')),
      backup: sourceDto(sources.find((s) => s.role === 'BACKUP')),
    },
    streamState: row.stream_state ?? 'STOPPED',
    activeSourceRole: row.active_source_role ?? null,
    lastError: row.last_error ?? null,
    hlsUrl: `/hls/${row.slug}/master.m3u8`,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function validateSource(s: { sourceType: 'URL' | 'LAVFI_TEST'; sourceUrl: string }): Promise<void> {
  if (s.sourceType === 'LAVFI_TEST') {
    if (!config.security.allowLavfiSources) throw new StreamError('Built-in test sources are disabled on this server', 403, 'SOURCE_DISABLED');
    if (!['testsrc2', 'smptebars'].includes(s.sourceUrl)) throw new StreamError('LAVFI_TEST sourceUrl must be testsrc2 or smptebars', 422, 'VALIDATION');
    return;
  }
  try {
    await assertSafeExternalUrl(s.sourceUrl);
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw new StreamError(`Stream URL rejected: ${err.message}`, 422, 'UNSAFE_URL');
    throw err;
  }
}

async function writeSources(client: { query: (text: string, params?: unknown[]) => Promise<unknown> }, channelId: string, streams: NonNullable<z.infer<typeof channelBase>['streams']>) {
  for (const role of ['PRIMARY', 'BACKUP'] as const) {
    const key = role === 'PRIMARY' ? 'primary' : 'backup';
    const value = streams[key];
    if (value === undefined) continue;
    if (value === null) {
      await client.query('DELETE FROM channel_streams WHERE channel_id = $1 AND role = $2', [channelId, role]);
      continue;
    }
    await validateSource(value);
    await client.query(
      `INSERT INTO channel_streams (channel_id, role, source_type, source_url, enabled) VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (channel_id, role) DO UPDATE SET source_type = EXCLUDED.source_type, source_url = EXCLUDED.source_url, enabled = true, updated_at = now()`,
      [channelId, role, value.sourceType, value.sourceUrl],
    );
  }
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
}

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  // ---------- Channels ----------
  app.get('/api/channels', { preHandler: requirePermission('channels:read') }, async (req) => {
    const q = listQuery.parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.q) {
      params.push(`%${q.q.toLowerCase()}%`);
      where.push(`(lower(c.name) LIKE $${params.length} OR lower(c.slug) LIKE $${params.length})`);
    }
    if (q.category) {
      params.push(q.category);
      where.push(`c.category = $${params.length}`);
    }
    if (q.status) {
      params.push(q.status);
      where.push(`c.status = $${params.length}`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number((await query<{ n: string }>(`SELECT count(*)::text AS n FROM channels c ${clause}`, params)).rows[0].n);
    params.push(q.pageSize, (q.page - 1) * q.pageSize);
    const rows = (await query<ChannelRow>(
      `SELECT c.*, b.primary_color, b.secondary_color, b.font_family, b.logo_position, s.state AS stream_state, s.active_source_role, s.last_error
         FROM channels c LEFT JOIN channel_branding b ON b.channel_id = c.id LEFT JOIN streams s ON s.channel_id = c.id
         ${clause} ORDER BY c.category, c.name LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )).rows;
    const ids = rows.map((r) => r.id);
    const srcRows = ids.length
      ? (await query<{ channel_id: string; role: string; source_type: string; source_url: string; enabled: boolean }>(
          'SELECT channel_id, role, source_type, source_url, enabled FROM channel_streams WHERE channel_id = ANY($1::uuid[])', [ids],
        )).rows
      : [];
    return {
      items: rows.map((r) => toDto(r, srcRows.filter((s) => s.channel_id === r.id))),
      page: q.page,
      pageSize: q.pageSize,
      total,
    };
  });

  app.post('/api/channels', { preHandler: requirePermission('channels:write') }, async (req, reply) => {
    const body = channelCreate.parse(req.body);
    const id = await withTransaction(async (client) => {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO channels (slug, name, description, category, language, timezone, status, epg_channel_id, logo_url, encoding_profile, recording_config, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [body.slug, body.name, body.description ?? '', body.category ?? 'General', body.language ?? 'en', body.timezone ?? 'UTC', body.status ?? 'INACTIVE',
          body.epgChannelId ?? null, body.logoUrl ?? null, JSON.stringify(body.encodingProfile ?? {}),
          JSON.stringify({ enabled: false, retentionDays: 14, ...(body.recordingConfig ?? {}) }), req.user!.sub],
      );
      const channelId = ins.rows[0].id;
      await client.query(
        `INSERT INTO channel_branding (channel_id, primary_color, secondary_color, font_family, logo_position) VALUES ($1,$2,$3,$4,$5)`,
        [channelId, body.branding?.primaryColor ?? '#FFFFFF', body.branding?.secondaryColor ?? '#1A1A1A', body.branding?.fontFamily ?? 'Inter', body.branding?.logoPosition ?? 'TOP_RIGHT'],
      );
      if (body.streams) await writeSources(client, channelId, body.streams);
      return channelId;
    });
    await streamManager.refreshBackupCache();
    publish('channel.changed', { channelId: id, action: 'CREATED' });
    return reply.code(201).send({ channel: await channelDto(id) });
  });

  app.get('/api/channels/playlist.m3u', async (req, reply) => {
    // Auth via Authorization header, or ?access_token= for players (e.g. VLC) that cannot send headers.
    // The query token is verified directly; the request headers are never mutated.
    const qs = req.query as { access_token?: string };
    if (req.headers.authorization) {
      await authenticate(req, reply);
      if (reply.sent) return;
    } else if (qs.access_token) {
      try {
        req.user = app.jwt.verify(qs.access_token) as typeof req.user;
      } catch {
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid access token' } });
      }
    } else {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid access token' } });
    }
    if (!req.user || !hasPermission(req.user.role, 'channels:read')) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Requires permission channels:read' } });
    }
    const rows = (await query<{ slug: string; name: string; epg_channel_id: string | null; logo_url: string | null; category: string }>(
      "SELECT slug, name, epg_channel_id, logo_url, category FROM channels WHERE status = 'ACTIVE' ORDER BY category, name",
    )).rows;
    const body = buildM3U(rows.map((r) => ({
      tvgId: r.epg_channel_id,
      name: r.name,
      logo: r.logo_url,
      group: r.category,
      url: `${config.publicBaseUrl}/hls/${r.slug}/master.m3u8?t=${signMediaToken(r.slug)}`,
    })));
    reply.header('Content-Type', 'audio/x-mpegurl; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="io-channels.m3u"');
    return body;
  });

  app.get('/api/channels/:id', { preHandler: requirePermission('channels:read') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const dto = await channelDto(id).catch(() => null);
    if (!dto) return notFound(reply);
    return { channel: dto };
  });

  app.get('/api/channels/:id/stream.m3u8', { preHandler: requirePermission('channels:read') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = (await query<{ slug: string; status: string }>('SELECT slug, status FROM channels WHERE id = $1', [id])).rows[0];
    if (!row) return notFound(reply);
    const url = `/hls/${row.slug}/master.m3u8?t=${signMediaToken(row.slug)}`;
    return reply.redirect(url, 302);
  });

  app.put('/api/channels/:id', { preHandler: requirePermission('channels:write') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = channelUpdate.parse(req.body);
    const exists = (await query('SELECT 1 FROM channels WHERE id = $1', [id])).rows.length;
    if (!exists) return notFound(reply);
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE channels SET
           slug = COALESCE($2, slug), name = COALESCE($3, name), description = COALESCE($4, description),
           category = COALESCE($5, category), language = COALESCE($6, language), timezone = COALESCE($7, timezone),
           status = COALESCE($8, status), epg_channel_id = CASE WHEN $9::text IS NULL AND $10::bool THEN NULL ELSE COALESCE($9, epg_channel_id) END,
           logo_url = COALESCE($11, logo_url), encoding_profile = COALESCE($12, encoding_profile),
           recording_config = COALESCE($13, recording_config), updated_at = now()
         WHERE id = $1`,
        [id, body.slug ?? null, body.name ?? null, body.description ?? null, body.category ?? null, body.language ?? null,
          body.timezone ?? null, body.status ?? null, body.epgChannelId ?? null, body.epgChannelId === null,
          body.logoUrl ?? null, body.encodingProfile ? JSON.stringify(body.encodingProfile) : null,
          body.recordingConfig ? JSON.stringify(body.recordingConfig) : null],
      );
      if (body.branding) {
        await client.query(
          `INSERT INTO channel_branding (channel_id, primary_color, secondary_color, font_family, logo_position) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (channel_id) DO UPDATE SET primary_color = EXCLUDED.primary_color, secondary_color = EXCLUDED.secondary_color,
             font_family = EXCLUDED.font_family, logo_position = EXCLUDED.logo_position`,
          [id, body.branding.primaryColor ?? '#FFFFFF', body.branding.secondaryColor ?? '#1A1A1A', body.branding.fontFamily ?? 'Inter', body.branding.logoPosition ?? 'TOP_RIGHT'],
        );
      }
      if (body.streams) await writeSources(client, id, body.streams);
    });
    await streamManager.refreshBackupCache();
    publish('channel.changed', { channelId: id, action: 'UPDATED' });
    return { channel: await channelDto(id) };
  });

  app.delete('/api/channels/:id', { preHandler: requirePermission('channels:write') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const state = streamManager.status(id) as { running?: boolean };
    if (state.running) {
      return reply.code(409).send({ error: { code: 'CHANNEL_ON_AIR', message: 'Stop the stream before deleting the channel' } });
    }
    const res = await query('DELETE FROM channels WHERE id = $1', [id]);
    if (res.rowCount === 0) return notFound(reply);
    publish('channel.changed', { channelId: id, action: 'DELETED' });
    return reply.code(204).send();
  });

  // ---------- Favorites & watch history (per user) ----------
  app.get('/api/me/favorites', { preHandler: requirePermission('channels:read') }, async (req) => {
    const rows = (await query<{ id: string }>(
      'SELECT c.id FROM user_favorites f JOIN channels c ON c.id = f.channel_id WHERE f.user_id = $1 ORDER BY f.created_at', [req.user!.sub],
    )).rows;
    const items = [];
    for (const r of rows) items.push(await channelDto(r.id));
    return { items };
  });

  app.put('/api/me/favorites/:channelId', { preHandler: requirePermission('channels:read') }, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    const res = await query('INSERT INTO user_favorites (user_id, channel_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user!.sub, channelId]).catch(() => null);
    if (!res) return notFound(reply);
    return reply.code(204).send();
  });

  app.delete('/api/me/favorites/:channelId', { preHandler: requirePermission('channels:read') }, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    await query('DELETE FROM user_favorites WHERE user_id = $1 AND channel_id = $2', [req.user!.sub, channelId]);
    return reply.code(204).send();
  });

  app.get('/api/me/recent', { preHandler: requirePermission('channels:read') }, async (req) => {
    const rows = (await query<{ id: string }>(
      `SELECT channel_id AS id FROM watch_history WHERE user_id = $1
        GROUP BY channel_id ORDER BY max(watched_at) DESC LIMIT 20`, [req.user!.sub],
    )).rows;
    const items = [];
    for (const r of rows) items.push(await channelDto(r.id));
    return { items: items.filter(Boolean) };
  });

  app.post('/api/me/recent/:channelId', { preHandler: requirePermission('channels:read') }, async (req, reply) => {
    const { channelId } = req.params as { channelId: string };
    const res = await query('INSERT INTO watch_history (user_id, channel_id) SELECT $1, id FROM channels WHERE id = $2 RETURNING id', [req.user!.sub, channelId]);
    if (res.rowCount === 0) return notFound(reply);
    return reply.code(204).send();
  });

  // ---------- Playlists ----------
  app.get('/api/playlists', { preHandler: requirePermission('playlists:read') }, async () => {
    const rows = (await query<PlaylistRow>(
      `SELECT id, name, source_type, source_url, NULL::text AS source_content, auto_refresh_minutes, channel_count, duplicate_count,
              last_refreshed_at, last_error, created_at, updated_at FROM playlists ORDER BY created_at DESC`,
    )).rows;
    return {
      items: rows.map((p) => ({
        id: p.id, name: p.name, sourceType: p.source_type,
        sourceUrl: p.source_url ? redactUrl(p.source_url) : null,
        autoRefreshMinutes: p.auto_refresh_minutes, channelCount: p.channel_count, duplicateCount: p.duplicate_count,
        lastRefreshedAt: p.last_refreshed_at, lastError: p.last_error, createdAt: p.created_at,
      })),
    };
  });

  const playlistCreate = z.object({
    name: z.string().trim().min(1).max(160),
    sourceUrl: z.string().trim().max(2048).optional(),
    content: z.string().max(MAX_PLAYLIST_BYTES).optional(),
    autoRefreshMinutes: z.number().int().min(0).max(10080).default(0),
  });

  app.post('/api/playlists', { preHandler: requirePermission('playlists:write') }, async (req, reply) => {
    const body = playlistCreate.parse(req.body);
    if (!body.sourceUrl && !body.content) return reply.code(422).send({ error: { code: 'VALIDATION', message: 'Provide sourceUrl or content' } });
    let content = body.content ?? '';
    if (body.sourceUrl) {
      await assertSafeExternalUrl(body.sourceUrl).catch((err: Error) => { throw new StreamError(err.message, 422, 'UNSAFE_URL'); });
      content = await fetchTextSafe(body.sourceUrl, { maxBytes: MAX_PLAYLIST_BYTES });
    }
    const id = await createPlaylistFromContent({
      name: body.name, sourceType: body.sourceUrl ? 'URL' : 'FILE', sourceUrl: body.sourceUrl ?? null,
      content, autoRefreshMinutes: body.autoRefreshMinutes, createdBy: req.user!.sub,
    });
    return reply.code(201).send({ id });
  });

  app.post('/api/playlists/import', { preHandler: requirePermission('playlists:write') }, async (req, reply) => {
    const file = await (req as FastifyRequest & { file: () => Promise<{ filename: string; toBuffer: () => Promise<Buffer> } | undefined> }).file();
    if (!file) return reply.code(422).send({ error: { code: 'VALIDATION', message: 'Upload an .m3u or .m3u8 file in field "file"' } });
    if (!/\.(m3u8?|txt)$/i.test(file.filename)) return reply.code(422).send({ error: { code: 'UNSUPPORTED_TYPE', message: 'Only .m3u / .m3u8 files are accepted' } });
    const buf = await file.toBuffer();
    if (buf.length > MAX_PLAYLIST_BYTES) return reply.code(413).send({ error: { code: 'TOO_LARGE', message: 'Playlist exceeds 25 MB' } });
    const name = (req.query as { name?: string }).name?.trim() || file.filename.replace(/\.(m3u8?|txt)$/i, '');
    const id = await createPlaylistFromContent({
      name, sourceType: 'FILE', sourceUrl: null, content: buf.toString('utf8'), autoRefreshMinutes: 0, createdBy: req.user!.sub,
    });
    const row = (await query<{ channel_count: number; duplicate_count: number }>('SELECT channel_count, duplicate_count FROM playlists WHERE id = $1', [id])).rows[0];
    return reply.code(201).send({ id, channelCount: row.channel_count, duplicateCount: row.duplicate_count });
  });

  app.post('/api/playlists/:id/refresh', { preHandler: requirePermission('playlists:write') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = (await query<PlaylistRow>('SELECT * FROM playlists WHERE id = $1', [id])).rows[0];
    if (!row) return notFound(reply);
    try {
      const parsed = await refreshPlaylist(row);
      return { id, channelCount: parsed.channels.length, duplicateCount: parsed.duplicates, warnings: parsed.warnings };
    } catch (err) {
      return reply.code(502).send({ error: { code: 'REFRESH_FAILED', message: (err as Error).message } });
    }
  });

  app.put('/api/playlists/:id', { preHandler: requirePermission('playlists:write') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().trim().min(1).max(160).optional(), autoRefreshMinutes: z.number().int().min(0).max(10080).optional() }).parse(req.body);
    const res = await query(
      'UPDATE playlists SET name = COALESCE($2, name), auto_refresh_minutes = COALESCE($3, auto_refresh_minutes), updated_at = now() WHERE id = $1',
      [id, body.name ?? null, body.autoRefreshMinutes ?? null],
    );
    if (res.rowCount === 0) return notFound(reply);
    return reply.code(204).send();
  });

  app.delete('/api/playlists/:id', { preHandler: requirePermission('playlists:write') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const res = await query('DELETE FROM playlists WHERE id = $1', [id]);
    if (res.rowCount === 0) return notFound(reply);
    return reply.code(204).send();
  });

  app.get('/api/playlists/:id/channels', { preHandler: requirePermission('playlists:read') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = z.object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(200).default(50),
      q: z.string().trim().max(120).optional(),
      group: z.string().trim().max(120).optional(),
      duplicates: z.enum(['include', 'exclude']).default('include'),
    }).parse(req.query);
    const exists = (await query('SELECT 1 FROM playlists WHERE id = $1', [id])).rows.length;
    if (!exists) return notFound(reply);
    const where = ['playlist_id = $1'];
    const params: unknown[] = [id];
    if (q.q) { params.push(`%${q.q.toLowerCase()}%`); where.push(`lower(title) LIKE $${params.length}`); }
    if (q.group) { params.push(q.group); where.push(`group_title = $${params.length}`); }
    if (q.duplicates === 'exclude') where.push('NOT is_duplicate');
    const clause = where.join(' AND ');
    const total = Number((await query<{ n: string }>(`SELECT count(*)::text n FROM playlist_channels WHERE ${clause}`, params)).rows[0].n);
    params.push(q.pageSize, (q.page - 1) * q.pageSize);
    const rows = (await query<{ id: string; position: number; title: string; tvg_id: string | null; tvg_logo: string | null; group_title: string | null; url_valid: boolean; is_duplicate: boolean; stream_hash: string; attributes: Record<string, string> }>(
      `SELECT id, position, title, tvg_id, tvg_logo, group_title, url_valid, is_duplicate, stream_hash, attributes
         FROM playlist_channels WHERE ${clause} ORDER BY position LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )).rows;
    // Stream URLs are intentionally not returned: they may carry tokens and are only used server-side.
    return {
      items: rows.map((r) => ({ id: r.id, position: r.position, title: r.title, tvgId: r.tvg_id, tvgLogo: r.tvg_logo, groupTitle: r.group_title, urlValid: r.url_valid, isDuplicate: r.is_duplicate, streamRef: r.stream_hash.slice(0, 12) })),
      page: q.page, pageSize: q.pageSize, total,
    };
  });

  app.get('/api/playlists/:id/groups', { preHandler: requirePermission('playlists:read') }, async (req) => {
    const { id } = req.params as { id: string };
    const rows = (await query<{ group_title: string | null; n: string }>(
      'SELECT group_title, count(*)::text n FROM playlist_channels WHERE playlist_id = $1 GROUP BY group_title ORDER BY group_title NULLS LAST', [id],
    )).rows;
    return { items: rows.map((r) => ({ group: r.group_title ?? 'Ungrouped', count: Number(r.n) })) };
  });

  // ---------- EPG ----------
  app.get('/api/epg/sources', { preHandler: requirePermission('epg:read') }, async () => {
    const rows = (await query('SELECT id, name, url, channel_count, program_count, last_imported_at, last_error FROM epg_sources ORDER BY created_at')).rows;
    return { items: rows.map((r) => ({ ...r, url: r.url ? redactUrl(r.url) : null })) };
  });

  app.post('/api/epg/import', { preHandler: requirePermission('epg:write') }, async (req, reply) => {
    const body = z.object({
      name: z.string().trim().min(1).max(160),
      url: z.string().trim().max(2048).optional(),
      xml: z.string().max(80 * 1024 * 1024).optional(),
    }).parse(req.body);
    if (!body.url && !body.xml) return reply.code(422).send({ error: { code: 'VALIDATION', message: 'Provide url or xml' } });
    const source = (await query<{ id: string }>(
      'INSERT INTO epg_sources (name, url) VALUES ($1, $2) RETURNING id', [body.name, body.url ?? null],
    )).rows[0];
    try {
      const result = body.url
        ? await refreshEpgSourceFromUrl(source.id, body.url)
        : await importXmltv(source.id, parseXmltv(body.xml!));
      await recordSystemEvent('INFO', 'epg', 'EPG_IMPORTED', `EPG source "${body.name}" imported: ${result.programs} programmes`, { sourceId: source.id });
      return reply.code(201).send({ id: source.id, ...result });
    } catch (err) {
      await query('DELETE FROM epg_sources WHERE id = $1', [source.id]);
      return reply.code(422).send({ error: { code: 'EPG_IMPORT_FAILED', message: (err as Error).message } });
    }
  });

  app.get('/api/epg', { preHandler: requirePermission('epg:read') }, async (req) => {
    const q = z.object({
      channelId: z.string().uuid().optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      limit: z.coerce.number().int().min(1).max(2000).default(500),
    }).parse(req.query);
    const from = q.from ? new Date(q.from) : new Date();
    const to = q.to ? new Date(q.to) : new Date(from.getTime() + 24 * 3600_000);
    const maxTo = new Date(from.getTime() + EPG_WINDOW_DAYS * 24 * 3600_000);
    const effectiveTo = to > maxTo ? maxTo : to;
    const params: unknown[] = [from, effectiveTo, q.limit];
    let join = '';
    if (q.channelId) {
      params.push(q.channelId);
      join = 'JOIN channels c ON c.epg_channel_id = p.epg_channel_id AND c.id = $4';
    }
    const rows = (await query(
      `SELECT p.epg_channel_id, p.start_at, p.stop_at, p.title, p.description, p.category
         FROM epg_programs p ${join}
        WHERE p.stop_at > $1 AND p.start_at < $2 ORDER BY p.start_at LIMIT $3`,
      params,
    )).rows;
    return { from, to: effectiveTo, items: rows };
  });

  app.get('/api/epg/channel/:id', { preHandler: requirePermission('epg:read') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ch = (await query<{ epg_channel_id: string | null; name: string }>('SELECT epg_channel_id, name FROM channels WHERE id = $1', [id])).rows[0];
    if (!ch) return notFound(reply);
    if (!ch.epg_channel_id) {
      return { channelId: id, epgChannelId: null, current: null, next: null, programs: [], note: 'Channel has no EPG mapping (set epgChannelId to the XMLTV channel id)' };
    }
    const now = new Date();
    const programs = (await query(
      `SELECT start_at, stop_at, title, description, category FROM epg_programs
        WHERE epg_channel_id = $1 AND stop_at > $2 AND start_at < $3 ORDER BY start_at LIMIT 400`,
      [ch.epg_channel_id, now, new Date(now.getTime() + EPG_WINDOW_DAYS * 24 * 3600_000)],
    )).rows;
    const current = programs.find((p) => new Date(p.start_at) <= now && new Date(p.stop_at) > now) ?? null;
    const next = programs.find((p) => new Date(p.start_at) > now) ?? null;
    return { channelId: id, epgChannelId: ch.epg_channel_id, current, next, programs };
  });

  app.get('/api/epg/now', { preHandler: requirePermission('epg:read') }, async () => {
    const now = new Date();
    const rows = (await query(
      `SELECT c.id AS channel_id, c.name, p.title, p.start_at, p.stop_at FROM channels c
         JOIN epg_programs p ON p.epg_channel_id = c.epg_channel_id AND p.start_at <= $1 AND p.stop_at > $1
        WHERE c.status = 'ACTIVE'`, [now],
    )).rows;
    return { now, items: rows };
  });
}

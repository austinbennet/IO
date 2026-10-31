import fs from 'node:fs/promises';
import path from 'node:path';
import { config, ROOT_DIR } from '../config.js';
import { query } from '../db.js';
import { AmcpClient, amcpQuote } from './amcp.js';
import { log, publish, recordSystemEvent } from './events.js';
import { StreamError } from './streamManager.js';

export class GraphicsController {
  private client = new AmcpClient(config.casparcg.host, config.casparcg.port);
  private reconnectTimer: NodeJS.Timeout | null = null;
  private version: string | null = null;

  get enabled(): boolean {
    return config.casparcg.enabled;
  }

  status(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      host: config.casparcg.host,
      port: config.casparcg.port,
      connected: this.client.connected,
      version: this.version,
      lastError: this.client.error,
    };
  }

  async connect(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.client.connect();
      const v = await this.client.send('VERSION');
      this.version = v.data[0] ?? v.status;
      log('INFO', 'graphics', 'CasparCG connected', { host: config.casparcg.host, port: config.casparcg.port, version: this.version });
      publish('graphics.connection', { connected: true, version: this.version });
    } catch (err) {
      this.client.close();
      this.scheduleReconnect();
      throw err;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.enabled) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err: Error) => {
        publish('graphics.connection', { connected: false, error: err.message });
      });
    }, 15_000);
    this.reconnectTimer.unref();
  }

  private async ensureConnected(): Promise<void> {
    if (!this.enabled) throw new StreamError('CasparCG graphics output is disabled (CASPARCG_ENABLED=false)', 503, 'GRAPHICS_DISABLED');
    if (this.client.connected) return;
    try {
      await this.connect();
    } catch (err) {
      throw new StreamError(`CasparCG unreachable at ${config.casparcg.host}:${config.casparcg.port}: ${(err as Error).message}`, 503, 'GRAPHICS_UNAVAILABLE');
    }
  }

  private async channelContext(channelId: string, layer: number): Promise<{ caspar: string; slug: string; layerId: number }> {
    const res = await query<{ slug: string; encoding_profile: { casparChannel?: number } }>(
      'SELECT slug, encoding_profile FROM channels WHERE id = $1',
      [channelId],
    );
    const ch = res.rows[0];
    if (!ch) throw new StreamError('Channel not found', 404, 'NOT_FOUND');
    if (!(layer >= 1 && layer <= 8)) throw new StreamError('Layer must be between 1 and 8', 422, 'VALIDATION');
    const casparChannel = ch.encoding_profile?.casparChannel ?? 1;
    return { caspar: `${casparChannel}-${layer}`, slug: ch.slug, layerId: layer };
  }

  private async recordEvent(channelId: string, layer: number, action: string, slug: string | null, payload: Record<string, unknown>, operatorId: string | null): Promise<number> {
    const res = await query<{ id: string }>(
      `INSERT INTO graphics_events (channel_id, layer, template_slug, action, status, payload, operator_id)
       VALUES ($1, $2, $3, $4, 'PENDING', $5, $6) RETURNING id`,
      [channelId, layer, slug, action, JSON.stringify(payload), operatorId],
    );
    return Number(res.rows[0].id);
  }

  private async finishEvent(id: number, status: 'VERIFIED' | 'FAILED', error: string | null): Promise<void> {
    await query('UPDATE graphics_events SET status = $2, error = $3, completed_at = now() WHERE id = $1', [id, status, error]);
  }

  /** TAKE: loads and plays a template on a layer. Returns the verified result. */
  async take(channelId: string, layer: number, templateSlug: string, data: Record<string, string>, operatorId: string | null): Promise<Record<string, unknown>> {
    const tpl = await query<{ template_path: string; name: string }>(
      'SELECT template_path, name FROM graphics_templates WHERE slug = $1 AND is_active', [templateSlug],
    );
    if (!tpl.rows[0]) throw new StreamError('Unknown or inactive graphics template', 404, 'TEMPLATE_NOT_FOUND');
    const ctx = await this.channelContext(channelId, layer);
    const json = JSON.stringify(data);
    const eventId = await this.recordEvent(channelId, layer, 'PLAY', templateSlug, { data }, operatorId);
    try {
      await this.ensureConnected();
      // CG <channel>-<layer> ADD <flashlayer> <template> <playOnLoad> <data>
      const res = await this.client.send(`CG ${ctx.caspar} ADD 1 ${amcpQuote(tpl.rows[0].template_path)} 1 ${amcpQuote(json)}`);
      if (!res.ok) throw new Error(`AMCP ${res.code} ${res.status}`);
      await query('UPDATE graphics_events SET status = \'SENT\' WHERE id = $1', [eventId]);
      const info = await this.client.send(`CG ${ctx.caspar} INFO 1`);
      const verified = info.ok && info.data.join('\n').toLowerCase().includes(path.basename(tpl.rows[0].template_path, '.html').toLowerCase());
      if (!verified) throw new Error('Layer INFO did not confirm the template is loaded');
      await this.finishEvent(eventId, 'VERIFIED', null);
      await query(
        `INSERT INTO graphics_layers (channel_id, layer, template_id, state, data, updated_at)
         VALUES ($1, $2, (SELECT id FROM graphics_templates WHERE slug = $3), 'PLAYING', $4, now())
         ON CONFLICT (channel_id, layer) DO UPDATE SET template_id = EXCLUDED.template_id, state = 'PLAYING', data = EXCLUDED.data, updated_at = now()`,
        [channelId, layer, templateSlug, JSON.stringify(data)],
      );
      publish('graphics.state', { channelId, layer, state: 'PLAYING', templateSlug });
      return { eventId, status: 'VERIFIED', channelId, layer, templateSlug, caspar: ctx.caspar };
    } catch (err) {
      const msg = (err as Error).message;
      await this.finishEvent(eventId, 'FAILED', msg);
      await recordSystemEvent('ERROR', 'graphics', 'TAKE_FAILED', `TAKE failed for ${templateSlug} on ${ctx.slug} layer ${layer}: ${msg}`, { channelId, layer });
      if (err instanceof StreamError) throw err;
      throw new StreamError(`Graphics TAKE failed: ${msg}`, 502, 'TAKE_FAILED');
    }
  }

  async update(channelId: string, layer: number, data: Record<string, string>, operatorId: string | null): Promise<Record<string, unknown>> {
    const ctx = await this.channelContext(channelId, layer);
    const eventId = await this.recordEvent(channelId, layer, 'UPDATE', null, { data }, operatorId);
    try {
      await this.ensureConnected();
      const res = await this.client.send(`CG ${ctx.caspar} UPDATE 1 ${amcpQuote(JSON.stringify(data))}`);
      if (!res.ok) throw new Error(`AMCP ${res.code} ${res.status}`);
      await this.finishEvent(eventId, 'VERIFIED', null);
      await query('UPDATE graphics_layers SET data = $3, updated_at = now() WHERE channel_id = $1 AND layer = $2', [channelId, layer, JSON.stringify(data)]);
      return { eventId, status: 'VERIFIED', channelId, layer };
    } catch (err) {
      await this.finishEvent(eventId, 'FAILED', (err as Error).message);
      if (err instanceof StreamError) throw err;
      throw new StreamError(`Graphics update failed: ${(err as Error).message}`, 502, 'UPDATE_FAILED');
    }
  }

  async stop(channelId: string, layer: number, operatorId: string | null): Promise<Record<string, unknown>> {
    const ctx = await this.channelContext(channelId, layer);
    const eventId = await this.recordEvent(channelId, layer, 'STOP', null, {}, operatorId);
    try {
      await this.ensureConnected();
      const res = await this.client.send(`CG ${ctx.caspar} STOP 1`);
      if (!res.ok) throw new Error(`AMCP ${res.code} ${res.status}`);
      await this.finishEvent(eventId, 'VERIFIED', null);
      await query("UPDATE graphics_layers SET state = 'EMPTY', updated_at = now() WHERE channel_id = $1 AND layer = $2", [channelId, layer]);
      publish('graphics.state', { channelId, layer, state: 'EMPTY' });
      return { eventId, status: 'VERIFIED', channelId, layer };
    } catch (err) {
      await this.finishEvent(eventId, 'FAILED', (err as Error).message);
      if (err instanceof StreamError) throw err;
      throw new StreamError(`Graphics stop failed: ${(err as Error).message}`, 502, 'STOP_FAILED');
    }
  }

  /** Loads the graphics catalogue (graphics/catalog.json) into PostgreSQL. Idempotent. */
  async syncCatalog(): Promise<number> {
    const file = path.join(ROOT_DIR, 'graphics', 'catalog.json');
    let catalog: Array<{ slug: string; name: string; category: string; description: string; templatePath: string; fields: unknown[] }>;
    try {
      catalog = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      log('WARN', 'graphics', 'graphics/catalog.json missing; no templates loaded');
      return 0;
    }
    for (const t of catalog) {
      await query(
        `INSERT INTO graphics_templates (slug, name, category, description, template_path, fields)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category,
           description = EXCLUDED.description, template_path = EXCLUDED.template_path, fields = EXCLUDED.fields`,
        [t.slug, t.name, t.category, t.description, t.templatePath, JSON.stringify(t.fields)],
      );
    }
    return catalog.length;
  }

  close(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.client.close();
  }
}

export const graphics = new GraphicsController();

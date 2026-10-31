import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { config } from '../config.js';
import { query } from '../db.js';
import { buildHlsArgs, parseLadder, type SourceSpec } from './ffmpegArgs.js';
import { log, publish, recordSystemEvent } from './events.js';
import { redactUrl } from './security.js';

export type StreamState = 'STOPPED' | 'STARTING' | 'RUNNING' | 'DEGRADED' | 'FAILING_OVER' | 'FAILED';
export type SourceRole = 'PRIMARY' | 'BACKUP';

export interface ChannelSourceRow {
  role: SourceRole;
  source_type: 'URL' | 'LAVFI_TEST' | 'FILE';
  source_url: string;
  enabled: boolean;
}

export interface ChannelRow {
  id: string;
  slug: string;
  name: string;
  encoding_profile: Record<string, unknown>;
}

interface Runtime {
  channelId: string;
  slug: string;
  name: string;
  state: StreamState;
  role: SourceRole;
  proc: ChildProcess | null;
  pid: number | null;
  stopRequested: boolean;
  consecutiveFailures: number;
  restartCount: number;
  restartTimer: NodeJS.Timeout | null;
  startedAt: Date | null;
  lastStderr: string[];
  progress: { fps?: number; bitrateKbps?: number; outTimeUs?: number; frame?: number; updatedAt?: number };
  lastError: string | null;
  lastSegmentAt: number | null;
  hlsWatcher: NodeJS.Timeout | null;
}

export class StreamError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) {
    super(message);
  }
}

const RESET_RESTARTS_AFTER_MS = 10 * 60_000;

export class StreamManager {
  private runtimes = new Map<string, Runtime>();
  private monitorTimer: NodeJS.Timeout | null = null;
  private ladder = parseLadder(config.ffmpeg.ladder);

  get ladderNames(): string[] {
    return this.ladder.map((r) => r.name);
  }

  hlsDirFor(slug: string): string {
    return path.join(config.hlsDir, slug);
  }

  /** Resolves the source to feed FFmpeg for a role; returns null when the channel has no such source. */
  private async loadSourceRow(channelId: string, role: SourceRole): Promise<ChannelSourceRow | null> {
    const res = await query<ChannelSourceRow>(
      'SELECT role, source_type, source_url, enabled FROM channel_streams WHERE channel_id = $1 AND role = $2',
      [channelId, role],
    );
    const row = res.rows[0];
    return row && row.enabled ? row : null;
  }

  private toSpec(row: ChannelSourceRow): SourceSpec {
    if (row.source_type === 'LAVFI_TEST') {
      if (!config.security.allowLavfiSources) throw new StreamError('Lavfi test sources are disabled', 403, 'SOURCE_DISABLED');
      return { type: 'LAVFI_TEST', pattern: row.source_url === 'smptebars' ? 'smptebars' : 'testsrc2' };
    }
    if (row.source_type === 'FILE') throw new StreamError('File sources are not enabled for channels', 422, 'UNSUPPORTED_SOURCE');
    return { type: 'URL', url: row.source_url };
  }

  private async loadChannel(channelId: string): Promise<ChannelRow> {
    const res = await query<ChannelRow>('SELECT id, slug, name, encoding_profile FROM channels WHERE id = $1', [channelId]);
    if (!res.rows[0]) throw new StreamError('Channel not found', 404, 'NOT_FOUND');
    return res.rows[0];
  }

  private async persist(rt: Runtime, extra: Record<string, unknown> = {}): Promise<void> {
    await query(
      `INSERT INTO streams (channel_id, state, active_source_role, pid, profile, restart_count, last_error, started_at, last_state_change_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
       ON CONFLICT (channel_id) DO UPDATE SET state = EXCLUDED.state, active_source_role = EXCLUDED.active_source_role,
         pid = EXCLUDED.pid, profile = EXCLUDED.profile, restart_count = EXCLUDED.restart_count, last_error = EXCLUDED.last_error,
         started_at = EXCLUDED.started_at, last_state_change_at = now(), updated_at = now()`,
      [
        rt.channelId,
        rt.state,
        rt.role,
        rt.pid,
        JSON.stringify({ ladder: this.ladderNames, ...extra }),
        rt.restartCount,
        rt.lastError,
        rt.startedAt,
      ],
    );
    publish('stream.state', { channelId: rt.channelId, slug: rt.slug, state: rt.state, role: rt.role, restartCount: rt.restartCount, lastError: rt.lastError });
  }

  /** Operator intent survives restarts of the server process; automatic recovery does not change it. */
  private async setDesired(channelId: string, desired: 'RUNNING' | 'STOPPED'): Promise<void> {
    await query('UPDATE streams SET desired_state = $2, updated_at = now() WHERE channel_id = $1', [channelId, desired]).catch(() => undefined);
    await query(
      `INSERT INTO streams (channel_id, desired_state) VALUES ($1, $2) ON CONFLICT (channel_id) DO UPDATE SET desired_state = EXCLUDED.desired_state`,
      [channelId, desired],
    ).catch(() => undefined);
  }

  /** Re-starts channels whose desired state is RUNNING (called once at boot for service-restart recovery). */
  async restoreDesired(): Promise<string[]> {
    const res = await query<{ channel_id: string }>("SELECT channel_id FROM streams WHERE desired_state = 'RUNNING'");
    const restored: string[] = [];
    for (const r of res.rows) {
      try {
        await this.start(r.channel_id, { reason: 'boot-recovery' });
        restored.push(r.channel_id);
      } catch (err) {
        log('ERROR', 'streams', 'boot recovery failed for channel', { channelId: r.channel_id, err: (err as Error).message });
      }
    }
    return restored;
  }

  private setState(rt: Runtime, state: StreamState, error?: string): void {
    const changed = rt.state !== state;
    rt.state = state;
    if (error !== undefined) rt.lastError = error;
    if (changed) {
      this.persist(rt).catch((err) => log('ERROR', 'streams', 'persist failed', { err: err.message }));
    }
  }

  /** Starts the channel. The PRIMARY source is used unless `source` is BACKUP. Returns the current status. */
  async start(channelId: string, opts: { source?: SourceRole; reason?: string } = {}): Promise<Record<string, unknown>> {
    const channel = await this.loadChannel(channelId);
    const existing = this.runtimes.get(channelId);
    // Idempotent: a live encoder (STARTING/RUNNING) is never duplicated. DEGRADED/FAILING_OVER have no live
    // process and must proceed to relaunch, otherwise automatic recovery would silently do nothing.
    if (existing && existing.proc && (existing.state === 'RUNNING' || existing.state === 'STARTING')) {
      return this.status(channelId);
    }
    const running = [...this.runtimes.values()].filter((r) => r.proc && r.state !== 'STOPPED').length;
    if (running >= config.ffmpeg.maxConcurrentStreams) {
      throw new StreamError(`Resource limit reached: ${running}/${config.ffmpeg.maxConcurrentStreams} streams running on this host`, 409, 'RESOURCE_LIMIT');
    }

    const role: SourceRole = opts.source ?? 'PRIMARY';
    const sourceRow = await this.loadSourceRow(channelId, role);
    if (!sourceRow) {
      throw new StreamError(`No enabled ${role} source configured for this channel`, 422, 'NO_SOURCE');
    }
    const spec = this.toSpec(sourceRow);

    const rt: Runtime = existing ?? {
      channelId, slug: channel.slug, name: channel.name, state: 'STOPPED', role, proc: null, pid: null,
      stopRequested: false, consecutiveFailures: 0, restartCount: 0, restartTimer: null, startedAt: null,
      lastStderr: [], progress: {}, lastError: null, lastSegmentAt: null, hlsWatcher: null,
    };
    rt.role = role;
    rt.stopRequested = false;
    await this.setDesired(channelId, 'RUNNING');
    rt.slug = channel.slug;
    if (rt.restartTimer) clearTimeout(rt.restartTimer);
    rt.restartTimer = null;
    this.runtimes.set(channelId, rt);
    this.setState(rt, 'STARTING');

    const outDir = this.hlsDirFor(channel.slug);
    await fsp.rm(outDir, { recursive: true, force: true });
    for (const r of this.ladder) await fsp.mkdir(path.join(outDir, r.name), { recursive: true });

    const fps = Number(channel.encoding_profile?.fps ?? 25);
    const args = buildHlsArgs({
      source: spec,
      outDir,
      ladder: this.ladder,
      segmentSeconds: config.ffmpeg.hlsSegmentSeconds,
      listSize: config.ffmpeg.hlsListSize,
      preset: config.ffmpeg.preset,
      fps,
      encoder: 'software',
    });
    log('INFO', 'streams', 'starting ffmpeg', { channel: channel.slug, role, source: spec.type === 'URL' ? redactUrl(spec.url) : spec.pattern, reason: opts.reason ?? 'manual' });

    const proc = spawn(config.ffmpeg.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    rt.proc = proc;
    rt.pid = proc.pid ?? null;
    rt.startedAt = new Date();
    rt.lastStderr = [];

    const progressReader = readline.createInterface({ input: proc.stdout! });
    progressReader.on('line', (line) => {
      const [k, v] = line.split('=');
      if (k === 'fps') rt.progress.fps = Number(v);
      if (k === 'bitrate' && v && v !== 'N/A') rt.progress.bitrateKbps = Number.parseFloat(v);
      if (k === 'out_time_us') rt.progress.outTimeUs = Number(v);
      if (k === 'frame') rt.progress.frame = Number(v);
      if (k === 'progress') {
        rt.progress.updatedAt = Date.now();
        if (rt.state === 'STARTING' && Number(rt.progress.frame ?? 0) > 0 && !rt.hlsWatcher) {
          // RUNNING means real HLS output exists: wait for the master playlist and a first segment on disk.
          rt.hlsWatcher = this.watchHlsReady(rt);
        }
      }
    });
    const errReader = readline.createInterface({ input: proc.stderr! });
    errReader.on('line', (line) => {
      rt.lastStderr.push(line.slice(0, 500));
      if (rt.lastStderr.length > 30) rt.lastStderr.shift();
    });

    proc.on('error', (err) => {
      log('ERROR', 'streams', 'ffmpeg spawn error', { channel: channel.slug, err: err.message });
    });
    proc.on('exit', (code, signal) => this.onExit(rt, code, signal));
    return this.status(channelId);
  }

  private watchHlsReady(rt: Runtime): NodeJS.Timeout {
    const master = path.join(this.hlsDirFor(rt.slug), 'master.m3u8');
    const firstRungDir = path.join(this.hlsDirFor(rt.slug), this.ladder[0].name);
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      if (rt.state !== 'STARTING' || !rt.proc) {
        clearInterval(timer);
        rt.hlsWatcher = null;
        return;
      }
      try {
        const files = await fsp.readdir(firstRungDir);
        if (fs.existsSync(master) && files.some((f) => f.endsWith('.ts'))) {
          clearInterval(timer);
          rt.hlsWatcher = null;
          rt.consecutiveFailures = 0;
          this.setState(rt, 'RUNNING');
          return;
        }
      } catch {
        // directory not yet populated
      }
      if (Date.now() - startedAt > 30_000) {
        clearInterval(timer);
        rt.hlsWatcher = null;
        log('WARN', 'streams', 'HLS output not produced within 30s', { channel: rt.slug });
      }
    }, 250);
    return timer;
  }

  private onExit(rt: Runtime, code: number | null, signal: NodeJS.Signals | null): void {
    if (rt.hlsWatcher) {
      clearInterval(rt.hlsWatcher);
      rt.hlsWatcher = null;
    }
    rt.proc = null;
    rt.pid = null;
    if (rt.stopRequested) {
      rt.state = 'STOPPED';
      this.persist(rt).catch(() => undefined);
      log('INFO', 'streams', 'stream stopped', { channel: rt.slug });
      return;
    }
    rt.consecutiveFailures++;
    const tail = rt.lastStderr.slice(-3).join(' | ');
    rt.lastError = `ffmpeg exited (code=${code}, signal=${signal ?? 'none'}): ${tail}`.slice(0, 1000);
    const uptime = rt.startedAt ? Date.now() - rt.startedAt.getTime() : 0;
    if (uptime > RESET_RESTARTS_AFTER_MS) rt.restartCount = 0;

    // Verify the failure: retry once on the same source; after repeated failures fail over to backup.
    const hasBackup = rt.role === 'PRIMARY' && this.backupExistsSync(rt.channelId);
    const shouldFailover = rt.role === 'PRIMARY' && rt.consecutiveFailures >= 2 && hasBackup;
    if (rt.restartCount >= config.ffmpeg.maxRestarts && !shouldFailover) {
      this.setState(rt, 'FAILED', rt.lastError);
      recordSystemEvent('ERROR', 'streams', 'STREAM_FAILED', `Stream ${rt.slug} failed permanently after ${rt.restartCount} restarts`, { channelId: rt.channelId, lastError: rt.lastError });
      return;
    }
    rt.restartCount++;
    const delayMs = Math.min(60_000, 2_000 * 2 ** Math.min(rt.restartCount, 5));
    if (shouldFailover) {
      rt.role = 'BACKUP';
      rt.consecutiveFailures = 0;
      this.setState(rt, 'FAILING_OVER', rt.lastError);
      recordSystemEvent('WARN', 'streams', 'FAILOVER', `Stream ${rt.slug}: primary input failed, switching to backup source`, { channelId: rt.channelId });
    } else {
      this.setState(rt, 'DEGRADED', rt.lastError);
      recordSystemEvent('WARN', 'streams', 'STREAM_RESTART', `Stream ${rt.slug} exited unexpectedly; restarting in ${delayMs / 1000}s`, { channelId: rt.channelId, restartCount: rt.restartCount });
    }
    rt.restartTimer = setTimeout(() => {
      rt.restartTimer = null;
      if (rt.stopRequested) return;
      this.start(rt.channelId, { source: rt.role, reason: 'auto-recovery' }).catch((err: Error) => {
        this.setState(rt, 'FAILED', err.message);
        recordSystemEvent('ERROR', 'streams', 'RECOVERY_FAILED', `Automatic recovery failed for ${rt.slug}: ${err.message}`, { channelId: rt.channelId });
      });
    }, delayMs);
  }

  /** Channels with an enabled BACKUP source. Refreshed from PostgreSQL at startup and on every channel/source change. */
  readonly backupCache = new Set<string>();

  private backupExistsSync(channelId: string): boolean {
    return this.backupCache.has(channelId);
  }

  async refreshBackupCache(): Promise<void> {
    const res = await query<{ channel_id: string }>(
      "SELECT channel_id FROM channel_streams WHERE role = 'BACKUP' AND enabled",
    );
    this.backupCache.clear();
    for (const r of res.rows) this.backupCache.add(r.channel_id);
  }

  async stop(channelId: string, reason = 'manual'): Promise<Record<string, unknown>> {
    if (reason !== 'restart' && !reason.startsWith('shutdown')) await this.setDesired(channelId, 'STOPPED');
    const rt = this.runtimes.get(channelId);
    if (!rt) {
      const channel = await this.loadChannel(channelId);
      await this.persistStoppedRow(channel.id);
      return this.status(channelId);
    }
    rt.stopRequested = true;
    if (rt.restartTimer) clearTimeout(rt.restartTimer);
    rt.restartTimer = null;
    if (rt.proc) {
      const proc = rt.proc;
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => proc.kill('SIGKILL'), 5000);
        proc.once('exit', () => {
          clearTimeout(killTimer);
          resolve();
        });
        proc.kill('SIGTERM');
      });
    }
    rt.state = 'STOPPED';
    rt.restartCount = 0;
    await this.persist(rt);
    log('INFO', 'streams', 'stream stopped', { channel: rt.slug, reason });
    return this.status(channelId);
  }

  private async persistStoppedRow(channelId: string): Promise<void> {
    await query(
      `INSERT INTO streams (channel_id, state, updated_at, last_state_change_at) VALUES ($1, 'STOPPED', now(), now())
       ON CONFLICT (channel_id) DO UPDATE SET state = 'STOPPED', pid = NULL, updated_at = now(), last_state_change_at = now()`,
      [channelId],
    );
  }

  async restart(channelId: string): Promise<Record<string, unknown>> {
    await this.stop(channelId, 'restart');
    return this.start(channelId, { reason: 'restart' });
  }

  /** Live status from memory (process state, progress) merged with the persisted row. */
  status(channelId: string): Record<string, unknown> {
    const rt = this.runtimes.get(channelId);
    if (!rt) return { channelId, state: 'STOPPED', running: false, progress: null };
    const segAgeSec = rt.lastSegmentAt ? Math.round((Date.now() - rt.lastSegmentAt) / 1000) : null;
    return {
      channelId,
      slug: rt.slug,
      state: rt.state,
      running: Boolean(rt.proc),
      pid: rt.pid,
      activeSourceRole: rt.role,
      restartCount: rt.restartCount,
      startedAt: rt.startedAt?.toISOString() ?? null,
      lastError: rt.lastError,
      progress: {
        fps: rt.progress.fps ?? null,
        bitrateKbps: rt.progress.bitrateKbps ?? null,
        frame: rt.progress.frame ?? null,
        outTimeSeconds: rt.progress.outTimeUs ? Math.round(rt.progress.outTimeUs / 1e6) : null,
      },
      lastSegmentAgeSeconds: segAgeSec,
      hls: { master: `/hls/${rt.slug}/master.m3u8`, variants: this.ladderNames },
    };
  }

  snapshot(): Array<Record<string, unknown>> {
    return [...this.runtimes.keys()].map((id) => this.status(id));
  }

  /** Health monitor: detects stalled HLS output (no new segments) and stalled FFmpeg progress. */
  startMonitor(intervalMs = config.monitoring.healthIntervalMs): void {
    if (this.monitorTimer) return;
    this.monitorTimer = setInterval(() => {
      this.checkStalls().catch((err) => log('ERROR', 'streams', 'monitor error', { err: err.message }));
    }, intervalMs);
    this.monitorTimer.unref();
  }

  async checkStalls(): Promise<void> {
    const staleLimitMs = config.ffmpeg.hlsSegmentSeconds * 4 * 1000;
    for (const rt of this.runtimes.values()) {
      if (!rt.proc || rt.state === 'STOPPED') continue;
      const progressAge = rt.progress.updatedAt ? Date.now() - rt.progress.updatedAt : null;
      try {
        const segs = await fsp.readdir(path.join(this.hlsDirFor(rt.slug), this.ladder[0].name));
        const ts = segs.filter((f) => f.endsWith('.ts'));
        if (ts.length) {
          const stat = await fsp.stat(path.join(this.hlsDirFor(rt.slug), this.ladder[0].name, ts.sort().at(-1)!));
          rt.lastSegmentAt = stat.mtimeMs;
        }
      } catch {
        // directory may not exist during startup
      }
      const segStale = rt.lastSegmentAt !== null && Date.now() - rt.lastSegmentAt > staleLimitMs;
      if (rt.state === 'RUNNING' && segStale) {
        this.setState(rt, 'DEGRADED', 'HLS segments stopped advancing');
        recordSystemEvent('WARN', 'streams', 'HLS_STALLED', `Stream ${rt.slug}: no new HLS segments; restarting encoder`, { channelId: rt.channelId });
        rt.proc?.kill('SIGTERM'); // onExit schedules automatic recovery
      } else if (progressAge !== null && progressAge > staleLimitMs * 2 && rt.proc) {
        rt.proc.kill('SIGKILL');
      }
    }
  }

  /** Graceful shutdown: terminate FFmpeg children but keep desired_state so they come back after a restart. */
  async shutdown(): Promise<void> {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    const ids = [...this.runtimes.keys()];
    await Promise.all(ids.map((id) => this.stop(id, 'shutdown').catch(() => undefined)));
  }
}

export const streamManager = new StreamManager();

export async function ensureDirs(): Promise<void> {
  for (const dir of [config.hlsDir, config.recordingsDir, config.logsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { query } from '../db.js';
import { buildRecordingArgs, type SourceSpec } from './ffmpegArgs.js';
import { log, publish, recordSystemEvent } from './events.js';
import { StreamError } from './streamManager.js';

const execFileAsync = promisify(execFile);

interface RecRuntime {
  id: string;
  proc: ChildProcess;
  timer: NodeJS.Timeout;
  filePath: string;
  stopRequested: boolean;
}

export class RecordingManager {
  private active = new Map<string, RecRuntime>();

  async start(channelId: string, requestedBy: string | null, maxMinutes?: number): Promise<Record<string, unknown>> {
    const ch = await query<{ id: string; slug: string; name: string; encoding_profile: Record<string, unknown>; recording_config: { retentionDays?: number } }>(
      'SELECT id, slug, name, encoding_profile, recording_config FROM channels WHERE id = $1',
      [channelId],
    );
    const channel = ch.rows[0];
    if (!channel) throw new StreamError('Channel not found', 404, 'NOT_FOUND');
    const sourceRes = await query<{ source_type: string; source_url: string }>(
      "SELECT source_type, source_url FROM channel_streams WHERE channel_id = $1 AND role = 'PRIMARY' AND enabled",
      [channelId],
    );
    const src = sourceRes.rows[0];
    if (!src) throw new StreamError('No enabled PRIMARY source to record', 422, 'NO_SOURCE');
    for (const r of this.active.values()) {
      if (r.filePath && (await this.channelOf(r.id)) === channelId) {
        throw new StreamError('A recording is already active for this channel', 409, 'ALREADY_RECORDING');
      }
    }
    await this.assertDiskSpace();

    const id = (await query<{ id: string }>(
      `INSERT INTO recordings (channel_id, status, file_path, requested_by, retention_until)
       VALUES ($1, 'RECORDING', '', $2, now() + make_interval(days => $3))
       RETURNING id`,
      [channelId, requestedBy, channel.recording_config?.retentionDays ?? 14],
    )).rows[0].id;

    const dir = path.join(config.recordingsDir, channel.slug);
    await fsp.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(dir, `${stamp}-${id.slice(0, 8)}.ts`);
    await query('UPDATE recordings SET file_path = $2 WHERE id = $1', [id, filePath]);

    const spec: SourceSpec = src.source_type === 'LAVFI_TEST'
      ? { type: 'LAVFI_TEST', pattern: src.source_url === 'smptebars' ? 'smptebars' : 'testsrc2' }
      : { type: 'URL', url: src.source_url };
    const proc = spawn(config.ffmpeg.bin, buildRecordingArgs(spec, filePath, Number(channel.encoding_profile?.fps ?? 25)), {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    const stderr: string[] = [];
    proc.stderr?.on('data', (d: Buffer) => {
      stderr.push(d.toString());
      if (stderr.length > 50) stderr.shift();
    });
    const limitMs = (maxMinutes ?? config.recordings.maxRecordingMinutes) * 60_000;
    const timer = setTimeout(() => {
      log('WARN', 'recorder', 'recording reached maximum duration; stopping', { recordingId: id });
      this.stop(id).catch(() => undefined);
    }, limitMs);
    timer.unref();

    const rt: RecRuntime = { id, proc, timer, filePath, stopRequested: false };
    this.active.set(id, rt);
    rt.proc.on('exit', (code) => this.finalize(rt, code).catch((err) => log('ERROR', 'recorder', 'finalize failed', { err: err.message })));
    publish('recording.state', { recordingId: id, channelId, status: 'RECORDING' });
    log('INFO', 'recorder', 'recording started', { recordingId: id, channel: channel.slug });
    return { id, channelId, status: 'RECORDING', filePathHint: path.basename(filePath) };
  }

  private async channelOf(recId: string): Promise<string | null> {
    const r = await query<{ channel_id: string | null }>('SELECT channel_id FROM recordings WHERE id = $1', [recId]);
    return r.rows[0]?.channel_id ?? null;
  }

  /** Stops gracefully: FFmpeg receives 'q' on stdin so the TS container is finalized correctly. */
  async stop(recordingId: string): Promise<Record<string, unknown>> {
    const rt = this.active.get(recordingId);
    if (!rt) {
      const row = await query('SELECT id, status FROM recordings WHERE id = $1', [recordingId]);
      if (!row.rows[0]) throw new StreamError('Recording not found', 404, 'NOT_FOUND');
      return { id: recordingId, status: row.rows[0].status };
    }
    rt.stopRequested = true;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => rt.proc.kill('SIGKILL'), 15_000);
      rt.proc.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      try {
        rt.proc.stdin?.write('q\n');
      } catch {
        rt.proc.kill('SIGINT');
      }
    });
    return { id: recordingId, status: 'STOPPED' };
  }

  private async finalize(rt: RecRuntime, code: number | null): Promise<void> {
    clearTimeout(rt.timer);
    this.active.delete(rt.id);
    let size = 0;
    try {
      size = (await fsp.stat(rt.filePath)).size;
    } catch {
      size = 0;
    }
    let duration: number | null = null;
    let resolution: string | null = null;
    let codec: string | null = null;
    if (size > 0) {
      try {
        const { stdout } = await execFileAsync(config.ffmpeg.ffprobeBin, [
          '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height',
          '-of', 'json', rt.filePath,
        ], { timeout: 30_000 });
        const info = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }> };
        duration = info.format?.duration ? Number(info.format.duration) : null;
        const v = info.streams?.find((s) => s.codec_type === 'video');
        if (v) {
          resolution = `${v.width}x${v.height}`;
          codec = v.codec_name;
        }
      } catch (err) {
        log('WARN', 'recorder', 'ffprobe failed', { err: (err as Error).message });
      }
    }
    const status = size > 0 && (rt.stopRequested || code === 0) ? 'COMPLETED' : rt.stopRequested ? 'STOPPED' : 'FAILED';
    await query(
      `UPDATE recordings SET status = $2, file_size_bytes = $3, duration_seconds = $4, resolution = $5, codec = $6,
         ended_at = now(), error = $7 WHERE id = $1`,
      [rt.id, status, size, duration, resolution, codec, status === 'FAILED' ? `ffmpeg exit code ${code}` : null],
    );
    if (status === 'FAILED') {
      await recordSystemEvent('ERROR', 'recorder', 'RECORDING_FAILED', `Recording ${rt.id} failed (exit ${code})`, { recordingId: rt.id });
    }
    publish('recording.state', { recordingId: rt.id, status, sizeBytes: size, durationSeconds: duration });
    log('INFO', 'recorder', 'recording finished', { recordingId: rt.id, status, sizeBytes: size, duration });
  }

  /** Free space in the recordings volume (bytes). */
  async freeBytes(): Promise<number> {
    const stats = await fsp.statfs(config.recordingsDir);
    return Number(stats.bavail) * Number(stats.bsize);
  }

  async assertDiskSpace(): Promise<void> {
    const free = await this.freeBytes();
    const minBytes = config.recordings.minFreeGb * 1024 ** 3;
    if (free < minBytes) {
      throw new StreamError(`Insufficient disk space for recording (${(free / 1024 ** 3).toFixed(1)} GB free, ${config.recordings.minFreeGb} GB required)`, 507, 'DISK_FULL');
    }
  }

  /** Deletes completed recordings past their retention date. Returns number removed. */
  async applyRetention(): Promise<number> {
    const res = await query<{ id: string; file_path: string }>(
      "SELECT id, file_path FROM recordings WHERE status <> 'RECORDING' AND retention_until IS NOT NULL AND retention_until < now() AND file_path <> ''",
    );
    let removed = 0;
    for (const r of res.rows) {
      await fsp.rm(r.file_path, { force: true });
      await query("UPDATE recordings SET file_path = '', status = status WHERE id = $1", [r.id]);
      removed++;
    }
    return removed;
  }

  activeCount(): number {
    return this.active.size;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.active.keys()].map((id) => this.stop(id).catch(() => undefined)));
  }
}

export const recordingManager = new RecordingManager();

export function recordingsDirExists(): boolean {
  return fs.existsSync(config.recordingsDir);
}

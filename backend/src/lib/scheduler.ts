import { config } from '../config.js';
import { pool, query, withTransaction } from '../db.js';
import { getRedis, log, recordSystemEvent } from './events.js';

export interface ScheduleRow {
  id: string;
  name: string;
  channel_id: string | null;
  action: string;
  recurrence: 'ONCE' | 'DAILY' | 'WEEKLY';
  time_of_day: string | null;
  days_of_week: number[];
  run_at: Date | null;
  timezone: string;
  params: Record<string, unknown>;
  enabled: boolean;
  next_run_at: Date | null;
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = zoneFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    zoneFormatters.set(tz, f);
  }
  return f;
}

/** Offset (ms) of `tz` from UTC at instant `ts`. */
export function tzOffsetMs(ts: number, tz: string): number {
  const parts = Object.fromEntries(formatterFor(tz).formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** Converts a wall-clock time in `tz` to a UTC epoch ms, handling DST transitions. */
export function zonedToUtc(y: number, mo: number, d: number, hh: number, mm: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  let off = tzOffsetMs(guess, tz);
  let utc = guess - off;
  const off2 = tzOffsetMs(utc, tz);
  if (off2 !== off) {
    off = off2;
    utc = guess - off;
  }
  return utc;
}

/**
 * Next occurrence strictly after `after` for DAILY/WEEKLY recurrences, evaluated in the schedule's timezone.
 * Returns null for ONCE schedules that already ran.
 */
export function computeNextRun(s: Pick<ScheduleRow, 'recurrence' | 'time_of_day' | 'days_of_week' | 'run_at' | 'timezone'>, after: Date): Date | null {
  if (s.recurrence === 'ONCE') {
    if (!s.run_at) return null;
    return s.run_at > after ? s.run_at : null;
  }
  if (!s.time_of_day) return null;
  const [hh, mm] = s.time_of_day.split(':').map(Number);
  const days = s.recurrence === 'WEEKLY' ? new Set(s.days_of_week) : null;
  const localNow = new Date(after.getTime() + tzOffsetMs(after.getTime(), s.timezone));
  const startY = localNow.getUTCFullYear();
  const startM = localNow.getUTCMonth();
  const startD = localNow.getUTCDate();
  for (let k = 0; k <= 8; k++) {
    const dayUtc = new Date(Date.UTC(startY, startM, startD + k));
    if (days && !days.has(dayUtc.getUTCDay())) continue;
    const candidate = zonedToUtc(dayUtc.getUTCFullYear(), dayUtc.getUTCMonth() + 1, dayUtc.getUTCDate(), hh, mm, s.timezone);
    if (candidate > after.getTime()) return new Date(candidate);
  }
  return null;
}

export type ActionExecutor = (schedule: ScheduleRow) => Promise<Record<string, unknown> | void>;

/**
 * Redis-locked scheduler with PostgreSQL-enforced idempotency.
 * - Each occurrence is claimed by INSERT ... ON CONFLICT DO NOTHING on (schedule_id, scheduled_for).
 * - Only one instance can hold the Redis tick lock at a time (multi-instance safe).
 * - Runs left PENDING by a crash are re-executed on the next tick; actions are written to be idempotent
 *   (starting a running stream is a no-op).
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private executor: ActionExecutor | null = null;
  private lastTickAt: Date | null = null;
  private ticking = false;

  constructor(private readonly lockKey = 'io:scheduler:lock') {}

  setExecutor(fn: ActionExecutor): void {
    this.executor = fn;
  }

  start(): void {
    if (this.timer || !config.scheduler.enabled) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => log('ERROR', 'scheduler', 'tick failed', { err: (err as Error).message }));
    }, config.scheduler.tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get status(): Record<string, unknown> {
    return { enabled: config.scheduler.enabled, tickMs: config.scheduler.tickMs, lastTickAt: this.lastTickAt?.toISOString() ?? null, running: Boolean(this.timer) };
  }

  async tick(now = new Date()): Promise<{ claimed: number; executed: number; recovered: number }> {
    if (this.ticking) return { claimed: 0, executed: 0, recovered: 0 };
    this.ticking = true;
    try {
      const lock = await getRedis().set(this.lockKey, process.pid.toString(), 'PX', config.scheduler.tickMs * 2, 'NX').catch(() => null);
      if (lock !== 'OK') return { claimed: 0, executed: 0, recovered: 0 };
      this.lastTickAt = now;

      const claimed = await this.claimDue(now);
      let executed = 0;
      for (const c of claimed) {
        await this.execute(c.schedule, c.runId, c.scheduledFor);
        executed++;
      }
      // Recover occurrences that were claimed but never finished (crash between claim and execution).
      const pending = await query<{ id: string; schedule_id: string; scheduled_for: Date }>(
        `SELECT r.id, r.schedule_id, r.scheduled_for FROM schedule_runs r
         WHERE r.status = 'PENDING' AND r.scheduled_for < now() - interval '60 seconds' ORDER BY r.scheduled_for LIMIT 20`,
      );
      let recovered = 0;
      for (const p of pending.rows) {
        const sched = await query<ScheduleRow>('SELECT * FROM schedules WHERE id = $1', [p.schedule_id]);
        if (!sched.rows[0]) continue;
        await this.execute(sched.rows[0], Number(p.id), p.scheduled_for);
        recovered++;
      }
      return { claimed: claimed.length, executed, recovered };
    } finally {
      this.ticking = false;
    }
  }

  private async claimDue(now: Date): Promise<Array<{ schedule: ScheduleRow; runId: number; scheduledFor: Date }>> {
    return withTransaction(async (client) => {
      const due = await client.query<ScheduleRow>(
        `SELECT * FROM schedules WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= $1
         ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 50`,
        [now],
      );
      const out: Array<{ schedule: ScheduleRow; runId: number; scheduledFor: Date }> = [];
      for (const s of due.rows) {
        const scheduledFor = s.next_run_at!;
        const ins = await client.query<{ id: string }>(
          `INSERT INTO schedule_runs (schedule_id, scheduled_for, status) VALUES ($1, $2, 'PENDING')
           ON CONFLICT (schedule_id, scheduled_for) DO NOTHING RETURNING id`,
          [s.id, scheduledFor],
        );
        const next = computeNextRun(s, scheduledFor);
        await client.query(
          'UPDATE schedules SET next_run_at = $2, enabled = $3, last_run_at = now(), updated_at = now() WHERE id = $1',
          [s.id, next, next !== null || s.recurrence !== 'ONCE'],
        );
        if (ins.rows[0]) out.push({ schedule: s, runId: Number(ins.rows[0].id), scheduledFor });
      }
      return out;
    });
  }

  private async execute(schedule: ScheduleRow, runId: number, scheduledFor: Date): Promise<void> {
    await query("UPDATE schedule_runs SET status = 'RUNNING', started_at = now() WHERE id = $1", [runId]);
    try {
      if (!this.executor) throw new Error('No executor registered');
      await this.executor(schedule);
      await query("UPDATE schedule_runs SET status = 'SUCCEEDED', finished_at = now() WHERE id = $1", [runId]);
      log('INFO', 'scheduler', 'schedule executed', { schedule: schedule.name, action: schedule.action, scheduledFor: scheduledFor.toISOString() });
    } catch (err) {
      const msg = (err as Error).message;
      await query("UPDATE schedule_runs SET status = 'FAILED', finished_at = now(), error = $2 WHERE id = $1", [runId, msg.slice(0, 1000)]);
      await recordSystemEvent('ERROR', 'scheduler', 'SCHEDULE_FAILED', `Schedule "${schedule.name}" (${schedule.action}) failed: ${msg}`, { scheduleId: schedule.id });
    }
  }
}

export const scheduler = new Scheduler();
export { pool };

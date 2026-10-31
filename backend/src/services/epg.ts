import { query, withTransaction } from '../db.js';
import { fetchTextSafe } from '../lib/fetchSafe.js';
import { log } from '../lib/events.js';
import { parseXmltv, type XmltvResult } from '../lib/xmltv.js';

export const EPG_WINDOW_DAYS = 14;

/** Imports an XMLTV document for a source. Keeps only programmes inside [now-1d, now+14d]. */
export async function importXmltv(sourceId: string, result: XmltvResult, now = new Date()): Promise<{ programs: number; channels: number }> {
  const from = new Date(now.getTime() - 24 * 3600_000);
  const to = new Date(now.getTime() + EPG_WINDOW_DAYS * 24 * 3600_000);
  const programs = result.programs.filter((p) => p.stop > from && p.start < to);
  await withTransaction(async (client) => {
    await client.query('DELETE FROM epg_programs WHERE source_id = $1', [sourceId]);
    const BATCH = 1000;
    for (let i = 0; i < programs.length; i += BATCH) {
      const slice = programs.slice(i, i + BATCH);
      await client.query(
        `INSERT INTO epg_programs (source_id, epg_channel_id, start_at, stop_at, title, description, category)
         SELECT $1, * FROM unnest($2::text[], $3::timestamptz[], $4::timestamptz[], $5::text[], $6::text[], $7::text[])
         ON CONFLICT (source_id, epg_channel_id, start_at) DO NOTHING`,
        [
          sourceId,
          slice.map((p) => p.channelId),
          slice.map((p) => p.start.toISOString()),
          slice.map((p) => p.stop.toISOString()),
          slice.map((p) => p.title),
          slice.map((p) => p.description),
          slice.map((p) => p.category),
        ],
      );
    }
    await client.query(
      `UPDATE epg_sources SET channel_count = $2, program_count = $3, last_imported_at = now(), last_error = NULL WHERE id = $1`,
      [sourceId, result.channels.length, programs.length],
    );
  });
  return { programs: programs.length, channels: result.channels.length };
}

export async function refreshEpgSourceFromUrl(sourceId: string, url: string): Promise<{ programs: number; channels: number }> {
  try {
    const xml = await fetchTextSafe(url, { maxBytes: 80 * 1024 * 1024, timeoutMs: 60_000 });
    const parsed = parseXmltv(xml);
    const out = await importXmltv(sourceId, parsed);
    log('INFO', 'epg', 'EPG source refreshed', { sourceId, ...out, warnings: parsed.warnings });
    return out;
  } catch (err) {
    await query('UPDATE epg_sources SET last_error = $2 WHERE id = $1', [sourceId, (err as Error).message.slice(0, 500)]);
    throw err;
  }
}

/** Scheduled refresh: EPG sources with a URL, not refreshed in the last `hours`. */
export async function refreshStaleEpgSources(hours = 12): Promise<number> {
  const res = await query<{ id: string; url: string }>(
    `SELECT id, url FROM epg_sources WHERE url IS NOT NULL
       AND (last_imported_at IS NULL OR last_imported_at < now() - make_interval(hours => $1)) LIMIT 5`,
    [hours],
  );
  let n = 0;
  for (const s of res.rows) {
    try {
      await refreshEpgSourceFromUrl(s.id, s.url);
      n++;
    } catch (err) {
      log('WARN', 'epg', 'scheduled EPG refresh failed', { sourceId: s.id, err: (err as Error).message });
    }
  }
  return n;
}

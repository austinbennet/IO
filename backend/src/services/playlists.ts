import { query, withTransaction } from '../db.js';
import { parseM3U, type ParseResult } from '../lib/m3u.js';
import { fetchTextSafe } from '../lib/fetchSafe.js';
import { log } from '../lib/events.js';

export interface PlaylistRow {
  id: string;
  name: string;
  source_type: 'FILE' | 'URL';
  source_url: string | null;
  source_content: string | null;
  auto_refresh_minutes: number;
  channel_count: number;
  duplicate_count: number;
  last_refreshed_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Replaces all entries of a playlist atomically using bulk UNNEST inserts (efficient for thousands of rows). */
export async function storeParsedPlaylist(playlistId: string, parsed: ParseResult): Promise<void> {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM playlist_channels WHERE playlist_id = $1', [playlistId]);
    const BATCH = 500;
    for (let offset = 0; offset < parsed.channels.length; offset += BATCH) {
      const slice = parsed.channels.slice(offset, offset + BATCH);
      await client.query(
        `INSERT INTO playlist_channels
           (playlist_id, position, title, tvg_id, tvg_name, tvg_logo, group_title, ext_group, stream_url, stream_hash, url_valid, is_duplicate, attributes)
         SELECT $1, * FROM unnest(
           $2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::bool[], $12::bool[], $13::jsonb[]
         )`,
        [
          playlistId,
          slice.map((c) => c.position + offset),
          slice.map((c) => c.title),
          slice.map((c) => c.tvgId),
          slice.map((c) => c.tvgName),
          slice.map((c) => c.tvgLogo),
          slice.map((c) => c.groupTitle),
          slice.map((c) => c.extGroup),
          slice.map((c) => c.streamUrl),
          slice.map((c) => c.streamHash),
          slice.map((c) => c.urlValid),
          slice.map((c) => c.isDuplicate),
          slice.map((c) => JSON.stringify(c.attributes)),
        ],
      );
    }
    await client.query(
      `UPDATE playlists SET channel_count = $2, duplicate_count = $3, last_refreshed_at = now(), last_error = NULL, updated_at = now() WHERE id = $1`,
      [playlistId, parsed.channels.length, parsed.duplicates],
    );
  });
}

export async function createPlaylistFromContent(input: { name: string; sourceType: 'FILE' | 'URL'; sourceUrl: string | null; content: string; autoRefreshMinutes: number; createdBy: string | null }): Promise<string> {
  const parsed = parseM3U(input.content);
  const id = (await query<{ id: string }>(
    `INSERT INTO playlists (name, source_type, source_url, source_content, auto_refresh_minutes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [input.name, input.sourceType, input.sourceUrl, input.sourceType === 'FILE' ? input.content : null, input.autoRefreshMinutes, input.createdBy],
  )).rows[0].id;
  await storeParsedPlaylist(id, parsed);
  log('INFO', 'playlists', 'playlist imported', { playlistId: id, channels: parsed.channels.length, duplicates: parsed.duplicates });
  return id;
}

/** Re-downloads a URL playlist (SSRF-checked) or re-parses a stored FILE playlist. */
export async function refreshPlaylist(playlist: PlaylistRow): Promise<ParseResult> {
  try {
    const content = playlist.source_type === 'URL'
      ? await fetchTextSafe(playlist.source_url!, { maxBytes: 25 * 1024 * 1024 })
      : playlist.source_content ?? '';
    if (!content) throw new Error('Playlist has no stored content');
    const parsed = parseM3U(content);
    await storeParsedPlaylist(playlist.id, parsed);
    return parsed;
  } catch (err) {
    await query('UPDATE playlists SET last_error = $2, updated_at = now() WHERE id = $1', [playlist.id, (err as Error).message.slice(0, 500)]);
    throw err;
  }
}

/** Background auto-refresh for URL playlists with auto_refresh_minutes > 0. */
export async function autoRefreshDue(): Promise<number> {
  const due = await query<PlaylistRow>(
    `SELECT * FROM playlists WHERE source_type = 'URL' AND auto_refresh_minutes > 0
       AND (last_refreshed_at IS NULL OR last_refreshed_at < now() - make_interval(mins => auto_refresh_minutes))
     LIMIT 10`,
  );
  let refreshed = 0;
  for (const p of due.rows) {
    try {
      await refreshPlaylist(p);
      refreshed++;
    } catch (err) {
      log('WARN', 'playlists', 'auto-refresh failed', { playlistId: p.id, err: (err as Error).message });
    }
  }
  return refreshed;
}

import crypto from 'node:crypto';
import { isSyntacticallySafeUrl, redactUrl } from './security.js';

export interface ParsedChannel {
  position: number;
  title: string;
  tvgId: string | null;
  tvgName: string | null;
  tvgLogo: string | null;
  groupTitle: string | null;
  extGroup: string | null;
  streamUrl: string; // credentials removed; the stored value never includes user:password
  streamHash: string;
  urlValid: boolean;
  authRequired: boolean;
  attributes: Record<string, string>;
  isDuplicate: boolean;
}

export interface ParseResult {
  channels: ParsedChannel[];
  duplicates: number;
  invalidUrls: number;
  warnings: string[];
}

export const MAX_PLAYLIST_BYTES = 25 * 1024 * 1024;
export const MAX_PLAYLIST_CHANNELS = 20_000;

const ATTR_RE = /([A-Za-z0-9_-]+)="([^"]*)"/g;

export function parseAttributes(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of line.matchAll(ATTR_RE)) out[m[1].toLowerCase()] = m[2];
  return out;
}

/** Extracts `user:pass@` from a URL. Returns the sanitized URL and whether credentials were present. */
export function stripCredentials(raw: string): { url: string; hadCredentials: boolean } {
  try {
    const u = new URL(raw);
    const hadCredentials = Boolean(u.username || u.password);
    if (hadCredentials) {
      u.username = '';
      u.password = '';
    }
    return { url: u.toString(), hadCredentials };
  } catch {
    return { url: raw, hadCredentials: false };
  }
}

export function hashStreamUrl(url: string): string {
  return crypto.createHash('sha256').update(url.trim().toLowerCase()).digest('hex');
}

/**
 * Parses an M3U / M3U8 / extended M3U playlist.
 * Supports #EXTINF attributes (tvg-id, tvg-name, tvg-logo, group-title), #EXTGRP,
 * #EXTVLCOPT http-user-agent/http-referrer, and reports duplicate and invalid URLs.
 */
export function parseM3U(text: string): ParseResult {
  if (Buffer.byteLength(text, 'utf8') > MAX_PLAYLIST_BYTES) {
    throw new Error(`Playlist exceeds ${MAX_PLAYLIST_BYTES} bytes`);
  }
  const warnings: string[] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (!lines.some((l) => l.trim().startsWith('#EXTM3U')) && !lines.some((l) => l.trim().startsWith('#EXTINF'))) {
    warnings.push('Missing #EXTM3U header; parsed as best-effort plain M3U');
  }

  const channels: ParsedChannel[] = [];
  const seen = new Set<string>();
  let pending: { title: string; attrs: Record<string, string>; extGroup: string | null; vlcOpts: Record<string, string> } | null = null;
  let carryGroup: string | null = null;
  let carryVlc: Record<string, string> = {};
  let duplicates = 0;
  let invalidUrls = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const comma = line.indexOf(',');
      const head = comma >= 0 ? line.slice(0, comma) : line;
      const title = comma >= 0 ? line.slice(comma + 1).trim() : '';
      pending = {
        title,
        attrs: parseAttributes(head),
        extGroup: carryGroup,
        vlcOpts: { ...carryVlc },
      };
      carryGroup = null;
      carryVlc = {};
      continue;
    }
    if (line.startsWith('#EXTGRP:')) {
      carryGroup = line.slice('#EXTGRP:'.length).trim() || null;
      if (pending) pending.extGroup = carryGroup;
      continue;
    }
    if (line.startsWith('#EXTVLCOPT:')) {
      const kv = line.slice('#EXTVLCOPT:'.length);
      const eq = kv.indexOf('=');
      if (eq > 0) {
        const key = kv.slice(0, eq).trim().toLowerCase();
        const value = kv.slice(eq + 1).trim();
        if (pending) pending.vlcOpts[key] = value;
        else carryVlc[key] = value;
      }
      continue;
    }
    if (line.startsWith('#')) continue; // other directives ignored

    // URL line
    const raw = line;
    const info = pending ?? { title: '', attrs: {}, extGroup: carryGroup, vlcOpts: { ...carryVlc } };
    pending = null;
    const { url, hadCredentials } = stripCredentials(raw);
    const valid = isSyntacticallySafeUrl(url);
    if (!valid) invalidUrls++;
    const hash = hashStreamUrl(url);
    const isDuplicate = seen.has(hash);
    if (isDuplicate) duplicates++;
    seen.add(hash);

    const title = info.title || info.attrs['tvg-name'] || redactUrl(url);
    const attributes: Record<string, string> = { ...info.attrs };
    for (const [k, v] of Object.entries(info.vlcOpts)) {
      if (k === 'http-user-agent' || k === 'http-referrer') attributes[k] = v;
    }
    channels.push({
      position: channels.length,
      title,
      tvgId: info.attrs['tvg-id'] || null,
      tvgName: info.attrs['tvg-name'] || null,
      tvgLogo: info.attrs['tvg-logo'] || null,
      groupTitle: info.attrs['group-title'] || null,
      extGroup: info.extGroup,
      streamUrl: url,
      streamHash: hash,
      urlValid: valid,
      authRequired: hadCredentials,
      attributes,
      isDuplicate,
    });
    if (channels.length > MAX_PLAYLIST_CHANNELS) {
      throw new Error(`Playlist exceeds ${MAX_PLAYLIST_CHANNELS} entries`);
    }
  }

  if (channels.length === 0) warnings.push('No stream entries found');
  if (duplicates) warnings.push(`${duplicates} duplicate stream URL(s) flagged`);
  if (invalidUrls) warnings.push(`${invalidUrls} entries have unsupported or invalid URLs and are not playable`);
  return { channels, duplicates, invalidUrls, warnings };
}

/**
 * Generates an extended M3U document for IO's own channels.
 * Only publishes IO-controlled, signed, time-limited URLs - never internal paths or raw origin URLs.
 */
export function buildM3U(entries: Array<{ tvgId: string | null; name: string; logo: string | null; group: string; url: string }>): string {
  const out: string[] = ['#EXTM3U'];
  for (const e of entries) {
    const attrs = [
      `tvg-id="${escapeAttr(e.tvgId ?? '')}"`,
      `tvg-name="${escapeAttr(e.name)}"`,
      e.logo ? `tvg-logo="${escapeAttr(e.logo)}"` : null,
      `group-title="${escapeAttr(e.group)}"`,
    ].filter(Boolean);
    out.push(`#EXTINF:-1 ${attrs.join(' ')},${e.name.replace(/[\r\n]/g, ' ')}`);
    out.push(e.url);
  }
  return out.join('\n') + '\n';
}

function escapeAttr(v: string): string {
  return v.replace(/[\r\n"]/g, ' ');
}

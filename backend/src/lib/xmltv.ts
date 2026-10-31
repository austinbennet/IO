import { XMLParser } from 'fast-xml-parser';

export interface XmltvProgram {
  channelId: string;
  start: Date;
  stop: Date;
  title: string;
  description: string;
  category: string;
}

export interface XmltvResult {
  channels: Array<{ id: string; displayName: string }>;
  programs: XmltvProgram[];
  warnings: string[];
}

export const MAX_XMLTV_BYTES = 80 * 1024 * 1024;

/**
 * XMLTV timestamps: "YYYYMMDDHHMMSS [+-]HHMM" (offset optional; UTC assumed if absent).
 * Returns a UTC Date. Invalid values return null.
 */
export function parseXmltvTime(value: string | undefined): Date | null {
  if (!value) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*([+-]\d{4})?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', tz = '+0000'] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  const sign = tz[0] === '-' ? -1 : 1;
  const offH = Number(tz.slice(1, 3));
  const offM = Number(tz.slice(3, 5));
  const base = Date.parse(`${iso}Z`);
  if (Number.isNaN(base)) return null;
  const offsetMs = sign * (offH * 60 + offM) * 60_000;
  return new Date(base - offsetMs);
}

function textOf(node: unknown): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return textOf(node[0]);
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if ('#text' in obj) return String(obj['#text']);
  }
  return '';
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** Parses an XMLTV document. Programs with invalid times or missing channel ids are skipped and counted. */
export function parseXmltv(xml: string): XmltvResult {
  if (Buffer.byteLength(xml, 'utf8') > MAX_XMLTV_BYTES) throw new Error('XMLTV document too large');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    parseTagValue: false,
    trimValues: true,
    processEntities: true,
  });
  const doc = parser.parse(xml) as { tv?: Record<string, unknown> };
  if (!doc.tv) throw new Error('Not an XMLTV document (missing <tv> root)');

  const warnings: string[] = [];
  const channels = asArray(doc.tv.channel as unknown).map((c) => {
    const node = c as Record<string, unknown>;
    return {
      id: String(node['@_id'] ?? '').trim(),
      displayName: textOf(node['display-name']) || String(node['@_id'] ?? ''),
    };
  }).filter((c) => c.id);

  let skipped = 0;
  const programs: XmltvProgram[] = [];
  for (const raw of asArray(doc.tv.programme as unknown)) {
    const p = raw as Record<string, unknown>;
    const channelId = String(p['@_channel'] ?? '').trim();
    const start = parseXmltvTime(String(p['@_start'] ?? ''));
    const stop = parseXmltvTime(String(p['@_stop'] ?? ''));
    const title = textOf(p.title);
    if (!channelId || !start || !stop || stop <= start || !title) {
      skipped++;
      continue;
    }
    programs.push({
      channelId,
      start,
      stop,
      title,
      description: textOf(p.desc),
      category: asArray(p.category as unknown).map(textOf).filter(Boolean).join(', '),
    });
  }
  if (skipped) warnings.push(`${skipped} programme entries skipped (invalid time, channel or title)`);
  return { channels, programs, warnings };
}

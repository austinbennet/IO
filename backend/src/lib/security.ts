import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';

// ---------- Passwords ----------
const BCRYPT_ROUNDS = 12;
export const hashPassword = (plain: string) => bcrypt.hash(plain, BCRYPT_ROUNDS);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

// ---------- Opaque tokens (refresh tokens, API keys) are stored only as SHA-256 hashes ----------
export const randomToken = (bytes = 48) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

// ---------- Short-lived signed media tokens for HLS playback (ExoPlayer cannot send JWT headers reliably) ----------
export function signMediaToken(slug: string, ttlSeconds = config.mediaTokenTtlSeconds, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const sig = crypto.createHmac('sha256', config.mediaTokenSecret).update(`${slug}.${exp}`).digest('base64url');
  return `${exp}.${sig}`;
}

export function verifyMediaToken(slug: string, token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const [expStr, sig] = token.split('.');
  const exp = Number(expStr);
  if (!sig || !Number.isFinite(exp) || exp < Math.floor(now / 1000)) return false;
  const expected = crypto.createHmac('sha256', config.mediaTokenSecret).update(`${slug}.${exp}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- SSRF / URL validation ----------
export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

const ALLOWED_SOURCE_PROTOCOLS = new Set(['http:', 'https:', 'rtmp:', 'rtmps:', 'srt:', 'rtsp:']);

export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    return (
      lower === '::1' ||
      lower === '::' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe80') ||
      lower.startsWith('::ffff:127.') ||
      lower.startsWith('::ffff:10.') ||
      lower.startsWith('::ffff:192.168.')
    );
  }
  return true; // unknown format: refuse
}

/**
 * Validates a user-supplied media/playlist URL.
 * - Only allowed protocols.
 * - Hostname must resolve to public addresses unless explicitly allow-listed (ALLOW_PRIVATE_SOURCE_HOSTS).
 * - Credentials in the URL are rejected (they must go through headers/secret store, never logged).
 */
export async function assertSafeExternalUrl(raw: string, opts: { resolveDns?: boolean } = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('Invalid URL');
  }
  if (!ALLOWED_SOURCE_PROTOCOLS.has(url.protocol)) throw new UnsafeUrlError(`Protocol ${url.protocol} is not allowed`);
  if (url.username || url.password) throw new UnsafeUrlError('Embedded credentials are not allowed in URLs');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (config.security.allowPrivateSourceHosts.includes(host)) return url;
  if (host === 'localhost' || host.endsWith('.localhost')) throw new UnsafeUrlError('Localhost sources are not allowed');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new UnsafeUrlError('Private or loopback addresses are not allowed');
    return url;
  }
  if (opts.resolveDns !== false) {
    try {
      const addrs = await dns.lookup(host, { all: true });
      if (addrs.some((a) => isPrivateAddress(a.address))) {
        throw new UnsafeUrlError('Host resolves to a private or loopback address');
      }
    } catch (err) {
      if (err instanceof UnsafeUrlError) throw err;
      throw new UnsafeUrlError(`Host could not be resolved: ${host}`);
    }
  }
  return url;
}

/** Synchronous check used for list validation where DNS lookups are too expensive (e.g. 5000-channel playlists). */
export function isSyntacticallySafeUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return ALLOWED_SOURCE_PROTOCOLS.has(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Remove credentials and query-string tokens before logging or returning URLs. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '';
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|secret|pass|auth|sig/i.test(key)) url.searchParams.set(key, '***');
    }
    return url.toString();
  } catch {
    return '[invalid-url]';
  }
}

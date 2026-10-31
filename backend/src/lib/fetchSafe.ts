import { assertSafeExternalUrl, UnsafeUrlError, redactUrl } from './security.js';

export interface FetchOptions {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

/**
 * Fetches a remote text document (playlist/EPG) with SSRF protection on every redirect hop,
 * a size cap, and a timeout. Never follows redirects blindly.
 */
export async function fetchTextSafe(rawUrl: string, opts: FetchOptions): Promise<string> {
  let url = rawUrl;
  const maxRedirects = opts.maxRedirects ?? 3;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const safe = await assertSafeExternalUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
    try {
      const res = await fetch(safe, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'IO-Broadcast/1.0 (+playlist-refresh)', Accept: '*/*' },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error(`Redirect without Location from ${redactUrl(url)}`);
        url = new URL(loc, safe).toString();
        continue;
      }
      if (!res.ok) throw new Error(`Upstream returned HTTP ${res.status} for ${redactUrl(url)}`);
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > opts.maxBytes) throw new Error('Remote document exceeds size limit');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > opts.maxBytes) throw new Error('Remote document exceeds size limit');
      return buf.toString('utf8');
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new Error(`Timed out fetching ${redactUrl(url)}`);
      if (err instanceof UnsafeUrlError) throw err;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Too many redirects');
}

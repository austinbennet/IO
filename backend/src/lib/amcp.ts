import net from 'node:net';

/**
 * Minimal AMCP 2.x client for CasparCG Server.
 * Response code semantics (AMCP spec): 200 = multi-line data (terminated by empty line),
 * 201 = single data line follows, 202 = no data, 4xx/5xx = error.
 */
export interface AmcpResponse {
  code: number;
  status: string;
  data: string[];
  ok: boolean;
}

export class AmcpClient {
  private socket: net.Socket | null = null;
  private buffer = '';
  private queue: Array<{ resolve: (r: AmcpResponse) => void; reject: (e: Error) => void; cmd: string }> = [];
  private pending: { status: string; code: number; data: string[] } | null = null;
  private lastError: string | null = null;

  constructor(private host: string, private port: number, private timeoutMs = 5000) {}

  get connected(): boolean {
    return Boolean(this.socket && !this.socket.destroyed);
  }

  get error(): string | null {
    return this.lastError;
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      sock.setEncoding('utf8');
      sock.setTimeout(this.timeoutMs);
      const onError = (err: Error) => {
        this.lastError = err.message;
        this.socket = null;
        reject(err);
      };
      sock.once('error', onError);
      sock.once('connect', () => {
        sock.off('error', onError);
        this.socket = sock;
        this.lastError = null;
        resolve();
      });
      sock.on('data', (chunk: string) => this.onData(chunk));
      sock.on('error', (err) => this.failAll(err));
      sock.on('timeout', () => {
        this.failAll(new Error('AMCP socket timeout'));
        sock.destroy();
      });
      sock.on('close', () => {
        this.socket = null;
        this.failAll(new Error('AMCP connection closed'));
      });
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  private failAll(err: Error): void {
    this.lastError = err.message;
    const q = this.queue;
    this.queue = [];
    this.pending = null;
    this.buffer = '';
    for (const item of q) item.reject(err);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\r\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    const current = this.queue[0];
    if (!current) return; // unsolicited line (e.g. server notice)
    if (!this.pending) {
      const m = /^(\d{3})\s?(.*)$/.exec(line);
      if (!m) return;
      const code = Number(m[1]);
      this.pending = { code, status: m[2], data: [] };
      if (code === 200 || code === 201) return; // wait for data
      this.finish();
      return;
    }
    if (this.pending.code === 200) {
      if (line === '') {
        this.finish();
      } else {
        this.pending.data.push(line);
      }
      return;
    }
    // 201: single data line
    this.pending.data.push(line);
    this.finish();
  }

  private finish(): void {
    const item = this.queue.shift();
    const p = this.pending;
    this.pending = null;
    if (!item || !p) return;
    item.resolve({ code: p.code, status: p.status, data: p.data, ok: p.code >= 200 && p.code < 300 });
  }

  send(command: string): Promise<AmcpResponse> {
    if (!this.connected) return Promise.reject(new Error('CasparCG AMCP not connected'));
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject, cmd: command });
      this.socket!.write(command + '\r\n');
    });
  }
}

/** Escapes a value for an AMCP quoted string. */
export function amcpQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ')}"`;
}

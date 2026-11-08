// メッセージチャネル抽象: WebRTC DataChannel とテスト用インメモリ実装の共通インターフェース。
// 大きなメッセージは断片化して送る (Safari 等のメッセージサイズ上限対策)。
import { safeJsonParse } from '../lib/bytes';

export const FRAGMENT_SIZE = 16_000;
export const MAX_MESSAGE_SIZE = 4_000_000;
export const DEFAULT_TIMEOUT_MS = 30_000;

export class ChannelClosedError extends Error {
  constructor() {
    super('channel closed');
  }
}
export class ChannelTimeoutError extends Error {
  constructor() {
    super('channel timeout');
  }
}

export interface Channel {
  send(msg: unknown): Promise<void>;
  recv(timeoutMs?: number): Promise<unknown>;
  close(): void;
  readonly closed: boolean;
}

export interface RawTransport {
  sendRaw(s: string): Promise<void>;
  closeRaw(): void;
}

export class FramedChannel implements Channel {
  private queue: unknown[] = [];
  private waiters: { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  private partial: { id: string; parts: string[]; total: number } | null = null;
  private nextId = 0;
  closed = false;

  constructor(private transport: RawTransport) {}

  async send(msg: unknown): Promise<void> {
    if (this.closed) throw new ChannelClosedError();
    const s = JSON.stringify(msg);
    if (s.length > MAX_MESSAGE_SIZE) throw new Error('message too large');
    if (s.length <= FRAGMENT_SIZE) return this.transport.sendRaw('M' + s);
    const id = (this.nextId++).toString(36);
    const n = Math.ceil(s.length / FRAGMENT_SIZE);
    for (let i = 0; i < n; i++) {
      await this.transport.sendRaw(`F${id}|${i}|${n}|${s.slice(i * FRAGMENT_SIZE, (i + 1) * FRAGMENT_SIZE)}`);
    }
  }

  /** トランスポートから受け取った生文字列を投入する */
  feed(raw: unknown): void {
    if (this.closed) return;
    try {
      if (typeof raw !== 'string' || raw.length > FRAGMENT_SIZE + 64) throw new Error('bad frame');
      if (raw[0] === 'M') return this.deliver(safeJsonParse(raw.slice(1)));
      if (raw[0] !== 'F') throw new Error('bad frame');
      const m = raw.match(/^F([0-9a-z]{1,8})\|(\d{1,4})\|(\d{1,4})\|/);
      if (!m) throw new Error('bad fragment');
      const [head, id, iStr, nStr] = m as unknown as [string, string, string, string];
      const i = Number(iStr);
      const n = Number(nStr);
      if (n * FRAGMENT_SIZE > MAX_MESSAGE_SIZE + FRAGMENT_SIZE) throw new Error('too large');
      if (i === 0) this.partial = { id, parts: [], total: n };
      if (!this.partial || this.partial.id !== id || this.partial.total !== n || this.partial.parts.length !== i) throw new Error('fragment order');
      this.partial.parts.push(raw.slice(head.length));
      if (this.partial.parts.length === n) {
        const s = this.partial.parts.join('');
        this.partial = null;
        this.deliver(safeJsonParse(s));
      }
    } catch {
      // 不正なフレームを受け取ったら通信を打ち切る
      this.close();
    }
  }

  private deliver(msg: unknown) {
    const w = this.waiters.shift();
    if (w) {
      clearTimeout(w.timer);
      w.resolve(msg);
    } else this.queue.push(msg);
  }

  recv(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.reject(new ChannelClosedError());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new ChannelTimeoutError());
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  /** トランスポート側が切断されたときに呼ぶ */
  handleClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new ChannelClosedError());
    }
    this.waiters = [];
  }

  close(): void {
    if (this.closed) return;
    this.handleClosed();
    this.transport.closeRaw();
  }
}

/** テスト用: 2 つのチャネルを直結する */
export function memoryPair(opts: { dropAfter?: number } = {}): [FramedChannel, FramedChannel] {
  let count = 0;
  const holder: { a?: FramedChannel; b?: FramedChannel } = {};
  const mk = (peer: () => FramedChannel | undefined, self: () => FramedChannel | undefined): RawTransport => ({
    async sendRaw(s) {
      count++;
      if (opts.dropAfter !== undefined && count > opts.dropAfter) {
        self()?.close();
        throw new ChannelClosedError();
      }
      const p = peer();
      queueMicrotask(() => p?.feed(s));
    },
    closeRaw() {
      peer()?.handleClosed();
    },
  });
  holder.a = new FramedChannel(mk(() => holder.b, () => holder.a));
  holder.b = new FramedChannel(mk(() => holder.a, () => holder.b));
  return [holder.a, holder.b];
}

// 接続情報 (SDP) を QR コード 1 枚に収まるよう圧縮/復元する。
// spikes/webrtc-qr で検証したコーデックの正式版。
import { fromB64url, fromUtf8, toB64url, toHex, utf8 } from '../lib/bytes';

export const CODE_PREFIX = 'FH1:';
const VERSION = 1;
const SETUP = ['actpass', 'active', 'passive'] as const;
const ADDR_IPV4 = 0;
const ADDR_IPV6 = 1;
const ADDR_MDNS = 2;
const UUID_LOCAL = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;
const MAX_CODE_LENGTH = 1024;
const MAX_CANDIDATES = 8;

export class InvalidCodeError extends Error {
  constructor(msg = 'invalid code') {
    super(msg);
    this.name = 'InvalidCodeError';
  }
}

export interface Description {
  type: 'offer' | 'answer';
  sdp: string;
}

class Writer {
  private bytes: number[] = [];
  u8(v: number) {
    this.bytes.push(v & 0xff);
  }
  u16(v: number) {
    this.u8(v >> 8);
    this.u8(v);
  }
  raw(a: ArrayLike<number>) {
    for (let i = 0; i < a.length; i++) this.u8(a[i]!);
  }
  str(s: string) {
    const b = utf8(s);
    if (b.length > 255) throw new Error('string too long');
    this.u8(b.length);
    this.raw(b);
  }
  blob(b: Uint8Array) {
    this.u16(b.length);
    this.raw(b);
  }
  done() {
    return Uint8Array.from(this.bytes);
  }
}

class Reader {
  private i = 0;
  constructor(private b: Uint8Array) {}
  private need(n: number) {
    if (this.i + n > this.b.length) throw new InvalidCodeError('truncated');
  }
  u8() {
    this.need(1);
    return this.b[this.i++]!;
  }
  u16() {
    return (this.u8() << 8) | this.u8();
  }
  raw(n: number) {
    this.need(n);
    const r = this.b.slice(this.i, this.i + n);
    this.i += n;
    return r;
  }
  str() {
    return fromUtf8(this.raw(this.u8()));
  }
  blob() {
    return this.raw(this.u16());
  }
  end() {
    if (this.i !== this.b.length) throw new InvalidCodeError('trailing data');
  }
}

const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

function parseIPv6(addr: string): number[] {
  const parts = addr.split('::');
  if (parts.length > 2) throw new Error('bad ipv6');
  const h = parts[0] ? parts[0].split(':') : [];
  const t = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = parts.length === 2 ? Array<string>(8 - h.length - t.length).fill('0') : [];
  const groups = [...h, ...fill, ...t];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) throw new Error('bad ipv6');
  return groups.flatMap((g) => {
    const v = parseInt(g, 16);
    return [v >> 8, v & 0xff];
  });
}

function formatIPv6(b: Uint8Array): string {
  const g: string[] = [];
  for (let i = 0; i < 16; i += 2) g.push(((b[i]! << 8) | b[i + 1]!).toString(16));
  return g.join(':');
}

function match(sdp: string, re: RegExp): string {
  const m = sdp.match(re);
  if (!m?.[1]) throw new Error(`SDP missing ${re.source}`);
  return m[1];
}

/** ローカル記述 → QR に載せる文字列 */
export function encodeDescription(desc: Description, extra: Uint8Array = new Uint8Array()): string {
  const { sdp } = desc;
  const ufrag = match(sdp, /a=ice-ufrag:(\S+)/);
  const pwd = match(sdp, /a=ice-pwd:(\S+)/);
  const fp = match(sdp, /a=fingerprint:sha-256 (\S+)/i).replace(/:/g, '');
  const setup = match(sdp, /a=setup:(\S+)/);
  const setupIdx = SETUP.indexOf(setup as (typeof SETUP)[number]);
  if (setupIdx < 0) throw new Error('bad setup');

  const seen = new Set<string>();
  const cands: { addr: string; port: number }[] = [];
  for (const m of sdp.matchAll(/a=candidate:\S+ 1 udp \d+ (\S+) (\d+) typ host/gi)) {
    const key = `${m[1]}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cands.push({ addr: m[1]!, port: Number(m[2]) });
  }

  const w = new Writer();
  w.u8(VERSION);
  w.u8(desc.type === 'offer' ? 0 : 1);
  w.u8(setupIdx);
  w.str(ufrag);
  w.str(pwd);
  w.raw(unhex(fp));
  const usable = cands.filter((c) => /^\d+\.\d+\.\d+\.\d+$/.test(c.addr) || UUID_LOCAL.test(c.addr) || c.addr.includes(':')).slice(0, MAX_CANDIDATES);
  w.u8(usable.length);
  for (const c of usable) {
    const uuid = c.addr.match(UUID_LOCAL);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(c.addr)) {
      w.u8(ADDR_IPV4);
      w.raw(c.addr.split('.').map(Number));
    } else if (uuid) {
      w.u8(ADDR_MDNS);
      w.raw(unhex(uuid.slice(1).join('')));
    } else {
      w.u8(ADDR_IPV6);
      w.raw(parseIPv6(c.addr));
    }
    w.u16(c.port);
  }
  w.blob(extra);
  return CODE_PREFIX + toB64url(w.done());
}

/** QR の文字列 → 接続記述 (厳格に検証し、SDP インジェクションを防ぐ) */
export function decodeDescription(code: string): { description: Description; extra: Uint8Array } {
  try {
    const trimmed = code.trim();
    if (trimmed.length > MAX_CODE_LENGTH || !trimmed.startsWith(CODE_PREFIX)) throw new InvalidCodeError('not a FamilyHub code');
    const r = new Reader(fromB64url(trimmed.slice(CODE_PREFIX.length)));
    if (r.u8() !== VERSION) throw new InvalidCodeError('unsupported version');
    const t = r.u8();
    if (t > 1) throw new InvalidCodeError('bad type');
    const setup = SETUP[r.u8()];
    if (!setup) throw new InvalidCodeError('bad setup');
    const ufrag = r.str();
    const pwd = r.str();
    if (!/^[A-Za-z0-9+/]{4,256}$/.test(ufrag) || !/^[A-Za-z0-9+/]{22,256}$/.test(pwd)) throw new InvalidCodeError('bad ice');
    const fp = toHex(r.raw(32)).toUpperCase().match(/../g)!.join(':');
    const n = r.u8();
    if (n > MAX_CANDIDATES) throw new InvalidCodeError('too many candidates');
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
      const kind = r.u8();
      let addr: string;
      if (kind === ADDR_IPV4) addr = Array.from(r.raw(4)).join('.');
      else if (kind === ADDR_IPV6) addr = formatIPv6(r.raw(16));
      else if (kind === ADDR_MDNS) {
        const h = toHex(r.raw(16));
        addr = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`;
      } else throw new InvalidCodeError('bad candidate');
      const port = r.u16();
      const priority = ((126 << 24) | ((65535 - i) << 8) | 255) >>> 0;
      lines.push(`a=candidate:${i + 1} 1 udp ${priority} ${addr} ${port} typ host generation 0`);
    }
    const extra = r.blob();
    r.end();
    const sdp = [
      'v=0',
      `o=- ${Date.now()} 2 IN IP4 127.0.0.1`,
      's=-',
      't=0 0',
      'a=group:BUNDLE 0',
      'a=msid-semantic: WMS',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      'c=IN IP4 0.0.0.0',
      `a=ice-ufrag:${ufrag}`,
      `a=ice-pwd:${pwd}`,
      `a=fingerprint:sha-256 ${fp}`,
      `a=setup:${setup}`,
      'a=mid:0',
      'a=sctp-port:5000',
      'a=max-message-size:262144',
      ...lines,
      'a=end-of-candidates',
      '',
    ].join('\r\n');
    return { description: { type: t === 0 ? 'offer' : 'answer', sdp }, extra };
  } catch (e) {
    if (e instanceof InvalidCodeError) throw e;
    throw new InvalidCodeError();
  }
}

/** SDP から DTLS フィンガープリントを取り出す (認証の transcript に使う) */
export function fingerprintOf(sdp: string): string {
  return match(sdp, /a=fingerprint:sha-256 (\S+)/i).toUpperCase();
}

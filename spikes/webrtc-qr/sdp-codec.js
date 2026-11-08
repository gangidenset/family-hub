// SDP を QR コードに収まるサイズへ圧縮/復元するコーデック (技術検証用)
//
// データチャネル専用の SDP は、接続に本質的な情報が以下しかない:
//   - ICE 資格情報 (ice-ufrag / ice-pwd)
//   - DTLS 証明書フィンガープリント (sha-256, 32 byte)
//   - DTLS ロール (setup)
//   - ICE 候補 (アドレス・ポート)
// これらだけをバイナリ化し、受信側で定型の SDP を再構築する。
// 加えて任意の追加ペイロード (招待情報など) を末尾に載せられる。

const VERSION = 1;
const TYPE = { offer: 0, answer: 1 };
const SETUP = ['actpass', 'active', 'passive'];
const ADDR = { ipv4: 0, ipv6: 1, mdnsUuid: 2, string: 3 };
const UUID_RE = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;

class Writer {
  constructor() { this.bytes = []; }
  u8(v) { this.bytes.push(v & 0xff); }
  u16(v) { this.u8(v >> 8); this.u8(v); }
  raw(arr) { for (const b of arr) this.u8(b); }
  str(s) {
    const b = new TextEncoder().encode(s);
    if (b.length > 255) throw new Error('string too long');
    this.u8(b.length); this.raw(b);
  }
  blob(arr) { this.u16(arr.length); this.raw(arr); }
  done() { return Uint8Array.from(this.bytes); }
}

class Reader {
  constructor(bytes) { this.b = bytes; this.i = 0; }
  need(n) { if (this.i + n > this.b.length) throw new Error('truncated payload'); }
  u8() { this.need(1); return this.b[this.i++]; }
  u16() { return (this.u8() << 8) | this.u8(); }
  raw(n) { this.need(n); const r = this.b.slice(this.i, this.i + n); this.i += n; return r; }
  str() { return new TextDecoder().decode(this.raw(this.u8())); }
  blob() { return this.raw(this.u16()); }
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(str) {
  if (!/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('invalid characters');
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function parseIPv6(addr) {
  // "::" 展開を含む IPv6 → 16 byte
  const [head, tail] = addr.includes('::') ? addr.split('::') : [addr, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === null ? [] : Array(8 - h.length - t.length).fill('0');
  const groups = [...h, ...fill, ...t];
  if (groups.length !== 8) throw new Error('bad ipv6');
  const out = [];
  for (const g of groups) { const v = parseInt(g || '0', 16); out.push(v >> 8, v & 0xff); }
  return out;
}
function formatIPv6(bytes) {
  const g = [];
  for (let i = 0; i < 16; i += 2) g.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  return g.join(':');
}

/** RTCSessionDescription(.sdp) → 圧縮文字列 */
export function encodeDescription({ type, sdp }, extra = new Uint8Array()) {
  const line = (re) => { const m = sdp.match(re); if (!m) throw new Error(`missing ${re}`); return m[1]; };
  const ufrag = line(/a=ice-ufrag:(\S+)/);
  const pwd = line(/a=ice-pwd:(\S+)/);
  const fp = line(/a=fingerprint:sha-256 (\S+)/i).replace(/:/g, '');
  const setup = line(/a=setup:(\S+)/);

  const cands = [];
  for (const m of sdp.matchAll(/a=candidate:\S+ (\d) (udp|UDP) \d+ (\S+) (\d+) typ host/g)) {
    if (m[1] !== '1') continue; // RTP component のみ
    cands.push({ addr: m[3], port: Number(m[4]) });
  }

  const w = new Writer();
  w.u8(VERSION);
  w.u8(TYPE[type]);
  w.u8(SETUP.indexOf(setup));
  w.str(ufrag);
  w.str(pwd);
  w.raw(unhex(fp));
  const unique = cands.filter((c, i) => cands.findIndex((d) => d.addr === c.addr && d.port === c.port) === i).slice(0, 8);
  w.u8(unique.length);
  for (const c of unique) {
    const uuid = c.addr.match(UUID_RE);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(c.addr)) {
      w.u8(ADDR.ipv4); w.raw(c.addr.split('.').map(Number));
    } else if (uuid) {
      w.u8(ADDR.mdnsUuid); w.raw(unhex(uuid.slice(1).join('')));
    } else if (c.addr.includes(':')) {
      w.u8(ADDR.ipv6); w.raw(parseIPv6(c.addr));
    } else {
      w.u8(ADDR.string); w.str(c.addr);
    }
    w.u16(c.port);
  }
  w.blob(extra);
  return b64url(w.done());
}

/** 圧縮文字列 → { description: {type, sdp}, extra } */
export function decodeDescription(code) {
  const r = new Reader(unb64url(code));
  if (r.u8() !== VERSION) throw new Error('unsupported version');
  const typeCode = r.u8();
  const type = typeCode === 0 ? 'offer' : typeCode === 1 ? 'answer' : null;
  if (!type) throw new Error('bad type');
  const setup = SETUP[r.u8()];
  if (!setup) throw new Error('bad setup');
  const ufrag = r.str();
  const pwd = r.str();
  // SDP インジェクション防止: ICE 資格情報は RFC 8839 の ice-char のみ許可
  if (!/^[A-Za-z0-9+/]{4,256}$/.test(ufrag) || !/^[A-Za-z0-9+/]{22,256}$/.test(pwd)) throw new Error('bad ice credentials');
  const fp = hex(r.raw(32)).toUpperCase().match(/../g).join(':');
  const n = r.u8();
  const candLines = [];
  for (let i = 0; i < n; i++) {
    const kind = r.u8();
    let addr;
    if (kind === ADDR.ipv4) addr = Array.from(r.raw(4)).join('.');
    else if (kind === ADDR.ipv6) addr = formatIPv6(r.raw(16));
    else if (kind === ADDR.mdnsUuid) {
      const h = hex(r.raw(16));
      addr = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`;
    } else if (kind === ADDR.string) {
      addr = r.str();
      if (!/^[A-Za-z0-9.-]{1,253}$/.test(addr)) throw new Error('bad candidate address');
    } else throw new Error('bad candidate kind');
    const port = r.u16();
    // host 候補の priority (RFC 8445 の推奨式: type pref 126, local pref は順序で減らす)
    const priority = (126 << 24) | ((65535 - i) << 8) | 255;
    candLines.push(`a=candidate:${i + 1} 1 udp ${priority >>> 0} ${addr} ${port} typ host generation 0`);
  }
  const extra = r.blob();

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
    ...candLines,
    'a=end-of-candidates',
    '',
  ].join('\r\n');
  return { description: { type, sdp }, extra };
}

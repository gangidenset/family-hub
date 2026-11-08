// 暗号処理 (Web Crypto API のみを使用) — docs/07-security.md S-1, S-2
import { fromB64url, fromUtf8, randomBytes, toB64url, toHex, utf8 } from '../lib/bytes';

const subtle = () => globalThis.crypto.subtle;

export interface GroupKeys {
  auth: CryptoKey;
  sync: CryptoKey;
  file: CryptoKey;
}

async function hkdf(base: CryptoKey, info: string, usage: 'hmac' | 'aes'): Promise<CryptoKey> {
  const params = { name: 'HKDF', hash: 'SHA-256', salt: utf8('familyhub/v1'), info: utf8(info) };
  if (usage === 'hmac') {
    return subtle().deriveKey(params, base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
  }
  return subtle().deriveKey(params, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** グループ鍵 (32 byte) から用途別の鍵を導出する。用途間で鍵を共有しない */
export async function deriveGroupKeys(groupKeyB64: string): Promise<GroupKeys> {
  const raw = fromB64url(groupKeyB64);
  if (raw.length !== 32) throw new Error('bad group key');
  const base = await subtle().importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  return {
    auth: await hkdf(base, 'auth', 'hmac'),
    sync: await hkdf(base, 'sync-enc', 'aes'),
    file: await hkdf(base, 'file-enc', 'aes'),
  };
}

export async function hmac(key: CryptoKey, data: string): Promise<string> {
  return toB64url(new Uint8Array(await subtle().sign('HMAC', key, utf8(data))));
}

export async function verifyHmac(key: CryptoKey, data: string, mac: string): Promise<boolean> {
  try {
    return await subtle().verify('HMAC', key, fromB64url(mac), utf8(data)); // 定数時間比較
  } catch {
    return false;
  }
}

export interface Sealed {
  iv: string;
  ct: string;
}

export async function seal(key: CryptoKey, plaintext: string, aad: string): Promise<Sealed> {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad) }, key, utf8(plaintext));
  return { iv: toB64url(iv), ct: toB64url(new Uint8Array(ct)) };
}

/** 改ざん・鍵違いの場合は例外 */
export async function open(key: CryptoKey, sealed: Sealed, aad: string): Promise<string> {
  const iv = fromB64url(sealed.iv);
  if (iv.length !== 12) throw new Error('bad iv');
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad) }, key, fromB64url(sealed.ct));
  return fromUtf8(new Uint8Array(pt));
}

export const PBKDF2_ITERATIONS = 600_000;

export async function passphraseKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', utf8(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function sha256Hex(data: string): Promise<string> {
  return toHex(new Uint8Array(await subtle().digest('SHA-256', utf8(data))));
}

/**
 * 確認コード (SAS): 両端末の DTLS フィンガープリントから 6 桁を算出。
 * 中間者がいると両端末で異なる値になる。
 */
export async function shortAuthString(offererFp: string, answererFp: string): Promise<string> {
  const h = new Uint8Array(await subtle().digest('SHA-256', utf8(`familyhub-sas|${offererFp}|${answererFp}`)));
  const n = (((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0) % 1_000_000;
  const s = String(n).padStart(6, '0');
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}

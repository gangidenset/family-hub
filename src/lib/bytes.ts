export function toB64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(str: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('invalid base64url');
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

export const utf8 = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b);

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 安全な JSON パース: プロトタイプ汚染につながるキーを拒否する (docs/07-security.md S-4)
 */
export function safeJsonParse(text: string): unknown {
  return JSON.parse(text, (key, value: unknown) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new Error('forbidden key');
    }
    return value;
  });
}

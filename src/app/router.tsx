// 最小限のハッシュルーター (サーバー設定不要で静的ホスティング・Capacitor のどちらでも動く)
import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from 'react';

function current(): string {
  const h = window.location.hash.replace(/^#/, '');
  return h.startsWith('/') ? h : '/';
}

export function useRoute(): { path: string; query: URLSearchParams } {
  const [hash, setHash] = useState(current);
  useEffect(() => {
    const on = () => setHash(current());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const [path = '/', qs = ''] = hash.split('?');
  return { path, query: new URLSearchParams(qs) };
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) window.location.replace(`#${to}`);
  else window.location.hash = to;
}

export function goBack(fallback = '/'): void {
  if (window.history.length > 1) window.history.back();
  else navigate(fallback, { replace: true });
}

/** パスパターン '/memos/:id' に一致すればパラメータを返す */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/');
  const s = path.split('/');
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(':')) params[p[i]!.slice(1)] = decodeURIComponent(s[i]!);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      href={`#${to}`}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
      }}
      {...rest}
    />
  );
}

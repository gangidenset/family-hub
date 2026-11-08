// 日付ユーティリティ (端末ローカル時刻基準)
const pad = (n: number) => String(n).padStart(2, '0');

/** Date → YYYY-MM-DD (ローカル) */
export function toLocalDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** YYYY-MM-DD → Date (ローカル 0 時) */
export function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}
export function addDays(s: string, n: number): string {
  const d = parseLocalDate(s);
  d.setDate(d.getDate() + n);
  return toLocalDate(d);
}
export const today = () => toLocalDate(new Date());

/** YYYY-MM-DD + HH:mm (ローカル) → ISO UTC */
export function localToIso(date: string, time: string): string {
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const d = parseLocalDate(date);
  d.setHours(h, mi, 0, 0);
  return d.toISOString();
}
export function isoToLocalTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function isoToLocalDate(iso: string): string {
  return toLocalDate(new Date(iso));
}

const WD = ['日', '月', '火', '水', '木', '金', '土'];
export function formatDate(s: string, opts: { weekday?: boolean; year?: boolean } = {}): string {
  const d = parseLocalDate(s);
  const base = `${opts.year ? `${d.getFullYear()}年` : ''}${d.getMonth() + 1}月${d.getDate()}日`;
  return opts.weekday ? `${base}(${WD[d.getDay()]})` : base;
}
export const weekdayLabels = WD;

/** 「今日」「明日」「11月10日(火)」 */
export function friendlyDate(s: string): string {
  const t = today();
  if (s === t) return '今日';
  if (s === addDays(t, 1)) return '明日';
  if (s === addDays(t, -1)) return '昨日';
  return formatDate(s, { weekday: true });
}

export function relativeTime(iso: string, now = Date.now()): string {
  const diff = Math.round((now - new Date(iso).getTime()) / 1000);
  if (diff < 60) return 'たった今';
  if (diff < 3600) return `${Math.floor(diff / 60)}分前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}時間前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}日前`;
  return formatDate(isoToLocalDate(iso), { year: new Date(iso).getFullYear() !== new Date().getFullYear() });
}

/** 月表示用: 6 週 × 7 日の日付配列 (日曜始まり) */
export function monthGrid(year: number, month: number): string[] {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => toLocalDate(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)));
}

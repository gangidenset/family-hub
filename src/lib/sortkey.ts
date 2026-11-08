// 分数インデックス: 2 つのキーの間に新しいキーを生成する。
// 並び替え時に他の項目を書き換えないため、同期で競合しにくい。
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;

function digit(c: string): number {
  const d = DIGITS.indexOf(c);
  if (d < 0) throw new Error('invalid sort key');
  return d;
}

/** a < 結果 < b となるキーを返す (a=null は先頭, b=null は末尾) */
export function keyBetween(a: string | null, b: string | null): string {
  const lo = a ?? '';
  let hi: string | null = b;
  if (hi !== null && lo >= hi) throw new Error('keyBetween: a must be < b');
  let prefix = '';
  for (let i = 0; ; i++) {
    const da = i < lo.length ? digit(lo[i]!) : 0;
    const db = hi !== null ? (i < hi.length ? digit(hi[i]!) : 0) : BASE;
    if (da === db) {
      prefix += DIGITS[da];
      continue;
    }
    if (db - da > 1) return prefix + DIGITS[Math.floor((da + db) / 2)];
    // 差が 1: 下側の桁を採用し、以降は上限なしで続ける
    prefix += DIGITS[da];
    hi = null;
  }
}

/** 並び済み配列の末尾に追加するキー */
export function keyAfterLast(keys: string[]): string {
  const last = keys.length ? keys.reduce((m, k) => (k > m ? k : m)) : null;
  return keyBetween(last, null);
}

import { describe, expect, it } from 'vitest';
import { ClockDriftError, formatHlc, parseHlc, receive, tick, MAX_DRIFT_MS } from '../../src/db/hlc';
import { keyAfterLast, keyBetween } from '../../src/lib/sortkey';

const dev = '11111111-1111-4111-8111-111111111111';

describe('HLC', () => {
  it('単調増加し、文字列比較で順序が決まる', () => {
    let s = { ms: 0, counter: 0 };
    const out: string[] = [];
    for (const now of [1000, 1000, 999, 2000]) {
      const r = tick(s, now, dev);
      s = r.state;
      out.push(r.hlc);
    }
    expect([...out].sort()).toEqual(out);
    expect(new Set(out).size).toBe(4);
    expect(parseHlc(out[1]!)).toEqual({ ms: 1000, counter: 1, deviceId: dev });
  });
  it('時計が遅れた端末でも受信後は相手より大きい HLC を出す', () => {
    const remote = formatHlc(5000, 3, dev);
    const s = receive({ ms: 100, counter: 0 }, remote, 100);
    expect(tick(s, 100, dev).hlc > remote).toBe(true);
  });
  it('未来すぎる HLC は拒否する', () => {
    expect(() => receive({ ms: 0, counter: 0 }, formatHlc(1000 + MAX_DRIFT_MS + 1, 0, dev), 1000)).toThrow(ClockDriftError);
  });
});

describe('sortKey', () => {
  it('間のキーを生成できる', () => {
    const cases: [string | null, string | null][] = [[null, null], [null, 'i'], ['i', null], ['a', 'b'], ['a', 'a1'], ['0i', '1'], ['z', null], ['zz', null]];
    for (const [a, b] of cases) {
      const k = keyBetween(a, b);
      if (a) expect(k > a).toBe(true);
      if (b) expect(k < b).toBe(true);
      expect(k).toMatch(/^[0-9a-z]+$/);
      expect(k.endsWith('0')).toBe(false);
    }
  });
  it('同じ位置に繰り返し挿入しても順序が保たれる', () => {
    let lo = 'a';
    const hi = 'b';
    const keys: string[] = [];
    for (let i = 0; i < 50; i++) {
      lo = keyBetween(lo, hi);
      keys.push(lo);
    }
    expect([...keys].sort()).toEqual(keys);
    expect(keyAfterLast(keys) > keys[49]!).toBe(true);
  });
  it('不正な順序は例外', () => {
    expect(() => keyBetween('b', 'a')).toThrow();
  });
});

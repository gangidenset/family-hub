// Hybrid Logical Clock (docs/04-data-model.md §2)
// 文字列比較で全順序が決まる: <13桁ms>-<4桁16進カウンタ>-<deviceId>

export interface HlcState {
  ms: number;
  counter: number;
}

/** 受信した HLC が現在時刻よりこれ以上未来なら拒否する */
export const MAX_DRIFT_MS = 24 * 60 * 60 * 1000;
const MAX_COUNTER = 0xffff;

export class ClockDriftError extends Error {
  constructor() {
    super('clock-drift');
  }
}

export function formatHlc(ms: number, counter: number, deviceId: string): string {
  return `${String(ms).padStart(13, '0')}-${counter.toString(16).padStart(4, '0')}-${deviceId}`;
}

export function parseHlc(hlc: string): HlcState & { deviceId: string } {
  const ms = Number(hlc.slice(0, 13));
  const counter = parseInt(hlc.slice(14, 18), 16);
  return { ms, counter, deviceId: hlc.slice(19) };
}

/** ローカルイベント用に時計を進める */
export function tick(state: HlcState, now: number, deviceId: string): { state: HlcState; hlc: string } {
  let next: HlcState;
  if (now > state.ms) next = { ms: now, counter: 0 };
  else if (state.counter < MAX_COUNTER) next = { ms: state.ms, counter: state.counter + 1 };
  else next = { ms: state.ms + 1, counter: 0 };
  return { state: next, hlc: formatHlc(next.ms, next.counter, deviceId) };
}

/** 受信した HLC を取り込み時計を進める (未来すぎる場合は ClockDriftError) */
export function receive(state: HlcState, remote: string, now: number): HlcState {
  const r = parseHlc(remote);
  if (r.ms > now + MAX_DRIFT_MS) throw new ClockDriftError();
  if (r.ms > state.ms) return { ms: r.ms, counter: r.counter };
  if (r.ms === state.ms && r.counter > state.counter) return { ms: r.ms, counter: r.counter };
  return state;
}

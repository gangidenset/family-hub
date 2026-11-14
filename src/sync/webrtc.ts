// WebRTC DataChannel トランスポート (STUN/TURN を使わない = 外部サーバーへの通信ゼロ)
import { decodeDescription, encodeDescription, fingerprintOf } from './codec';
import { FramedChannel } from './channel';
import { SyncError } from './protocol';

const GATHER_MAX_MS = 6000;
const GATHER_AFTER_FIRST_MS = 1500;
const HIGH_WATER = 1_000_000;

export interface CandidateSummary {
  mdns: number;
  ipv4: number;
  ipv6: number;
}

/** 接続失敗時の調査用情報 (IP アドレスそのものは含めない) */
export interface LinkDiagnostics {
  camera: 'granted' | 'denied' | 'unavailable' | 'not-requested';
  local: CandidateSummary | null;
  remote: CandidateSummary | null;
  ice: string[];
  connection: string[];
  gatheringMs: number | null;
}

export function summarizeCandidates(sdp: string): CandidateSummary {
  const out: CandidateSummary = { mdns: 0, ipv4: 0, ipv6: 0 };
  for (const m of sdp.matchAll(/a=candidate:\S+ 1 udp \d+ (\S+) \d+ typ host/gi)) {
    const addr = m[1]!;
    if (addr.endsWith('.local')) out.mdns++;
    else if (addr.includes(':')) out.ipv6++;
    else out.ipv4++;
  }
  return out;
}

/**
 * カメラ (映像のみ) を一時的に使用する。
 * Chrome / Safari は、カメラの使用が許可されたページでは端末の IP アドレスを
 * 「xxxx.local」(mDNS 名) に置き換えずに接続候補として使う。mDNS 名の解決は
 * Android や一部のルーターで失敗しやすいため、接続情報を作る間だけカメラを使う。
 */
async function holdCamera(diag: LinkDiagnostics): Promise<() => void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    diag.camera = 'unavailable';
    return () => undefined;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    diag.camera = 'granted';
    return () => stream.getTracks().forEach((t) => t.stop());
  } catch (e) {
    diag.camera = (e as Error).name === 'NotAllowedError' ? 'denied' : 'unavailable';
    return () => undefined;
  }
}

export class PeerLink {
  readonly pc: RTCPeerConnection;
  private dc: RTCDataChannel;
  readonly channel: FramedChannel;
  private openPromise: Promise<void>;
  readonly diagnostics: LinkDiagnostics = { camera: 'not-requested', local: null, remote: null, ice: [], connection: [], gatheringMs: null };

  constructor() {
    this.pc = new RTCPeerConnection({ iceServers: [] });
    // 両端末で同じ ID の negotiated チャネルを使う (追加のシグナリングが不要)
    this.dc = this.pc.createDataChannel('familyhub', { negotiated: true, id: 0, ordered: true });
    this.dc.bufferedAmountLowThreshold = 256_000;
    const dc = this.dc;
    this.channel = new FramedChannel({
      async sendRaw(s) {
        if (dc.readyState !== 'open') throw new SyncError('connection-lost');
        if (dc.bufferedAmount > HIGH_WATER) {
          await new Promise<void>((resolve) => dc.addEventListener('bufferedamountlow', () => resolve(), { once: true }));
        }
        dc.send(s);
      },
      closeRaw: () => this.close(),
    });
    dc.onmessage = (e) => this.channel.feed(e.data);
    dc.onclose = () => this.channel.handleClosed();
    this.pc.oniceconnectionstatechange = () => this.diagnostics.ice.push(this.pc.iceConnectionState);
    this.pc.onconnectionstatechange = () => {
      this.diagnostics.connection.push(this.pc.connectionState);
      if (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed') this.channel.handleClosed();
    };
    this.openPromise = new Promise((resolve) => {
      if (dc.readyState === 'open') resolve();
      dc.addEventListener('open', () => resolve(), { once: true });
    });
  }

  private gather(): Promise<void> {
    return new Promise((resolve) => {
      let firstTimer: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        clearTimeout(max);
        if (firstTimer) clearTimeout(firstTimer);
        resolve();
      };
      const max = setTimeout(done, GATHER_MAX_MS);
      if (this.pc.iceGatheringState === 'complete') return done();
      this.pc.addEventListener('icegatheringstatechange', () => {
        if (this.pc.iceGatheringState === 'complete') done();
      });
      this.pc.addEventListener('icecandidate', (e) => {
        if (!e.candidate) return done();
        if (!firstTimer && / typ host/.test(e.candidate.candidate)) firstTimer = setTimeout(done, GATHER_AFTER_FIRST_MS);
      });
    });
  }

  /** 接続候補の収集 (カメラ使用中に行い、実 IP の候補を得る) */
  private async prepareLocal(make: () => Promise<RTCSessionDescriptionInit>): Promise<string> {
    const release = await holdCamera(this.diagnostics);
    try {
      const t0 = performance.now();
      await this.pc.setLocalDescription(await make());
      await this.gather();
      this.diagnostics.gatheringMs = Math.round(performance.now() - t0);
    } finally {
      release();
    }
    const sdp = this.pc.localDescription!.sdp;
    this.diagnostics.local = summarizeCandidates(sdp);
    return sdp;
  }

  async createOffer(extra: Uint8Array): Promise<string> {
    const sdp = await this.prepareLocal(() => this.pc.createOffer());
    return encodeDescription({ type: 'offer', sdp }, extra);
  }

  /** 相手の Offer コードを適用し、こちらの Answer コードを返す */
  async acceptOffer(code: string): Promise<{ answer: string; extra: Uint8Array }> {
    const { description, extra } = decodeDescription(code);
    if (description.type !== 'offer') throw new Error('not an offer');
    this.diagnostics.remote = summarizeCandidates(description.sdp);
    await this.pc.setRemoteDescription(description);
    const sdp = await this.prepareLocal(() => this.pc.createAnswer());
    return { answer: encodeDescription({ type: 'answer', sdp }), extra };
  }

  async acceptAnswer(code: string): Promise<void> {
    const { description } = decodeDescription(code);
    if (description.type !== 'answer') throw new Error('not an answer');
    this.diagnostics.remote = summarizeCandidates(description.sdp);
    await this.pc.setRemoteDescription(description);
  }

  waitOpen(timeoutMs = 20_000): Promise<FramedChannel> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new SyncError('connect-timeout')), timeoutMs);
      this.openPromise.then(() => {
        clearTimeout(t);
        resolve(this.channel);
      });
    });
  }

  fingerprints(): { local: string; remote: string } {
    return { local: fingerprintOf(this.pc.localDescription!.sdp), remote: fingerprintOf(this.pc.remoteDescription!.sdp) };
  }

  close(): void {
    try {
      this.dc.close();
      this.pc.close();
    } catch {
      /* already closed */
    }
    this.channel.handleClosed();
  }
}

export function webrtcSupported(): boolean {
  return typeof RTCPeerConnection !== 'undefined';
}

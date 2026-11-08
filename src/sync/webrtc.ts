// WebRTC DataChannel トランスポート (STUN/TURN を使わない = 外部サーバーへの通信ゼロ)
import { decodeDescription, encodeDescription, fingerprintOf } from './codec';
import { FramedChannel } from './channel';
import { SyncError } from './protocol';

const GATHER_MAX_MS = 6000;
const GATHER_AFTER_FIRST_MS = 1500;
const HIGH_WATER = 1_000_000;

export class PeerLink {
  readonly pc: RTCPeerConnection;
  private dc: RTCDataChannel;
  readonly channel: FramedChannel;
  private openPromise: Promise<void>;

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
    this.pc.onconnectionstatechange = () => {
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

  async createOffer(extra: Uint8Array): Promise<string> {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await this.gather();
    return encodeDescription({ type: 'offer', sdp: this.pc.localDescription!.sdp }, extra);
  }

  /** 相手の Offer コードを適用し、こちらの Answer コードを返す */
  async acceptOffer(code: string): Promise<{ answer: string; extra: Uint8Array }> {
    const { description, extra } = decodeDescription(code);
    if (description.type !== 'offer') throw new Error('not an offer');
    await this.pc.setRemoteDescription(description);
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await this.gather();
    return { answer: encodeDescription({ type: 'answer', sdp: this.pc.localDescription!.sdp }), extra };
  }

  async acceptAnswer(code: string): Promise<void> {
    const { description } = decodeDescription(code);
    if (description.type !== 'answer') throw new Error('not an answer');
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

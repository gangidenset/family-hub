// QR コードの表示と読み取り (カメラ映像はすべて端末内で処理し、保存・送信しない)
import { useEffect, useRef, useState } from 'react';
import { CODE_PREFIX } from '../../sync/codec';
import { Icon } from '../../components/Icon';
import { useFeedback } from '../../components/ui';

export function QrDisplay({ code, caption }: { code: string; caption: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const { toast } = useFeedback();
  useEffect(() => {
    let alive = true;
    void import('qrcode').then((QR) =>
      QR.toDataURL(code, { errorCorrectionLevel: 'M', margin: 1, scale: 8, color: { dark: '#000000', light: '#ffffff' } }).then((url) => alive && setSrc(url)),
    );
    return () => {
      alive = false;
    };
  }, [code]);
  return (
    <div className="qr-box">
      {src ? <img src={src} alt="接続用 QR コード" /> : <div className="spinner" />}
      <p className="center">{caption}</p>
      <details className="small" style={{ width: '100%' }}>
        <summary>カメラが使えない場合 (コードで共有)</summary>
        <div className="stack" style={{ marginTop: 8 }}>
          <textarea className="textarea code-text" readOnly value={code} data-testid="code-text" aria-label="接続コード" />
          <button
            className="btn small"
            onClick={() =>
              void navigator.clipboard
                ?.writeText(code)
                .then(() => toast('コピーしました'))
                .catch(() => toast('コピーできませんでした'))
            }
          >
            <Icon name="copy" />
            コードをコピー
          </button>
        </div>
      </details>
    </div>
  );
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: new (opts: { formats: string[] }) => BarcodeDetectorLike;
  }
}

export function QrScanner({ onResult, hint }: { onResult: (code: string) => void; hint: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<'starting' | 'scanning' | 'unavailable'>('starting');
  const [pasted, setPasted] = useState('');
  const doneRef = useRef(false);
  const cb = useRef(onResult);
  cb.current = onResult;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const finish = (code: string) => {
      if (doneRef.current) return;
      doneRef.current = true;
      cb.current(code);
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) return setStatus('unavailable');
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      } catch {
        return setStatus('unavailable');
      }
      if (stopped) return stream.getTracks().forEach((t) => t.stop());
      const video = videoRef.current!;
      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      await video.play().catch(() => undefined);
      setStatus('scanning');
      const detector = window.BarcodeDetector ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
      const jsQR = detector ? null : (await import('jsqr')).default;
      const scan = async () => {
        if (stopped || doneRef.current) return;
        if (video.readyState >= 2 && ctx) {
          const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          try {
            let text: string | undefined;
            if (detector) text = (await detector.detect(canvas))[0]?.rawValue;
            else if (jsQR) text = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' })?.data;
            if (text?.startsWith(CODE_PREFIX)) return finish(text);
          } catch {
            /* 次のフレームで再試行 */
          }
        }
        timer = setTimeout(() => void scan(), 150);
      };
      void scan();
    })();

    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const pasteForm = (
    <form
      className="stack"
      style={{ marginTop: 8 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (pasted.trim()) cb.current(pasted.trim());
      }}
    >
      <textarea className="textarea code-text" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="FH1:..." aria-label="相手の接続コード" data-testid="code-input" />
      <button className="btn small primary" type="submit">
        このコードで接続
      </button>
    </form>
  );

  return (
    <div className="stack">
      {status !== 'unavailable' ? (
        <div className="scanner">
          <video ref={videoRef} muted playsInline aria-label="カメラ映像" />
          <div className="frame" />
        </div>
      ) : (
        <div className="notice warn">
          <Icon name="camera" />
          <span>カメラを使えません。ブラウザの設定でカメラを許可するか、下の欄に相手の接続コードを貼り付けてください。</span>
        </div>
      )}
      <p className="center">{hint}</p>
      {status === 'unavailable' ? (
        <div className="small">{pasteForm}</div>
      ) : (
        <details className="small">
          <summary>コードを貼り付けて接続</summary>
          {pasteForm}
        </details>
      )}
    </div>
  );
}

// 端末間接続フロー: QR 交換 → WebRTC 接続 → (ペアリング) → 同期
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FamilyDB, SyncErrorCode } from '../../db/db';
import type { Session } from '../../db/repo';
import { COLORS, type Color } from '../../domain/schemas';
import { decodeDescription, InvalidCodeError } from '../../sync/codec';
import { runPairInviter, runPairJoiner, type Invite, type JoinChoice } from '../../sync/pairing';
import { runSync, SyncError, type SyncOutcome, type SyncProgress } from '../../sync/protocol';
import { PeerLink, webrtcSupported } from '../../sync/webrtc';
import { fromUtf8, safeJsonParse, utf8 } from '../../lib/bytes';
import { guessDeviceName, isStandalone } from '../../lib/device';
import { useApp } from '../../app/context';
import { goBack, navigate } from '../../app/router';
import { Avatar, ColorPicker, Field, PageHeader, useFeedback } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { QrDisplay, QrScanner } from './Qr';

type Mode = 'pair' | 'sync';
type Role = 'host' | 'guest';
type ErrorCode = SyncErrorCode | 'invalid-code' | 'wrong-mode' | 'unsupported';

type Phase =
  | { k: 'preparing' }
  | { k: 'show-offer'; code: string }
  | { k: 'scan-answer'; error?: string }
  | { k: 'scan-offer'; error?: string }
  | { k: 'show-answer'; code: string }
  | { k: 'connecting' }
  | { k: 'sas'; sas: string }
  | { k: 'choose-member'; invite: Invite }
  | { k: 'syncing'; progress: SyncProgress | null }
  | { k: 'done'; outcome: SyncOutcome }
  | { k: 'error'; code: ErrorCode; diag: string };

export const SYNC_ERROR_TEXT: Record<ErrorCode, string> = {
  'connect-timeout':
    '接続できませんでした。両方の端末が同じ Wi-Fi につながっているか確認してください。ゲスト Wi-Fi や一部のルーターでは端末同士の通信が制限されています。その場合は「ファイルで同期」をお使いください。',
  'connection-lost': '通信が途中で切れました。受け取ったデータは保存済みです。もう一度お試しください。',
  'auth-failed': '相手の端末を確認できませんでした。確認コードが一致しないか、別の家族グループの端末です。',
  'different-group': '別の家族グループの端末です。',
  revoked: 'この端末は家族グループから削除されています。',
  'incompatible-version': 'アプリのバージョンが異なります。両方の端末でアプリを最新にしてください。',
  'invalid-data': '受け取ったデータが正しくないため、同期を中止しました。端末内のデータは変更されていません。',
  'missing-key': 'この端末には同期用の鍵がありません。家族の端末で「端末を追加」を選び、ペアリングし直してください。',
  'clock-drift': '相手の端末の時計が大きくずれています。日時設定を確認してください。',
  cancelled: '中止しました。',
  unknown: '予期しないエラーが発生しました。もう一度お試しください。',
  'invalid-code': 'FamilyHub の接続コードではありません。',
  'wrong-mode': '相手の端末と操作が一致していません。片方が「端末を追加」、もう片方が「参加する」を選ぶか、両方で「同期」を選んでください。',
  unsupported: 'このブラウザは端末間通信 (WebRTC) に対応していません。「ファイルで同期」をお使いください。',
};

interface FlowProps {
  db: FamilyDB;
  session: Session | null;
  mode: Mode;
  role: Role;
  onExit: () => void;
  onFinished: (outcome: SyncOutcome) => void | Promise<void>;
}

const CONNECT_TIMEOUT_HOST = 30_000;
const CONNECT_TIMEOUT_GUEST = 120_000;

export function ConnectFlow({ db, session, mode, role, onExit, onFinished }: FlowProps) {
  const [phase, setPhase] = useState<Phase>(() => (role === 'host' ? { k: 'preparing' } : { k: 'scan-offer' }));
  const [attempt, setAttempt] = useState(0);
  const link = useRef<PeerLink | null>(null);
  const sasResolve = useRef<((ok: boolean) => void) | null>(null);
  const memberResolve = useRef<((c: JoinChoice) => void) | null>(null);
  const alive = useRef(true);
  const stage = useRef<Phase['k']>('preparing');
  useEffect(() => {
    if (phase.k !== 'error') stage.current = phase.k;
  }, [phase.k]);

  const fail = useCallback(
    (e: unknown) => {
      if (!alive.current) return;
      const code: ErrorCode = e instanceof SyncError ? e.code : e instanceof InvalidCodeError ? 'invalid-code' : 'unknown';
      const diag = formatDiagnostics({ mode, role, stage: stage.current, code, link: link.current, error: e });
      link.current?.close();
      setPhase({ k: 'error', code, diag });
    },
    [mode, role],
  );

  const runProtocol = useCallback(
    async (l: PeerLink, timeoutMs: number) => {
      try {
        const channel = await l.waitOpen(timeoutMs);
        if (!alive.current) return;
        setPhase({ k: 'syncing', progress: null });
        const fp = l.fingerprints();
        const base = { db, channel, localFingerprint: fp.local, remoteFingerprint: fp.remote };
        const onProgress = (p: SyncProgress) => alive.current && setPhase({ k: 'syncing', progress: p });
        const confirmSas = (sas: string) =>
          new Promise<boolean>((resolve) => {
            sasResolve.current = resolve;
            setPhase({ k: 'sas', sas });
          });
        let outcome: SyncOutcome;
        if (mode === 'sync') {
          outcome = await runSync({ ...base, session: session!, role: role === 'host' ? 'offerer' : 'answerer', onProgress });
        } else if (role === 'host') {
          outcome = await runPairInviter({ ...base, session: session!, confirmSas, onProgress });
        } else {
          outcome = await runPairJoiner({
            ...base,
            confirmSas,
            onProgress,
            chooseMember: (invite) =>
              new Promise<JoinChoice>((resolve) => {
                memberResolve.current = resolve;
                setPhase({ k: 'choose-member', invite });
              }),
          });
        }
        l.close();
        if (!alive.current) return;
        setPhase({ k: 'done', outcome });
      } catch (e) {
        fail(e);
      }
    },
    [db, session, mode, role, fail],
  );

  // ホスト: Offer を作って QR 表示
  useEffect(() => {
    alive.current = true;
    if (!webrtcSupported()) {
      setPhase({ k: 'error', code: 'unsupported', diag: formatDiagnostics({ mode, role, stage: 'preparing', code: 'unsupported', link: null, error: null }) });
      return;
    }
    if (role !== 'host') {
      setPhase({ k: 'scan-offer' });
      return;
    }
    const l = new PeerLink();
    link.current = l;
    setPhase({ k: 'preparing' });
    const extra = utf8(JSON.stringify(mode === 'pair' ? { m: 'p' } : { m: 's', g: session!.groupId }));
    l.createOffer(extra).then(
      (code) => alive.current && setPhase({ k: 'show-offer', code }),
      (e) => fail(e),
    );
    return () => {
      alive.current = false;
      l.close();
    };
  }, [role, mode, session, attempt, fail]);

  useEffect(
    () => () => {
      alive.current = false;
      link.current?.close();
    },
    [],
  );

  const onAnswerScanned = async (code: string) => {
    const l = link.current!;
    try {
      await l.acceptAnswer(code);
    } catch {
      setPhase({ k: 'scan-answer', error: '相手の画面に表示された「2 枚目」の QR コードを読み取ってください。' });
      return;
    }
    setPhase({ k: 'connecting' });
    void runProtocol(l, CONNECT_TIMEOUT_HOST);
  };

  const onOfferScanned = async (code: string) => {
    let extra: { m?: unknown; g?: unknown };
    try {
      const d = decodeDescription(code);
      if (d.description.type !== 'offer') throw new InvalidCodeError();
      extra = safeJsonParse(fromUtf8(d.extra)) as typeof extra;
    } catch {
      setPhase({ k: 'scan-offer', error: SYNC_ERROR_TEXT['invalid-code'] + ' 相手の画面に表示された 1 枚目の QR コードを読み取ってください。' });
      return;
    }
    if ((mode === 'pair' && extra.m !== 'p') || (mode === 'sync' && extra.m !== 's')) {
      setPhase({ k: 'error', code: 'wrong-mode', diag: formatDiagnostics({ mode, role, stage: 'scan-offer', code: 'wrong-mode', link: null, error: null }) });
      return;
    }
    if (mode === 'sync' && extra.g !== session?.groupId) {
      setPhase({ k: 'error', code: 'different-group', diag: formatDiagnostics({ mode, role, stage: 'scan-offer', code: 'different-group', link: null, error: null }) });
      return;
    }
    link.current?.close();
    const l = new PeerLink();
    link.current = l;
    setPhase({ k: 'preparing' });
    try {
      const { answer } = await l.acceptOffer(code);
      if (!alive.current) return;
      setPhase({ k: 'show-answer', code: answer });
      void runProtocol(l, CONNECT_TIMEOUT_GUEST);
    } catch (e) {
      fail(e);
    }
  };

  const retry = () => {
    link.current?.close();
    sasResolve.current = null;
    memberResolve.current = null;
    if (role === 'host') setAttempt((a) => a + 1);
    else setPhase({ k: 'scan-offer' });
  };

  const title = mode === 'pair' ? (role === 'host' ? '端末を追加' : '家族のグループに参加') : '家族の端末と同期';
  const step = { preparing: 1, 'show-offer': 1, 'scan-offer': 1, 'scan-answer': 2, 'show-answer': 2 }[phase.k as string] ?? 3;

  return (
    <>
      <PageHeader
        title={title}
        actions={
          <button className="icon-btn" aria-label="閉じる" onClick={onExit}>
            <Icon name="x" />
          </button>
        }
      />
      <main className="main no-tabs">
        <div className="steps" aria-hidden="true">
          {[1, 2, 3].map((n) => (
            <span key={n} className={n <= step ? 'on' : ''} />
          ))}
        </div>
        {phase.k === 'preparing' && (
          <div className="center">
            <div className="spinner" />
            <p>接続の準備をしています…</p>
          </div>
        )}
        {phase.k === 'show-offer' && (
          <div className="stack">
            <QrDisplay code={phase.code} caption={mode === 'pair' ? '新しい端末で「家族のグループに参加する」を選び、この QR を読み取ってください。' : '家族の端末で「同期」→「QR を読み取る」を選び、この QR を読み取ってください。'} />
            <button className="btn primary block" onClick={() => setPhase({ k: 'scan-answer' })}>
              <Icon name="camera" />
              次へ: 相手の QR を読み取る
            </button>
          </div>
        )}
        {phase.k === 'scan-answer' && (
          <div className="stack">
            {phase.error && <p className="notice warn">{phase.error}</p>}
            <QrScanner hint="相手の端末に表示された QR コードを読み取ってください。" onResult={(c) => void onAnswerScanned(c)} />
          </div>
        )}
        {phase.k === 'scan-offer' && (
          <div className="stack">
            {phase.error && <p className="notice warn">{phase.error}</p>}
            <QrScanner hint={mode === 'pair' ? '家族の端末で「家族メンバー」→「端末を追加」を開き、表示された QR を読み取ってください。' : '家族の端末で「同期」→「QR を表示」を選び、表示された QR を読み取ってください。'} onResult={(c) => void onOfferScanned(c)} />
          </div>
        )}
        {phase.k === 'show-answer' && <QrDisplay code={phase.code} caption="相手の端末でこの QR を読み取ってください。読み取られると自動で接続します。" />}
        {phase.k === 'connecting' && (
          <div className="center">
            <div className="spinner" />
            <p>接続しています…</p>
            <p className="muted small">両方の端末で FamilyHub を開いたままにしてください。</p>
          </div>
        )}
        {phase.k === 'sas' && (
          <div className="stack center">
            <p>両方の端末に同じ数字が表示されているか確認してください。</p>
            <div className="sas" data-testid="sas">
              {phase.sas}
            </div>
            <div className="btn-row">
              <button
                className="btn danger"
                onClick={() => {
                  sasResolve.current?.(false);
                  sasResolve.current = null;
                }}
              >
                違う
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  sasResolve.current?.(true);
                  sasResolve.current = null;
                  setPhase({ k: 'syncing', progress: null });
                }}
              >
                一致している
              </button>
            </div>
          </div>
        )}
        {phase.k === 'choose-member' && (
          <ChooseMember
            invite={phase.invite}
            replacingOtherGroup={!!session && session.groupId !== phase.invite.groupId}
            onChoose={(c) => {
              memberResolve.current?.(c);
              memberResolve.current = null;
              setPhase({ k: 'syncing', progress: null });
            }}
          />
        )}
        {phase.k === 'syncing' && (
          <div className="stack center">
            <div className="spinner" />
            <p>{phase.progress?.phase === 'apply' ? '受け取ったデータを保存しています…' : phase.progress ? 'データをやり取りしています…' : '相手の操作を待っています…'}</p>
            {phase.progress && (
              <p className="muted small">
                送信 {phase.progress.sent} 件 / 受信 {phase.progress.received} 件
              </p>
            )}
            <p className="muted small">画面を閉じずにお待ちください。</p>
          </div>
        )}
        {phase.k === 'done' && (
          <div className="stack center" data-testid="sync-done">
            <div style={{ color: 'var(--primary)' }}>
              <Icon name="check" />
            </div>
            <h2>{mode === 'pair' ? 'ペアリングが完了しました' : '同期が完了しました'}</h2>
            <p className="muted">
              送信 {phase.outcome.sent} 件・受信 {phase.outcome.received} 件
              {phase.outcome.conflicts > 0 && `・競合 ${phase.outcome.conflicts} 件 (メモ画面で確認できます)`}
            </p>
            <button className="btn primary block" onClick={() => void onFinished(phase.outcome)}>
              {mode === 'pair' && role === 'guest' ? 'はじめる' : '完了'}
            </button>
          </div>
        )}
        {phase.k === 'error' && (
          <div className="stack" data-testid="sync-error">
            <div className="notice danger">
              <Icon name="alert" />
              <span>{SYNC_ERROR_TEXT[phase.code]}</span>
            </div>
            <button className="btn primary block" onClick={retry}>
              <Icon name="sync" />
              もう一度試す
            </button>
            {session && (
              <button className="btn block" onClick={() => navigate('/sync?file=1', { replace: true })}>
                <Icon name="file" />
                ファイルで同期する
              </button>
            )}
            <DiagnosticsBox text={phase.diag} />
          </div>
        )}
      </main>
    </>
  );
}

const STAGE_LABEL: Partial<Record<Phase['k'], string>> = {
  preparing: '接続情報の準備',
  'show-offer': 'QR (1 枚目) の表示',
  'scan-answer': 'QR (2 枚目) の読み取り',
  'scan-offer': 'QR (1 枚目) の読み取り',
  'show-answer': 'QR (2 枚目) の表示 / 相手の読み取り待ち',
  connecting: '端末同士の接続',
  sas: '確認コードの照合',
  'choose-member': 'メンバーの選択',
  syncing: 'データのやり取り',
};

function summary(c: { mdns: number; ipv4: number; ipv6: number } | null): string {
  return c ? `mDNS ${c.mdns} / IPv4 ${c.ipv4} / IPv6 ${c.ipv6}` : '不明';
}

/** 問い合わせ用の診断情報 (IP アドレスや家族のデータは含めない) */
function formatDiagnostics(o: { mode: Mode; role: Role; stage: Phase['k']; code: ErrorCode; link: PeerLink | null; error: unknown }): string {
  const d = o.link?.diagnostics;
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? `iOS ${(ua.match(/OS (\d+[_\d]*)/)?.[1] ?? '?').replace(/_/g, '.')}` : /Android/.test(ua) ? `Android ${ua.match(/Android ([\d.]+)/)?.[1] ?? '?'}` : 'その他';
  const browser = /CriOS|Chrome\//.test(ua) ? `Chrome ${ua.match(/(?:CriOS|Chrome)\/(\d+)/)?.[1] ?? ''}` : /Safari\//.test(ua) ? `Safari ${ua.match(/Version\/([\d.]+)/)?.[1] ?? ''}` : 'その他';
  const lines = [
    `操作: ${o.mode === 'pair' ? 'ペアリング' : '同期'} / ${o.role === 'host' ? 'QR を表示する側' : 'QR を読み取る側'}`,
    `失敗した段階: ${STAGE_LABEL[o.stage] ?? o.stage}`,
    `エラー: ${o.code}${o.code === 'unknown' && o.error instanceof Error ? ` (${o.error.name})` : ''}`,
    `端末: ${os} / ${browser} / ${isStandalone() ? 'ホーム画面から起動' : 'ブラウザ'}`,
    `カメラ許可: ${d?.camera ?? '不明'}`,
    `自分の接続候補: ${summary(d?.local ?? null)}`,
    `相手の接続候補: ${summary(d?.remote ?? null)}`,
    `ICE 状態: ${d?.ice.join(' → ') || 'なし'}`,
    `接続状態: ${d?.connection.join(' → ') || 'なし'}`,
    `候補収集: ${d?.gatheringMs ?? '-'} ms`,
  ];
  return lines.join('\n');
}

function DiagnosticsBox({ text }: { text: string }) {
  const { toast } = useFeedback();
  return (
    <details className="small">
      <summary>技術情報 (不具合の報告用)</summary>
      <pre className="code-text" style={{ whiteSpace: 'pre-wrap', background: 'var(--surface-2)', padding: 12, borderRadius: 10 }} data-testid="sync-diagnostics">
        {text}
      </pre>
      <button
        className="btn small"
        onClick={() =>
          void navigator.clipboard
            ?.writeText(text)
            .then(() => toast('コピーしました'))
            .catch(() => toast('コピーできませんでした'))
        }
      >
        <Icon name="copy" />
        技術情報をコピー
      </button>
      <p className="muted">IP アドレスや家族のデータは含まれません。</p>
    </details>
  );
}

function ChooseMember({ invite, replacingOtherGroup, onChoose }: { invite: Invite; replacingOtherGroup: boolean; onChoose: (c: JoinChoice) => void }) {
  const [memberId, setMemberId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState<Color>(COLORS[1]);
  const [deviceName, setDeviceName] = useState(guessDeviceName());
  const valid = deviceName.trim() && (memberId || name.trim());
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        onChoose({ deviceName: deviceName.trim(), memberId, newMember: memberId ? null : { name: name.trim(), color } });
      }}
    >
      <h2>「{invite.groupName}」に参加します</h2>
      {replacingOtherGroup && <p className="notice warn">この端末にある別のグループのデータは削除され、「{invite.groupName}」のデータに置き換わります。</p>}
      <Field label="この端末を使うのは誰ですか？" group>
        <div className="chips" role="radiogroup">
          {invite.members.map((m) => (
            <button key={m.id} type="button" className="chip" aria-pressed={memberId === m.id} onClick={() => setMemberId(m.id)}>
              <Avatar member={m} size="sm" />
              {m.name}
            </button>
          ))}
          <button type="button" className="chip" aria-pressed={memberId === null} onClick={() => setMemberId(null)}>
            <Icon name="plus" />
            新しいメンバー
          </button>
        </div>
      </Field>
      {memberId === null && (
        <>
          <Field label="あなたの名前">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={50} placeholder="例: パパ" />
          </Field>
          <Field label="あなたの色" group>
            <ColorPicker value={color} onChange={setColor} />
          </Field>
        </>
      )}
      <Field label="この端末の名前">
        <input className="input" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} maxLength={50} />
      </Field>
      <button className="btn primary block" type="submit" disabled={!valid}>
        参加する
      </button>
    </form>
  );
}

/** ルーティング用ラッパー */
export function Connect({ mode, role }: { mode: Mode; role: Role }) {
  const { db, session, reload } = useApp();
  return (
    <ConnectFlow
      key={`${mode}-${role}`}
      db={db}
      session={session}
      mode={mode}
      role={role}
      onExit={() => goBack('/sync')}
      onFinished={async () => {
        navigate(mode === 'pair' ? '/members' : '/', { replace: true });
        await reload();
      }}
    />
  );
}

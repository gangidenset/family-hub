import { useLiveQuery } from 'dexie-react-hooks';
import { useRef, useState } from 'react';
import { useApp } from '../../app/context';
import { Link, navigate, useRoute } from '../../app/router';
import { useSyncSummary } from '../../app/hooks';
import { Icon } from '../../components/Icon';
import { PageHeader, useFeedback } from '../../components/ui';
import { latestKey, listActive } from '../../db/repo';
import { exportSyncFile, importSyncFile, MAX_SYNC_FILE_BYTES } from '../../sync/file';
import { SyncError } from '../../sync/protocol';
import { readFileText, saveFile, stamp } from '../../lib/file';
import { relativeTime } from '../../lib/date';
import { SYNC_ERROR_TEXT } from './Connect';

export function SyncHub() {
  const { db, session } = useApp();
  const { query } = useRoute();
  const summary = useSyncSummary();
  const { toast } = useFeedback();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [fileMsg, setFileMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const data = useLiveQuery(async () => {
    const devices = await listActive(db, session.groupId, 'devices');
    const peers = await db.peers.where('[groupId+deviceId]').between([session.groupId, ''], [session.groupId, '￿']).toArray();
    const hasKey = !!(await latestKey(db, session.groupId));
    return { devices, peers, hasKey };
  }, [db, session.groupId]);

  const others = (data?.devices ?? []).filter((d) => d.id !== session.deviceId && !d.revoked);

  const exportFile = async () => {
    setBusy(true);
    try {
      const { text, count } = await exportSyncFile(db, session);
      const r = await saveFile(`familyhub-${stamp()}.fhsync`, text, { share: true });
      setFileMsg({ ok: true, text: `${count} 件の変更を暗号化して${r === 'shared' ? '共有' : '保存'}しました。家族の端末で「ファイルを取り込む」から読み込んでください。` });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setFileMsg({ ok: false, text: e instanceof SyncError ? SYNC_ERROR_TEXT[e.code] : '書き出せませんでした' });
    } finally {
      setBusy(false);
    }
  };

  const importFile = async (file: File) => {
    setBusy(true);
    try {
      const r = await importSyncFile(db, session, await readFileText(file, MAX_SYNC_FILE_BYTES));
      setFileMsg({ ok: true, text: r.applied ? `${r.applied} 件の変更を取り込みました${r.conflicts ? ` (競合 ${r.conflicts} 件)` : ''}。` : '新しい変更はありませんでした。' });
      toast('取り込みました');
    } catch (e) {
      setFileMsg({ ok: false, text: e instanceof SyncError ? SYNC_ERROR_TEXT[e.code] : 'このファイルは読み込めません。FamilyHub の同期ファイル (.fhsync) を選んでください。' });
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  return (
    <>
      <PageHeader title="同期" back="/" />
      <main className="main no-tabs">
        {data && !data.hasKey && (
          <div className="notice warn" style={{ marginBottom: 16 }}>
            <Icon name="lock" />
            <span>
              この端末には同期用の鍵がありません (鍵を含まないバックアップから復元した場合など)。家族の端末で「端末を追加」を開き、
              <Link to="/connect/pair/guest">この端末から参加し直してください</Link>。データは保持されます。
            </span>
          </div>
        )}
        <div className="card">
          <p style={{ margin: 0 }}>
            {summary?.pending ? (
              <strong>まだ家族に送っていない変更が {summary.pending} 件あります</strong>
            ) : summary?.lastSyncAt ? (
              <strong>同期済み</strong>
            ) : (
              <strong>まだ同期していません</strong>
            )}
          </p>
          {summary?.lastSyncAt && (
            <p className="muted" style={{ margin: 0 }}>
              最後の同期: {relativeTime(summary.lastSyncAt)}
              {summary.lastPeerName && ` (${summary.lastPeerName})`}
            </p>
          )}
        </div>

        <h2 className="section-title">同じ Wi-Fi の家族の端末と同期</h2>
        {others.length === 0 ? (
          <div className="card stack">
            <p style={{ margin: 0 }}>同期する家族の端末がまだありません。</p>
            <Link className="btn primary" to="/members">
              <Icon name="users" />
              家族の端末を追加する
            </Link>
          </div>
        ) : (
          <div className="card stack">
            <p className="muted" style={{ margin: 0 }}>
              両方の端末で FamilyHub を開き、片方で「QR を表示」、もう片方で「QR を読み取る」を選びます。最後に読み取り側の QR を表示側で読み取ると同期が始まります。
            </p>
            <div className="btn-row">
              <button className="btn primary" onClick={() => navigate('/connect/sync/host')}>
                <Icon name="qr" />
                QR を表示
              </button>
              <button className="btn primary" onClick={() => navigate('/connect/sync/guest')}>
                <Icon name="camera" />
                QR を読み取る
              </button>
            </div>
          </div>
        )}

        <h2 className="section-title">ファイルで同期 (Wi-Fi で接続できないとき)</h2>
        <div className="card stack">
          <p className="muted" style={{ margin: 0 }}>
            変更を家族の鍵で暗号化したファイルにして、AirDrop・Quick Share・メッセージアプリなどで送ります。中身は家族の端末でしか読めません。
          </p>
          {fileMsg && <p className={`notice ${fileMsg.ok ? '' : 'danger'}`}>{fileMsg.text}</p>}
          <div className="btn-row">
            <button className="btn" onClick={() => void exportFile()} disabled={busy || !data?.hasKey}>
              <Icon name="upload" />
              ファイルを送る
            </button>
            <button className="btn" onClick={() => fileInput.current?.click()} disabled={busy}>
              <Icon name="download" />
              ファイルを取り込む
            </button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".fhsync,application/json"
            hidden
            data-testid="sync-file-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importFile(f);
            }}
          />
          {query.get('file') && <p className="small muted">Wi-Fi で接続できなかった場合は、こちらをお使いください。</p>}
        </div>

        {(data?.peers.length ?? 0) > 0 && (
          <>
            <h2 className="section-title">同期の履歴</h2>
            <ul className="list">
              {data!.peers
                .slice()
                .sort((a, b) => (a.lastAttemptAt < b.lastAttemptAt ? 1 : -1))
                .map((p) => {
                  const d = data!.devices.find((x) => x.id === p.deviceId);
                  return (
                    <li className="row row-pad" key={p.deviceId}>
                      <div className="row-main static">
                        <div className="row-title">{d?.name ?? '不明な端末'}</div>
                        <div className="row-sub">
                          {p.lastResult === 'ok' ? `成功 ${relativeTime(p.lastAttemptAt)}` : `失敗 ${relativeTime(p.lastAttemptAt)}: ${p.lastError ? SYNC_ERROR_TEXT[p.lastError].split('。')[0] : ''}`}
                          {p.via === 'file' && ' (ファイル)'}
                        </div>
                      </div>
                      <span className={`badge ${p.lastResult === 'ok' ? 'primary' : 'warn'}`}>{p.lastResult === 'ok' ? '成功' : '失敗'}</span>
                    </li>
                  );
                })}
            </ul>
          </>
        )}
        <p className="small muted" style={{ marginTop: 24 }}>
          通信は端末同士の直接接続のみで、外部のサーバーは使いません。通信内容は暗号化されます。アプリを閉じている間は同期されません。
        </p>
      </main>
    </>
  );
}

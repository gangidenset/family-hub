import { useState } from 'react';
import { useApp } from '../../app/context';
import { useActive } from '../../app/hooks';
import { navigate } from '../../app/router';
import { Icon } from '../../components/Icon';
import { Field, PageHeader, Switch, useFeedback } from '../../components/ui';
import { exportBackup } from '../../backup/backup';
import { RestoreSection } from './RestoreSection';
import { updateSettings } from '../../db/repo';
import { wipeAll } from '../../db/group';
import { saveFile, stamp } from '../../lib/file';

export function BackupPage() {
  const { db, session, reload } = useApp();
  const groups = useActive('groups');
  const groupName = groups?.[0]?.name ?? '';
  const { confirm, toast } = useFeedback();

  const [encrypt, setEncrypt] = useState(true);
  const [pass1, setPass1] = useState('');
  const [pass2, setPass2] = useState('');
  const [exportError, setExportError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);


  const [wipeText, setWipeText] = useState('');

  const doExport = async () => {
    setExportError(null);
    if (encrypt) {
      if (pass1.length < 8) return setExportError('パスフレーズは 8 文字以上にしてください');
      if (pass1 !== pass2) return setExportError('パスフレーズが一致しません');
    }
    setBusy(true);
    try {
      const text = await exportBackup(db, session.groupId, session.memberId, encrypt ? pass1 : undefined);
      await saveFile(`familyhub-backup-${stamp()}${encrypt ? '-encrypted' : ''}.fhbackup.json`, text, { share: true });
      await updateSettings(db, { lastBackupAt: new Date().toISOString() });
      toast('バックアップを書き出しました');
      setPass1('');
      setPass2('');
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setExportError('書き出せませんでした');
    } finally {
      setBusy(false);
    }
  };

  const doWipe = async () => {
    const ok = await confirm({
      title: '本当にすべて削除しますか？',
      message: 'この端末の FamilyHub のデータをすべて削除します。元に戻せません。家族の端末のデータは削除されません。',
      confirmLabel: 'すべて削除',
      danger: true,
    });
    if (!ok) return;
    await wipeAll(db);
    navigate('/', { replace: true });
    window.location.reload();
  };

  return (
    <>
      <PageHeader title="バックアップと復元" back="/settings" />
      <main className="main no-tabs">
        <h2 className="section-title">バックアップを書き出す</h2>
        <div className="card stack">
          <p className="muted" style={{ margin: 0 }}>
            家族のデータをファイルに保存します。機種変更や、すべての端末を失ったときの備えになります。ファイルは端末内で作られ、どこにも自動送信されません。
          </p>
          <Switch label="パスフレーズで暗号化する (おすすめ)" checked={encrypt} onChange={setEncrypt} />
          {encrypt ? (
            <>
              <Field label="パスフレーズ (8 文字以上)">
                <input className="input" type="password" value={pass1} onChange={(e) => setPass1(e.target.value)} autoComplete="new-password" />
              </Field>
              <Field label="パスフレーズ (確認)">
                <input className="input" type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" />
              </Field>
              <p className="small muted" style={{ margin: 0 }}>
                暗号化したバックアップには同期用の鍵も含まれ、復元後すぐに家族と同期できます。パスフレーズを忘れると復元できません。
              </p>
            </>
          ) : (
            <p className="notice warn small">
              暗号化しないバックアップは、ファイルを開けば誰でも内容を読めます。保管場所に注意してください。同期用の鍵は含まれないため、復元後に家族の端末と再ペアリングが必要です。
            </p>
          )}
          {exportError && <p className="error-text">{exportError}</p>}
          <button className="btn primary" onClick={() => void doExport()} disabled={busy}>
            <Icon name="download" />
            書き出す
          </button>
        </div>

        <h2 className="section-title">バックアップから復元</h2>
        <RestoreSection
          db={db}
          currentGroupId={session.groupId}
          currentGroupName={groupName}
          onRestored={async () => {
            toast('復元しました');
            navigate('/', { replace: true });
            await reload();
          }}
        />

        <h2 className="section-title">データの全削除</h2>
        <div className="card stack">
          <p className="muted" style={{ margin: 0 }}>
            この端末から FamilyHub のデータ (家族の共有データ・同期用の鍵・設定) をすべて削除します。端末を手放すときなどに使います。
          </p>
          <Field label={`確認のため、グループ名「${groupName}」を入力してください`}>
            <input className="input" value={wipeText} onChange={(e) => setWipeText(e.target.value)} />
          </Field>
          <button className="btn danger" disabled={wipeText !== groupName || !groupName} onClick={() => void doWipe()}>
            <Icon name="trash" />
            すべて削除する
          </button>
        </div>
      </main>
    </>
  );
}

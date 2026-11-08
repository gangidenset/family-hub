import { useRef, useState } from 'react';
import { useApp } from '../../app/context';
import { useActive } from '../../app/hooks';
import { navigate } from '../../app/router';
import { Icon } from '../../components/Icon';
import { Field, PageHeader, Switch, useFeedback } from '../../components/ui';
import { BackupError, exportBackup, MAX_BACKUP_BYTES, parseBackup, restoreBackup, type BackupErrorCode, type ParsedBackup } from '../../backup/backup';
import { updateSettings } from '../../db/repo';
import { wipeAll } from '../../db/group';
import { readFileText, saveFile, stamp } from '../../lib/file';
import { formatDate, isoToLocalDate, isoToLocalTime } from '../../lib/date';

const ERROR_TEXT: Record<BackupErrorCode, string> = {
  'too-large': 'ファイルが大きすぎます (50MB まで)。',
  'not-json': 'このファイルは読み込めません。FamilyHub のバックアップファイルを選んでください。',
  'not-backup': 'FamilyHub のバックアップファイルではないか、内容が壊れています。',
  'newer-version': 'より新しいバージョンのアプリで作られたバックアップです。アプリを更新してから復元してください。',
  checksum: 'ファイルが壊れているか、書き換えられています。復元を中止しました。',
  'invalid-record': 'ファイルに正しくないデータが含まれているため、復元を中止しました。',
  'needs-passphrase': 'パスフレーズで保護されたバックアップです。パスフレーズを入力してください。',
  'wrong-passphrase': 'パスフレーズが違います。',
};

const LABELS: Record<string, string> = {
  members: 'メンバー',
  shoppingItems: '買い物の商品',
  purchases: '購入履歴',
  memos: 'メモ',
  events: '予定',
  tasks: 'タスク',
};

export function BackupPage() {
  const { db, session, reload } = useApp();
  const groups = useActive('groups');
  const groupName = groups?.[0]?.name ?? '';
  const { confirm, toast } = useFeedback();
  const fileInput = useRef<HTMLInputElement>(null);

  const [encrypt, setEncrypt] = useState(true);
  const [pass1, setPass1] = useState('');
  const [pass2, setPass2] = useState('');
  const [exportError, setExportError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [fileText, setFileText] = useState<string | null>(null);
  const [needsPass, setNeedsPass] = useState(false);
  const [restorePass, setRestorePass] = useState('');
  const [preview, setPreview] = useState<ParsedBackup | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

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

  const check = async (text: string, pass?: string) => {
    setRestoreError(null);
    setPreview(null);
    setBusy(true);
    try {
      setPreview(await parseBackup(text, pass));
      setNeedsPass(false);
    } catch (e) {
      const code = e instanceof BackupError ? e.code : 'not-backup';
      if (code === 'needs-passphrase' || code === 'wrong-passphrase') setNeedsPass(true);
      setRestoreError(ERROR_TEXT[code]);
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File) => {
    setRestorePass('');
    try {
      const text = await readFileText(file, MAX_BACKUP_BYTES);
      setFileText(text);
      await check(text);
    } catch {
      setRestoreError(ERROR_TEXT['too-large']);
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const doRestore = async () => {
    if (!preview) return;
    const ok = await confirm({
      title: 'このバックアップで復元しますか？',
      message: `この端末の「${groupName}」のデータは、バックアップ (${formatDate(isoToLocalDate(preview.exportedAt), { year: true })} ${isoToLocalTime(preview.exportedAt)} 作成) の内容に置き換わります。\n\nバックアップ後に家族が追加した変更は、次回の同期で家族の端末から戻ってきます。`,
      confirmLabel: '復元する',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await restoreBackup(db, preview, session.groupId);
      toast('復元しました');
      navigate('/', { replace: true });
      await reload();
    } catch {
      setRestoreError('復元に失敗しました。端末内のデータは変更されていない可能性があります。');
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
        <div className="card stack">
          <button className="btn" onClick={() => fileInput.current?.click()} disabled={busy}>
            <Icon name="upload" />
            ファイルを選ぶ
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            hidden
            data-testid="backup-file-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
          />
          {restoreError && (
            <div className="notice danger" role="alert">
              <Icon name="alert" />
              <span>{restoreError}</span>
            </div>
          )}
          {needsPass && fileText && (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                void check(fileText, restorePass);
              }}
            >
              <Field label="パスフレーズ">
                <input className="input" type="password" value={restorePass} onChange={(e) => setRestorePass(e.target.value)} autoComplete="current-password" />
              </Field>
              <button className="btn" type="submit" disabled={busy}>
                開く
              </button>
            </form>
          )}
          {preview && (
            <div className="stack" data-testid="restore-preview">
              <div className="notice">
                <Icon name="info" />
                <div>
                  <strong>「{preview.groupName}」のバックアップ</strong>
                  <div className="small">
                    作成: {formatDate(isoToLocalDate(preview.exportedAt), { year: true })} {isoToLocalTime(preview.exportedAt)} ・ アプリ {preview.appVersion}
                  </div>
                  <div className="small">
                    {Object.entries(LABELS)
                      .map(([k, l]) => `${l} ${preview.counts[k as keyof typeof preview.counts]}`)
                      .join(' ・ ')}
                  </div>
                  <div className="small">{preview.keys ? '同期用の鍵: 含む' : '同期用の鍵: 含まない (復元後に再ペアリングが必要)'}</div>
                </div>
              </div>
              {preview.warnings.map((w) => (
                <p key={w} className="notice warn small">
                  {w}
                </p>
              ))}
              <button className="btn primary" onClick={() => void doRestore()} disabled={busy}>
                この内容で復元する
              </button>
            </div>
          )}
        </div>

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

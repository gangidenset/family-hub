import { useRef, useState } from 'react';
import { BackupError, MAX_BACKUP_BYTES, parseBackup, restoreBackup, type BackupErrorCode, type ParsedBackup } from '../../backup/backup';
import type { FamilyDB } from '../../db/db';
import { Icon } from '../../components/Icon';
import { Field, useFeedback } from '../../components/ui';
import { readFileText } from '../../lib/file';
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

/** バックアップファイルの選択 → 検証 → プレビュー → 確認 → 復元 */
export function RestoreSection({
  db,
  currentGroupId,
  currentGroupName,
  onRestored,
}: {
  db: FamilyDB;
  currentGroupId: string | null;
  currentGroupName: string | null;
  onRestored: () => Promise<void>;
}) {
  const { confirm } = useFeedback();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [fileText, setFileText] = useState<string | null>(null);
  const [needsPass, setNeedsPass] = useState(false);
  const [pass, setPass] = useState('');
  const [preview, setPreview] = useState<ParsedBackup | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = async (text: string, passphrase?: string) => {
    setError(null);
    setPreview(null);
    setBusy(true);
    try {
      setPreview(await parseBackup(text, passphrase));
      setNeedsPass(false);
    } catch (e) {
      const code = e instanceof BackupError ? e.code : 'not-backup';
      if (code === 'needs-passphrase' || code === 'wrong-passphrase') setNeedsPass(true);
      setError(ERROR_TEXT[code]);
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File) => {
    setPass('');
    try {
      const text = await readFileText(file, MAX_BACKUP_BYTES);
      setFileText(text);
      await check(text);
    } catch {
      setError(ERROR_TEXT['too-large']);
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const doRestore = async () => {
    if (!preview) return;
    const created = `${formatDate(isoToLocalDate(preview.exportedAt), { year: true })} ${isoToLocalTime(preview.exportedAt)}`;
    const ok = await confirm({
      title: 'このバックアップで復元しますか？',
      message: currentGroupId
        ? `この端末の「${currentGroupName ?? ''}」のデータは、バックアップ (${created} 作成) の内容に置き換わります。\n\nバックアップ後に家族が追加した変更は、次回の同期で家族の端末から戻ってきます。`
        : `「${preview.groupName}」のバックアップ (${created} 作成) を復元します。`,
      confirmLabel: '復元する',
      danger: !!currentGroupId,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await restoreBackup(db, preview, currentGroupId);
      await onRestored();
    } catch {
      setError('復元に失敗しました。もう一度お試しください。');
      setBusy(false);
    }
  };

  return (
    <div className="card stack">
      <button className="btn" onClick={() => fileInput.current?.click()} disabled={busy}>
        <Icon name="upload" />
        バックアップファイルを選ぶ
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
      {error && (
        <div className="notice danger" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </div>
      )}
      {needsPass && fileText && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void check(fileText, pass);
          }}
        >
          <Field label="パスフレーズ">
            <input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" />
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
              <div className="small">{preview.keys ? '同期用の鍵: 含む' : '同期用の鍵: 含まない (復元後に家族の端末と再ペアリングが必要)'}</div>
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
  );
}

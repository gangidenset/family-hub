import { useEffect, useState } from 'react';
import { useApp } from '../../app/context';
import { useActive, useSettings } from '../../app/hooks';
import { Link } from '../../app/router';
import { Icon, type IconName } from '../../components/Icon';
import { errorMessage, Field, PageHeader, Sheet } from '../../components/ui';
import { update, updateSettings } from '../../db/repo';
import { APP_VERSION } from '../../backup/backup';
import { LIMITS } from '../../domain/schemas';
import type { FontScale, ThemeSetting } from '../../db/db';
import { relativeTime } from '../../lib/date';

function NavRow({ to, icon, label, sub }: { to: string; icon: IconName; label: string; sub?: string }) {
  return (
    <Link to={to} className="settings-link">
      <Icon name={icon} />
      <span>
        {label}
        {sub && (
          <>
            <br />
            <small className="muted">{sub}</small>
          </>
        )}
      </span>
      <Icon name="chevron" />
    </Link>
  );
}

export function Settings() {
  const { db, session } = useApp();
  const settings = useSettings();
  const groups = useActive('groups');
  const group = groups?.[0];
  const [renaming, setRenaming] = useState(false);
  const [usage, setUsage] = useState<string | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);

  useEffect(() => {
    void navigator.storage?.estimate?.().then((e) => e.usage !== undefined && setUsage(`${(e.usage / 1024 / 1024).toFixed(1)} MB`));
    void navigator.storage?.persisted?.().then(setPersisted);
  }, []);

  const themes: [ThemeSetting, string][] = [
    ['system', '自動'],
    ['light', 'ライト'],
    ['dark', 'ダーク'],
  ];
  const fonts: [FontScale, string][] = [
    ['normal', '標準'],
    ['large', '大'],
    ['xlarge', '特大'],
  ];

  return (
    <>
      <PageHeader title="設定" back="/" />
      <main className="main no-tabs">
        <h2 className="section-title">家族</h2>
        <div className="list">
          <button className="settings-link" onClick={() => setRenaming(true)}>
            <Icon name="home" />
            <span>
              グループ名
              <br />
              <small className="muted">{group?.name}</small>
            </span>
            <Icon name="edit" />
          </button>
          <NavRow to="/members" icon="users" label="家族メンバーと端末" sub="端末の追加・メンバーの管理" />
          <NavRow to="/sync" icon="sync" label="同期" sub="QR コード / ファイルで同期" />
        </div>

        <h2 className="section-title">データ</h2>
        <div className="list">
          <NavRow
            to="/settings/backup"
            icon="download"
            label="バックアップ・復元・削除"
            sub={settings?.lastBackupAt ? `最後のバックアップ: ${relativeTime(settings.lastBackupAt)}` : 'まだバックアップしていません'}
          />
          <NavRow to="/settings/categories" icon="tag" label="カテゴリー" sub="買い物・メモ・予定・タスクの分類" />
        </div>

        <h2 className="section-title">表示</h2>
        <div className="card stack">
          <Field label="テーマ" group>
            <div className="chips">
              {themes.map(([v, l]) => (
                <button key={v} className="chip" aria-pressed={settings?.theme === v} onClick={() => void updateSettings(db, { theme: v })}>
                  {l}
                </button>
              ))}
            </div>
          </Field>
          <Field label="文字の大きさ" group>
            <div className="chips">
              {fonts.map(([v, l]) => (
                <button key={v} className="chip" aria-pressed={settings?.fontScale === v} onClick={() => void updateSettings(db, { fontScale: v })}>
                  {l}
                </button>
              ))}
            </div>
          </Field>
        </div>

        <h2 className="section-title">このアプリについて</h2>
        <div className="list">
          <NavRow to="/legal/privacy" icon="shield" label="プライバシーポリシー" />
          <NavRow to="/legal/terms" icon="file" label="利用規約" />
        </div>
        <div className="card" style={{ marginTop: 16 }}>
          <p className="small muted" style={{ margin: 0 }}>
            FamilyHub {APP_VERSION}
            <br />
            端末内の使用容量: {usage ?? '不明'}
            {persisted !== null && ` ・ 自動削除からの保護: ${persisted ? '有効' : '未許可 (ホーム画面に追加すると有効になりやすくなります)'}`}
            <br />
            データはこの端末と家族の端末にのみ保存されます。広告・解析・外部サーバーへの送信はありません。
            <br />
            使用しているオープンソース: React, Dexie.js, zod, qrcode, jsQR, Workbox (いずれも MIT / Apache-2.0 ライセンス)
          </p>
        </div>
      </main>
      {renaming && group && (
        <RenameGroup
          name={group.name}
          onSave={async (name) => {
            await update(db, session, 'groups', group.id, { name });
            setRenaming(false);
          }}
          onClose={() => setRenaming(false)}
        />
      )}
    </>
  );
}

function RenameGroup({ name, onSave, onClose }: { name: string; onSave: (n: string) => Promise<void>; onClose: () => void }) {
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet title="グループ名" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!value.trim()) return setError('入力してください');
          onSave(value.trim()).catch((err) => setError(errorMessage(err)));
        }}
      >
        <Field label="グループ名" error={error}>
          <input className="input" value={value} onChange={(e) => setValue(e.target.value)} maxLength={LIMITS.name} />
        </Field>
        <button className="btn primary block" type="submit">
          保存
        </button>
      </form>
    </Sheet>
  );
}

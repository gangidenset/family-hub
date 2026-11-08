import { useState } from 'react';
import { useApp } from '../../app/context';
import { useActive, useMembers } from '../../app/hooks';
import { navigate } from '../../app/router';
import { Icon } from '../../components/Icon';
import { Avatar, ColorPicker, errorMessage, Field, PageHeader, Sheet, useFeedback } from '../../components/ui';
import { LIMITS, type Color, type Device, type Member } from '../../domain/schemas';
import { create, rotateKey, softDelete, update } from '../../db/repo';
import { relativeTime } from '../../lib/date';
import { useLiveQuery } from 'dexie-react-hooks';

export function Members() {
  const { db, session } = useApp();
  const members = useMembers();
  const devices = useActive('devices') ?? [];
  const { confirm, toast } = useFeedback();
  const [editing, setEditing] = useState<Member | 'new' | null>(null);
  const peers = useLiveQuery(() => db.peers.where('[groupId+deviceId]').between([session.groupId, ''], [session.groupId, '￿']).toArray(), [db, session.groupId]);

  const revoke = async (d: Device) => {
    const ok = await confirm({
      title: `「${d.name}」を家族から外す`,
      message:
        'この端末は今後、家族の端末と同期できなくなります。\n\n注意: すでにこの端末に保存されているデータは消えません (端末を手元で操作できる場合は、その端末の「設定 → データを全削除」で消去してください)。',
      confirmLabel: '外す',
      danger: true,
    });
    if (!ok) return;
    await update(db, session, 'devices', d.id, { revoked: true });
    await rotateKey(db, session.groupId); // 以降の同期・同期ファイルは新しい鍵で保護
    toast('端末を外しました。他の家族の端末にも次回の同期で反映されます');
  };

  const sorted = members.slice().sort((a, b) => (a.id === session.memberId ? -1 : b.id === session.memberId ? 1 : a.createdAt < b.createdAt ? -1 : 1));

  return (
    <>
      <PageHeader title="家族メンバー" back="/settings" />
      <main className="main no-tabs">
        <div className="card stack">
          <p style={{ margin: 0 }}>
            <strong>家族のスマホをつなぐ</strong>
          </p>
          <p className="muted" style={{ margin: 0 }}>
            新しい端末で FamilyHub を開いて「家族のグループに参加する」を選び、この端末で表示する QR コードを読み取ってもらいます。両方の端末が同じ Wi-Fi につながっている必要があります。
          </p>
          <button className="btn primary" onClick={() => navigate('/connect/pair/host')}>
            <Icon name="qr" />
            端末を追加
          </button>
        </div>

        <h2 className="section-title">
          メンバー ({members.length})
          <button onClick={() => setEditing('new')}>＋ メンバーを追加</button>
        </h2>
        <ul className="list">
          {sorted.map((m) => {
            const mine = devices.filter((d) => d.memberId === m.id);
            return (
              <li key={m.id} style={{ borderBottom: '1px solid var(--line)' }}>
                <div className="row" style={{ borderBottom: 0 }}>
                  <span style={{ padding: '0 8px' }}>
                    <Avatar member={m} size="lg" />
                  </span>
                  <button className="row-main" onClick={() => setEditing(m)}>
                    <div className="row-title">
                      {m.name}
                      {m.id === session.memberId && <span className="badge primary" style={{ marginLeft: 8 }}>あなた</span>}
                    </div>
                    <div className="row-sub">{m.role === 'child' ? '子ども' : '大人'} ・ 端末 {mine.filter((d) => !d.revoked).length} 台</div>
                  </button>
                  <Icon name="chevron" />
                </div>
                {mine.length > 0 && (
                  <ul style={{ listStyle: 'none', margin: 0, padding: '0 8px 8px 64px' }}>
                    {mine.map((d) => {
                      const p = peers?.find((x) => x.deviceId === d.id);
                      return (
                        <li key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44 }}>
                          <span style={{ flex: 1, minWidth: 0 }} className="small">
                            {d.name}
                            {d.id === session.deviceId ? ' (この端末)' : ''}
                            {d.revoked ? <span className="badge warn" style={{ marginLeft: 6 }}>外した端末</span> : p?.lastSyncAt ? <span className="muted"> ・ {relativeTime(p.lastSyncAt)}に同期</span> : null}
                          </span>
                          {d.id !== session.deviceId && !d.revoked && (
                            <button className="btn small ghost" onClick={() => void revoke(d)}>
                              外す
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        <p className="small muted" style={{ marginTop: 16 }}>
          端末を持たない小さなお子さんも、メンバーとして登録すればタスクの担当や予定の参加者に設定できます。
        </p>
      </main>
      {editing && (
        <MemberSheet
          member={editing === 'new' ? null : editing}
          isSelf={editing !== 'new' && editing.id === session.memberId}
          devices={editing === 'new' ? [] : devices.filter((d) => d.memberId === editing.id && !d.revoked)}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function MemberSheet({ member, isSelf, devices, onClose }: { member: Member | null; isSelf: boolean; devices: Device[]; onClose: () => void }) {
  const { db, session } = useApp();
  const { confirm, toast } = useFeedback();
  const [name, setName] = useState(member?.name ?? '');
  const [color, setColor] = useState<Color>(member?.color ?? 'orange');
  const [role, setRole] = useState<Member['role']>(member?.role ?? 'adult');
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) return setError('名前を入力してください');
    try {
      if (member) await update(db, session, 'members', member.id, { name: name.trim(), color, role });
      else await create(db, session, 'members', { name: name.trim(), color, role });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const remove = async () => {
    if (!member) return;
    const ok = await confirm({
      title: `${member.name}さんを削除`,
      message: devices.length ? `${member.name}さんの端末 ${devices.length} 台も家族から外れ、今後は同期できなくなります。すでに端末にあるデータは消えません。` : '担当になっているタスクは「未定」として残ります。',
      confirmLabel: '削除',
      danger: true,
    });
    if (!ok) return;
    for (const d of devices) await update(db, session, 'devices', d.id, { revoked: true });
    if (devices.length) await rotateKey(db, session.groupId);
    await softDelete(db, session, 'members', member.id);
    toast(`${member.name}さんを削除しました`);
    onClose();
  };

  return (
    <Sheet title={member ? 'メンバーを編集' : 'メンバーを追加'} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="名前" error={error}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.name} placeholder="例: はなこ" />
        </Field>
        <Field label="色" group>
          <ColorPicker value={color} onChange={setColor} />
        </Field>
        <Field label="区分" group>
          <div className="chips">
            <button type="button" className="chip" aria-pressed={role === 'adult'} onClick={() => setRole('adult')}>
              大人
            </button>
            <button type="button" className="chip" aria-pressed={role === 'child'} onClick={() => setRole('child')}>
              子ども
            </button>
          </div>
        </Field>
        <button className="btn primary block" type="submit">
          保存
        </button>
        {member && !isSelf && (
          <button className="btn danger block" type="button" onClick={() => void remove()}>
            <Icon name="trash" />
            このメンバーを削除
          </button>
        )}
      </form>
    </Sheet>
  );
}

import { useState } from 'react';
import { useActive, useCategories, useMemberMap } from '../../app/hooks';
import { Link, navigate } from '../../app/router';
import { MainHeader } from '../../app/Shell';
import { Icon } from '../../components/Icon';
import { colorVar, EmptyState, Fab } from '../../components/ui';
import { relativeTime } from '../../lib/date';
import { useApp } from '../../app/context';
import { useLiveQuery } from 'dexie-react-hooks';

export function Memos() {
  const { db, session } = useApp();
  const memos = useActive('memos');
  const categories = useCategories('memo');
  const members = useMemberMap();
  const [filter, setFilter] = useState<string | null>(null);
  const conflicted = useLiveQuery(async () => new Set((await db.conflicts.filter((c) => c.groupId === session.groupId && !c.resolved).toArray()).map((c) => c.recordId)), [db, session.groupId]);

  const visible = (memos ?? [])
    .filter((m) => !filter || m.categoryId === filter)
    .sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : a.updatedAt < b.updatedAt ? 1 : -1));
  const catMap = new Map(categories.map((c) => [c.id, c]));

  if (memos === undefined) return <MainHeader title="" />;

  return (
    <>
      <MainHeader title="共有メモ" />
      <main className="main">
        <div className="chips" role="group" aria-label="カテゴリーで絞り込み">
          <button className="chip" aria-pressed={filter === null} onClick={() => setFilter(null)}>
            すべて
          </button>
          {categories.map((c) => (
            <button key={c.id} className="chip" aria-pressed={filter === c.id} onClick={() => setFilter(c.id)}>
              <span className="dot" style={{ background: colorVar(c.color) }} />
              {c.name}
            </button>
          ))}
        </div>
        {visible.length === 0 ? (
          <EmptyState icon="memo" title="メモはありません" hint="学校の持ち物、Wi-Fi のパスワード、家のルールなどを家族で共有できます" />
        ) : (
          <ul className="list">
            {visible.map((m) => {
              const cat = m.categoryId ? catMap.get(m.categoryId) : undefined;
              return (
                <li className="row row-pad" key={m.id}>
                  <Link to={`/memos/${m.id}`} className="row-main">
                    <div className="row-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {m.pinned && (
                        <span style={{ width: 18, color: 'var(--primary)', display: 'inline-flex' }} aria-label="ピン留め">
                          <Icon name="pin" />
                        </span>
                      )}
                      {m.title || '無題のメモ'}
                    </div>
                    <div className="row-sub">{m.body.split('\n').filter(Boolean).slice(0, 2).join(' / ') || '本文なし'}</div>
                    <div className="row-sub" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 2, flexWrap: 'wrap' }}>
                      {cat && (
                        <span className="badge">
                          <span className="dot" style={{ background: colorVar(cat.color), width: 8, height: 8 }} />
                          {cat.name}
                        </span>
                      )}
                      {conflicted?.has(m.id) && <span className="badge warn">競合あり</span>}
                      <span>
                        {relativeTime(m.updatedAt)}・{members.get(m.updatedBy)?.name ?? ''}
                      </span>
                    </div>
                  </Link>
                  <Icon name="chevron" />
                </li>
              );
            })}
          </ul>
        )}
      </main>
      <Fab label="メモ" onClick={() => navigate('/memos/new')} />
    </>
  );
}

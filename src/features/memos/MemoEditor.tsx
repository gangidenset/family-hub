import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../app/context';
import { useCategories, useMemberMap } from '../../app/hooks';
import { goBack, navigate } from '../../app/router';
import { Icon } from '../../components/Icon';
import { PageHeader, useFeedback } from '../../components/ui';
import { LIMITS, type Memo } from '../../domain/schemas';
import { create, restoreDeleted, softDelete, update } from '../../db/repo';
import { relativeTime } from '../../lib/date';

const SAVE_DELAY = 800;

export function MemoEditor({ id }: { id: string }) {
  const { db, session } = useApp();
  const categories = useCategories('memo');
  const members = useMemberMap();
  const { confirm, toast } = useFeedback();
  const isNew = id === 'new';
  const memo = useLiveQuery(async () => (isNew ? null : ((await db.memos.get(id)) ?? null)), [db, id, isNew]);
  const conflicts = useLiveQuery(
    () => (isNew ? [] : db.conflicts.where('[groupId+table+recordId]').equals([session.groupId, 'memos', id]).filter((c) => !c.resolved).toArray()),
    [db, id, isNew, session.groupId],
  );

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const dirty = useRef(false);
  const loaded = useRef(false);
  const memoId = useRef<string | null>(isNew ? null : id);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef({ title, body });
  latest.current = { title, body };

  // 読み込み時、および編集していない間に他の家族の変更が届いたら反映
  useEffect(() => {
    if (!memo || dirty.current) return;
    if (!loaded.current || memo.title !== latest.current.title || memo.body !== latest.current.body) {
      setTitle(memo.title);
      setBody(memo.body);
      loaded.current = true;
    }
  }, [memo]);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (!dirty.current) return;
    const { title: t, body: b } = latest.current;
    dirty.current = false;
    setStatus('saving');
    try {
      if (!memoId.current) {
        if (!t.trim() && !b.trim()) return setStatus('idle');
        memoId.current = await create(db, session, 'memos', { title: t, body: b, categoryId: null, pinned: false });
        navigate(`/memos/${memoId.current}`, { replace: true });
      } else {
        await update(db, session, 'memos', memoId.current, { title: t, body: b });
      }
      setStatus('saved');
    } catch {
      dirty.current = true;
      setStatus('error');
    }
  }, [db, session]);

  useEffect(() => () => void flush(), [flush]);
  useEffect(() => {
    const onHide = () => document.visibilityState === 'hidden' && void flush();
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [flush]);

  const onChange = (patch: { title?: string; body?: string }) => {
    if (patch.title !== undefined) setTitle(patch.title);
    if (patch.body !== undefined) setBody(patch.body);
    dirty.current = true;
    setStatus('idle');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DELAY);
  };

  const setMeta = async (patch: Partial<Pick<Memo, 'pinned' | 'categoryId'>>) => {
    await flush();
    if (memoId.current) await update(db, session, 'memos', memoId.current, patch);
  };

  const remove = async () => {
    if (!memoId.current) return goBack('/memos');
    if (!(await confirm({ title: 'メモを削除', message: '家族の端末からも削除されます。', confirmLabel: '削除', danger: true }))) return;
    const mid = memoId.current;
    dirty.current = false;
    await softDelete(db, session, 'memos', mid);
    toast({ message: 'メモを削除しました', onAction: () => void restoreDeleted(db, session, 'memos', mid) });
    navigate('/memos', { replace: true });
  };

  const resolve = async (conflictId: string, field: string, value: unknown) => {
    if (value !== undefined && memoId.current) {
      await update(db, session, 'memos', memoId.current, { [field]: value } as Partial<Memo>);
      dirty.current = false;
      loaded.current = false;
    }
    await db.conflicts.update(conflictId, { resolved: true });
  };

  if (!isNew && memo === null) {
    return (
      <>
        <PageHeader title="メモ" back="/memos" />
        <main className="main no-tabs">
          <p className="muted">このメモは見つかりません。</p>
        </main>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={isNew && !memoId.current ? '新しいメモ' : 'メモ'}
        back="/memos"
        actions={
          <>
            <button className="icon-btn" aria-label={memo?.pinned ? 'ピン留めを外す' : 'ピン留めする'} aria-pressed={!!memo?.pinned} onClick={() => void setMeta({ pinned: !memo?.pinned })} disabled={!memoId.current} style={memo?.pinned ? { color: 'var(--primary)' } : undefined}>
              <Icon name="pin" />
            </button>
            <button className="icon-btn" aria-label="削除" onClick={() => void remove()}>
              <Icon name="trash" />
            </button>
          </>
        }
      />
      <main className="main no-tabs">
        {(conflicts ?? []).map((c) => (
          <div key={c.id} className="card stack" style={{ marginBottom: 12 }}>
            <div className="notice warn">
              <Icon name="alert" />
              <span>
                別の端末と同時に「{c.field === 'title' ? 'タイトル' : '本文'}」が編集されました。現在の内容が採用されています。もう一方の内容は次のとおりです。
              </span>
            </div>
            <div className="diff">
              <pre>{String(c.losingValue ?? '')}</pre>
            </div>
            <div className="btn-row">
              <button className="btn small" onClick={() => void resolve(c.id, c.field, undefined)}>
                現在の内容のまま
              </button>
              <button className="btn small primary" onClick={() => void resolve(c.id, c.field, c.losingValue)}>
                こちらに置き換える
              </button>
            </div>
          </div>
        ))}
        <div className="stack">
          <input className="input" value={title} onChange={(e) => onChange({ title: e.target.value })} placeholder="タイトル" maxLength={LIMITS.title} aria-label="タイトル" style={{ fontWeight: 700, fontSize: '1.25rem' }} onBlur={() => void flush()} />
          <textarea className="textarea" value={body} onChange={(e) => onChange({ body: e.target.value })} placeholder="本文" maxLength={LIMITS.memoBody} aria-label="本文" rows={12} onBlur={() => void flush()} />
          <label className="field">
            <span>カテゴリー</span>
            <select className="select" value={memo?.categoryId ?? ''} onChange={(e) => void setMeta({ categoryId: e.target.value || null })} disabled={!memoId.current}>
              <option value="">なし</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <p className="small muted" aria-live="polite">
            {status === 'saving' && '保存中…'}
            {status === 'saved' && '保存しました'}
            {status === 'error' && <span className="error-text">保存できませんでした (文字数などを確認してください)</span>}
            {status === 'idle' && memo && `最終更新: ${relativeTime(memo.updatedAt)}・${members.get(memo.updatedBy)?.name ?? ''}`}
            {status === 'idle' && !memo && '入力すると自動で保存されます'}
          </p>
        </div>
      </main>
    </>
  );
}

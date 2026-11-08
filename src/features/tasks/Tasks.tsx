import { useState } from 'react';
import { useApp } from '../../app/context';
import { useActive, useCategories, useMemberMap, useMembers } from '../../app/hooks';
import { MainHeader } from '../../app/Shell';
import { Icon } from '../../components/Icon';
import { Avatar, CheckButton, EmptyState, errorMessage, Fab, Field, MemberPicker, Sheet, useFeedback } from '../../components/ui';
import { LIMITS, type Task } from '../../domain/schemas';
import { create, restoreDeleted, softDelete, update } from '../../db/repo';
import { addDays, friendlyDate, parseLocalDate, today } from '../../lib/date';
import { isOverdue, sortTasks } from './taskUtils';

type Filter = 'open' | 'mine' | 'done';

export function Tasks() {
  const { db, session } = useApp();
  const tasks = useActive('tasks');
  const members = useMemberMap();
  const [filter, setFilter] = useState<Filter>('open');
  const [editing, setEditing] = useState<Task | 'new' | null>(null);

  const all = tasks ?? [];
  const visible =
    filter === 'done'
      ? all.filter((t) => t.done).sort((a, b) => ((a.doneAt ?? '') < (b.doneAt ?? '') ? 1 : -1))
      : sortTasks(all.filter((t) => !t.done && (filter === 'open' || t.assigneeId === session.memberId)));

  const toggle = (t: Task) =>
    update(db, session, 'tasks', t.id, t.done ? { done: false, doneAt: null, doneBy: null } : { done: true, doneAt: new Date().toISOString(), doneBy: session.memberId });

  const counts = { open: all.filter((t) => !t.done).length, mine: all.filter((t) => !t.done && t.assigneeId === session.memberId).length };

  return (
    <>
      <MainHeader title="タスク" />
      <main className="main">
        <div className="chips" role="group" aria-label="絞り込み">
          <button className="chip" aria-pressed={filter === 'open'} onClick={() => setFilter('open')}>
            未完了 {counts.open}
          </button>
          <button className="chip" aria-pressed={filter === 'mine'} onClick={() => setFilter('mine')}>
            自分の担当 {counts.mine}
          </button>
          <button className="chip" aria-pressed={filter === 'done'} onClick={() => setFilter('done')}>
            完了済み
          </button>
        </div>
        {visible.length === 0 ? (
          <EmptyState icon="task" title={filter === 'done' ? '完了したタスクはありません' : '未完了のタスクはありません'} hint={filter !== 'done' ? '家事やお願いごとを登録して、担当と期限を決めましょう' : undefined} />
        ) : (
          <ul className="list">
            {visible.map((t) => (
              <li className={`row ${t.done ? 'done' : ''}`} key={t.id}>
                <CheckButton checked={t.done} label={t.done ? `${t.title} を未完了に戻す` : `${t.title} を完了にする`} onToggle={() => void toggle(t)} />
                <button className="row-main" onClick={() => setEditing(t)}>
                  <div className="row-title">{t.title}</div>
                  <div className="row-sub" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    {t.dueDate &&
                      (isOverdue(t) ? (
                        <span className="badge warn">
                          <Icon name="alert" />
                          期限切れ {friendlyDate(t.dueDate)}
                        </span>
                      ) : (
                        <span>期限 {friendlyDate(t.dueDate)}</span>
                      ))}
                    {t.done && t.doneBy && <span>{members.get(t.doneBy)?.name ?? ''} が完了</span>}
                    {t.note && !t.done && <span>{t.note.split('\n')[0]}</span>}
                  </div>
                </button>
                {t.assigneeId && (
                  <span title={members.get(t.assigneeId)?.name}>
                    <Avatar member={members.get(t.assigneeId)} />
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
      <Fab label="タスク" onClick={() => setEditing('new')} />
      {editing && <TaskSheet task={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function nextWeekend(): string {
  const t = today();
  const d = parseLocalDate(t).getDay();
  return addDays(t, d === 6 ? 7 : 6 - d);
}

function TaskSheet({ task, onClose }: { task: Task | null; onClose: () => void }) {
  const { db, session } = useApp();
  const members = useMembers();
  const categories = useCategories('task');
  const { confirm, toast } = useFeedback();
  const [title, setTitle] = useState(task?.title ?? '');
  const [assignee, setAssignee] = useState<string[]>(task?.assigneeId ? [task.assigneeId] : []);
  const [dueDate, setDueDate] = useState<string | null>(task?.dueDate ?? null);
  const [categoryId, setCategoryId] = useState<string | null>(task?.categoryId ?? null);
  const [note, setNote] = useState(task?.note ?? '');
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    if (!title.trim()) return setError('タスク名を入力してください');
    const fields = { title: title.trim(), assigneeId: assignee[0] ?? null, dueDate, categoryId, note: note.trim() };
    try {
      if (task) await update(db, session, 'tasks', task.id, fields);
      else await create(db, session, 'tasks', { ...fields, done: false, doneAt: null, doneBy: null });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const remove = async () => {
    if (!task || !(await confirm({ title: 'タスクを削除', message: `「${task.title}」を削除します。`, confirmLabel: '削除', danger: true }))) return;
    await softDelete(db, session, 'tasks', task.id);
    toast({ message: 'タスクを削除しました', onAction: () => void restoreDeleted(db, session, 'tasks', task.id) });
    onClose();
  };

  const t = today();
  const quick: [string, string][] = [
    ['今日', t],
    ['明日', addDays(t, 1)],
    ['週末', nextWeekend()],
    ['1週間後', addDays(t, 7)],
  ];

  return (
    <Sheet title={task ? 'タスクを編集' : 'タスクを追加'} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="タスク">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={LIMITS.title} placeholder="例: 体操服を洗う" />
        </Field>
        <Field label="担当" group>
          <MemberPicker members={members} value={assignee} onChange={setAssignee} />
        </Field>
        <Field label="期限" group>
          <div className="quick">
            <button type="button" className="chip" aria-pressed={dueDate === null} onClick={() => setDueDate(null)}>
              なし
            </button>
            {quick.map(([label, d]) => (
              <button type="button" key={label} className="chip" aria-pressed={dueDate === d} onClick={() => setDueDate(d)}>
                {label}
              </button>
            ))}
          </div>
          <input className="input" type="date" value={dueDate ?? ''} onChange={(e) => setDueDate(e.target.value || null)} aria-label="期限日" />
        </Field>
        <Field label="カテゴリー">
          <select className="select" value={categoryId ?? ''} onChange={(e) => setCategoryId(e.target.value || null)}>
            <option value="">なし</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="メモ">
          <textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={LIMITS.note} rows={3} />
        </Field>
        {error && <p className="error-text">{error}</p>}
        <button className="btn primary block" type="submit">
          保存
        </button>
        {task && (
          <button className="btn danger block" type="button" onClick={() => void remove()}>
            <Icon name="trash" />
            削除
          </button>
        )}
      </form>
    </Sheet>
  );
}

import { useState } from 'react';
import { useApp } from '../../app/context';
import { useCategories } from '../../app/hooks';
import { Icon } from '../../components/Icon';
import { ColorPicker, colorVar, errorMessage, Field, PageHeader, Sheet, useFeedback } from '../../components/ui';
import { LIMITS, type Category, type CategoryScope, type Color } from '../../domain/schemas';
import { create, softDelete, update } from '../../db/repo';
import { keyAfterLast } from '../../lib/sortkey';

const SCOPES: [CategoryScope, string][] = [
  ['shopping', '買い物'],
  ['memo', 'メモ'],
  ['event', '予定'],
  ['task', 'タスク'],
];

export function Categories() {
  const [scope, setScope] = useState<CategoryScope>('shopping');
  const cats = useCategories(scope);
  const [editing, setEditing] = useState<Category | 'new' | null>(null);
  return (
    <>
      <PageHeader title="カテゴリー" back="/settings" />
      <main className="main no-tabs">
        <div className="chips">
          {SCOPES.map(([s, l]) => (
            <button key={s} className="chip" aria-pressed={scope === s} onClick={() => setScope(s)}>
              {l}
            </button>
          ))}
        </div>
        <ul className="list">
          {cats.map((c) => (
            <li className="row row-pad" key={c.id}>
              <span className="dot" style={{ background: colorVar(c.color), width: 14, height: 14 }} />
              <button className="row-main" onClick={() => setEditing(c)}>
                <div className="row-title">{c.name}</div>
              </button>
              <Icon name="chevron" />
            </li>
          ))}
        </ul>
        <button className="btn block" style={{ marginTop: 16 }} onClick={() => setEditing('new')}>
          <Icon name="plus" />
          カテゴリーを追加
        </button>
      </main>
      {editing && <CategorySheet scope={scope} category={editing === 'new' ? null : editing} keys={cats.map((c) => c.sortKey)} onClose={() => setEditing(null)} />}
    </>
  );
}

function CategorySheet({ scope, category, keys, onClose }: { scope: CategoryScope; category: Category | null; keys: string[]; onClose: () => void }) {
  const { db, session } = useApp();
  const { confirm } = useFeedback();
  const [name, setName] = useState(category?.name ?? '');
  const [color, setColor] = useState<Color>(category?.color ?? 'teal');
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!name.trim()) return setError('名前を入力してください');
    try {
      if (category) await update(db, session, 'categories', category.id, { name: name.trim(), color });
      else await create(db, session, 'categories', { scope, name: name.trim(), color, sortKey: keyAfterLast(keys) });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const remove = async () => {
    if (!category || !(await confirm({ title: 'カテゴリーを削除', message: 'このカテゴリーの項目は「未分類」になります。', confirmLabel: '削除', danger: true }))) return;
    await softDelete(db, session, 'categories', category.id);
    onClose();
  };
  return (
    <Sheet title={category ? 'カテゴリーを編集' : 'カテゴリーを追加'} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="名前" error={error}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.name} />
        </Field>
        <Field label="色" group>
          <ColorPicker value={color} onChange={setColor} />
        </Field>
        <button className="btn primary block" type="submit">
          保存
        </button>
        {category && (
          <button className="btn danger block" type="button" onClick={() => void remove()}>
            削除
          </button>
        )}
      </form>
    </Sheet>
  );
}

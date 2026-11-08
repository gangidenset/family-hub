import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/context';
import { useActive, useCategories, useMemberMap } from '../../app/hooks';
import { Link, navigate, useRoute } from '../../app/router';
import { MainHeader } from '../../app/Shell';
import { Icon } from '../../components/Icon';
import { CheckButton, colorVar, EmptyState, errorMessage, Fab, Field, Sheet, useFeedback } from '../../components/ui';
import type { Category, ShoppingItem, ShoppingList } from '../../domain/schemas';
import { LIMITS } from '../../domain/schemas';
import { create, restoreDeleted, softDelete, update } from '../../db/repo';
import { keyAfterLast, keyBetween } from '../../lib/sortkey';

const UNCATEGORIZED = '__none__';
const UNDO_PURCHASE_MS = 30 * 60 * 1000;

export function Shopping() {
  const { db, session } = useApp();
  const { query } = useRoute();
  const lists = useActive('shoppingLists');
  const items = useActive('shoppingItems');
  const purchases = useActive('purchases');
  const categories = useCategories('shopping');
  const members = useMemberMap();
  const { confirm, toast } = useFeedback();
  const [editing, setEditing] = useState<ShoppingItem | 'new' | null>(null);
  const [listSheet, setListSheet] = useState<ShoppingList | 'new' | null>(null);
  const [sorting, setSorting] = useState(false);

  const sortedLists = useMemo(() => (lists ?? []).slice().sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1)), [lists]);
  const listId = query.get('list');
  const current = sortedLists.find((l) => l.id === listId) ?? sortedLists[0];

  useEffect(() => {
    if (current && listId !== current.id) navigate(`/shopping?list=${current.id}`, { replace: true });
  }, [current, listId]);

  const listItems = (items ?? []).filter((i) => i.listId === current?.id);
  const open = listItems.filter((i) => !i.checked);
  const done = listItems.filter((i) => i.checked).sort((a, b) => ((a.checkedAt ?? '') < (b.checkedAt ?? '') ? 1 : -1));

  const groups = useMemo(() => {
    const byCat = new Map<string, ShoppingItem[]>();
    for (const i of open) {
      const k = i.categoryId && categories.some((c) => c.id === i.categoryId) ? i.categoryId : UNCATEGORIZED;
      byCat.set(k, [...(byCat.get(k) ?? []), i]);
    }
    const order: (Category | null)[] = [...categories, null];
    return order
      .map((c) => ({ cat: c, items: (byCat.get(c?.id ?? UNCATEGORIZED) ?? []).sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1)) }))
      .filter((g) => g.items.length > 0);
  }, [open, categories]);

  const toggle = async (item: ShoppingItem) => {
    const now = new Date().toISOString();
    if (!item.checked) {
      await update(db, session, 'shoppingItems', item.id, { checked: true, checkedAt: now, checkedBy: session.memberId });
      await create(db, session, 'purchases', {
        listId: item.listId,
        itemId: item.id,
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
        categoryId: item.categoryId,
        purchasedAt: now,
        purchasedBy: session.memberId,
      });
    } else {
      await update(db, session, 'shoppingItems', item.id, { checked: false, checkedAt: null, checkedBy: null });
      // 誤ってチェックした直後の取り消しは購入履歴からも除く
      const recent = (purchases ?? [])
        .filter((p) => p.itemId === item.id && Date.now() - new Date(p.purchasedAt).getTime() < UNDO_PURCHASE_MS)
        .sort((a, b) => (a.purchasedAt < b.purchasedAt ? 1 : -1))[0];
      if (recent) await softDelete(db, session, 'purchases', recent.id);
    }
  };

  const remove = async (item: ShoppingItem) => {
    await softDelete(db, session, 'shoppingItems', item.id);
    toast({ message: `「${item.name}」を削除しました`, onAction: () => void restoreDeleted(db, session, 'shoppingItems', item.id) });
  };

  const clearDone = async () => {
    if (!(await confirm({ title: '購入済みを削除', message: `購入済みの ${done.length} 品をリストから削除します。購入履歴は残ります。`, confirmLabel: '削除', danger: true }))) return;
    for (const i of done) await softDelete(db, session, 'shoppingItems', i.id);
    toast(`${done.length} 品を削除しました`);
  };

  const move = async (group: ShoppingItem[], index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= group.length) return;
    const lo = dir === -1 ? group[target - 1]?.sortKey ?? null : group[target]!.sortKey;
    const hi = dir === -1 ? group[target]!.sortKey : group[target + 1]?.sortKey ?? null;
    let key: string;
    try {
      key = keyBetween(lo, hi);
    } catch {
      key = dir === -1 ? keyBetween(null, group[0]!.sortKey) : keyAfterLast(group.map((g) => g.sortKey));
    }
    await update(db, session, 'shoppingItems', group[index]!.id, { sortKey: key });
  };

  if (items === undefined) return <MainHeader title="" />;

  return (
    <>
      <MainHeader
        title="買い物リスト"
        extra={
          current && (
            <button className="icon-btn" aria-label="リストの設定" onClick={() => setListSheet(current)}>
              <Icon name="edit" />
            </button>
          )
        }
      />
      <main className="main">
        <div className="chips" role="tablist" aria-label="リスト">
          {sortedLists.map((l) => (
            <button key={l.id} className="chip" role="tab" aria-pressed={l.id === current?.id} aria-selected={l.id === current?.id} onClick={() => navigate(`/shopping?list=${l.id}`, { replace: true })}>
              {l.name}
            </button>
          ))}
          <button className="chip" onClick={() => setListSheet('new')} aria-label="リストを追加">
            <Icon name="plus" />
            リスト
          </button>
        </div>

        {current && (
          <div className="section-title" style={{ marginTop: 8 }}>
            <span>あと {open.length} 品</span>
            <span style={{ display: 'flex', gap: 4 }}>
              {open.length > 1 && (
                <button onClick={() => setSorting((s) => !s)} aria-pressed={sorting}>
                  {sorting ? '並び替え完了' : '並び替え'}
                </button>
              )}
              <Link to={`/shopping/history`}>購入履歴</Link>
            </span>
          </div>
        )}

        {!current ? (
          <EmptyState icon="cart" title="リストがありません" hint="「＋ リスト」から作成してください" />
        ) : open.length === 0 && done.length === 0 ? (
          <EmptyState icon="cart" title="買う物はありません" hint="右下の「追加」から商品を登録できます" />
        ) : null}

        {groups.map((g) => (
          <section key={g.cat?.id ?? 'none'} className="section">
            <h3 className="section-title" style={{ marginTop: 12 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="dot" style={{ background: colorVar(g.cat?.color) }} />
                {g.cat?.name ?? '未分類'}
              </span>
            </h3>
            <ul className="list">
              {g.items.map((i, idx) => (
                <li className="row" key={i.id}>
                  <CheckButton checked={false} label={`${i.name} を購入済みにする`} onToggle={() => void toggle(i)} />
                  <button className="row-main" onClick={() => setEditing(i)}>
                    <div className="row-title">
                      {i.name}
                      {(i.quantity > 1 || i.unit) && (
                        <span className="muted">
                          {' '}
                          × {i.quantity}
                          {i.unit}
                        </span>
                      )}
                    </div>
                    {i.note && <div className="row-sub">{i.note}</div>}
                  </button>
                  {sorting ? (
                    <>
                      <button className="icon-btn" aria-label="上へ" disabled={idx === 0} onClick={() => void move(g.items, idx, -1)}>
                        <Icon name="up" />
                      </button>
                      <button className="icon-btn" aria-label="下へ" disabled={idx === g.items.length - 1} onClick={() => void move(g.items, idx, 1)}>
                        <Icon name="down" />
                      </button>
                    </>
                  ) : (
                    <button className="icon-btn" aria-label={`${i.name} を削除`} onClick={() => void remove(i)}>
                      <Icon name="trash" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}

        {done.length > 0 && (
          <section className="section">
            <h3 className="section-title">
              購入済み ({done.length})
              <button onClick={() => void clearDone()}>まとめて削除</button>
            </h3>
            <ul className="list">
              {done.map((i) => (
                <li className="row done" key={i.id}>
                  <CheckButton checked label={`${i.name} を未購入に戻す`} onToggle={() => void toggle(i)} />
                  <div className="row-main static">
                    <div className="row-title">{i.name}</div>
                    {i.checkedBy && <div className="row-sub">{members.get(i.checkedBy)?.name ?? ''} が購入</div>}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
      {current && <Fab label="追加" onClick={() => setEditing('new')} />}
      {editing && current && (
        <ItemSheet
          item={editing === 'new' ? null : editing}
          list={current}
          categories={categories}
          suggestions={suggestionsFrom(purchases ?? [], listItems)}
          existingKeys={listItems.map((i) => i.sortKey)}
          onClose={() => setEditing(null)}
        />
      )}
      {listSheet && <ListSheet list={listSheet === 'new' ? null : listSheet} lists={sortedLists} onClose={() => setListSheet(null)} />}
    </>
  );
}

/** 購入履歴から「よく買う物」 */
function suggestionsFrom(purchases: { name: string }[], current: ShoppingItem[]): string[] {
  const counts = new Map<string, number>();
  for (const p of purchases) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  const inList = new Set(current.filter((i) => !i.checked).map((i) => i.name));
  return [...counts.entries()]
    .filter(([n]) => !inList.has(n))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([n]) => n);
}

function ItemSheet({
  item,
  list,
  categories,
  suggestions,
  existingKeys,
  onClose,
}: {
  item: ShoppingItem | null;
  list: ShoppingList;
  categories: Category[];
  suggestions: string[];
  existingKeys: string[];
  onClose: () => void;
}) {
  const { db, session } = useApp();
  const { toast } = useFeedback();
  const [name, setName] = useState(item?.name ?? '');
  const [quantity, setQuantity] = useState(item?.quantity ?? 1);
  const [unit, setUnit] = useState(item?.unit ?? '');
  const [categoryId, setCategoryId] = useState<string | null>(item?.categoryId ?? null);
  const [note, setNote] = useState(item?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [keys, setKeys] = useState(existingKeys);

  const save = async (keepOpen: boolean) => {
    setError(null);
    if (!name.trim()) return setError('商品名を入力してください');
    try {
      const fields = { name: name.trim(), quantity, unit: unit.trim(), categoryId, note: note.trim() };
      if (item) {
        await update(db, session, 'shoppingItems', item.id, fields);
        onClose();
      } else {
        const sortKey = keyAfterLast(keys);
        await create(db, session, 'shoppingItems', { ...fields, listId: list.id, checked: false, checkedAt: null, checkedBy: null, sortKey });
        setKeys((k) => [...k, sortKey]);
        if (keepOpen) {
          toast(`「${fields.name}」を追加しました`);
          setName('');
          setQuantity(1);
          setUnit('');
          setNote('');
        } else onClose();
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Sheet title={item ? '商品を編集' : `「${list.name}」に追加`} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save(!item);
        }}
      >
        <Field label="商品名">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.itemName} placeholder="例: 牛乳" enterKeyHint="done" />
        </Field>
        {!item && suggestions.length > 0 && (
          <div className="chips" aria-label="よく買う物">
            {suggestions.map((s) => (
              <button type="button" key={s} className="chip" onClick={() => setName(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        <div className="field-row">
          <Field label="数量" group>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button type="button" className="icon-btn" aria-label="減らす" onClick={() => setQuantity((q) => Math.max(1, q - 1))}>
                <Icon name="down" />
              </button>
              <input
                className="input"
                inputMode="numeric"
                value={quantity}
                onChange={(e) => setQuantity(Math.min(LIMITS.quantityMax, Math.max(1, parseInt(e.target.value.replace(/\D/g, '') || '1', 10))))}
                aria-label="数量"
                style={{ textAlign: 'center' }}
              />
              <button type="button" className="icon-btn" aria-label="増やす" onClick={() => setQuantity((q) => Math.min(LIMITS.quantityMax, q + 1))}>
                <Icon name="up" />
              </button>
            </div>
          </Field>
          <Field label="単位">
            <input className="input" value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={LIMITS.unit} placeholder="個, 本, g" />
          </Field>
        </div>
        <Field label="カテゴリー">
          <select className="select" value={categoryId ?? ''} onChange={(e) => setCategoryId(e.target.value || null)}>
            <option value="">未分類</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="メモ">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={LIMITS.title} placeholder="例: 低脂肪のもの" />
        </Field>
        {error && <p className="error-text">{error}</p>}
        {item ? (
          <button className="btn primary block" type="submit">
            保存
          </button>
        ) : (
          <div className="btn-row">
            <button className="btn" type="button" onClick={() => void save(false)}>
              追加して閉じる
            </button>
            <button className="btn primary" type="submit">
              続けて追加
            </button>
          </div>
        )}
      </form>
    </Sheet>
  );
}

function ListSheet({ list, lists, onClose }: { list: ShoppingList | null; lists: ShoppingList[]; onClose: () => void }) {
  const { db, session } = useApp();
  const { confirm, toast } = useFeedback();
  const [name, setName] = useState(list?.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!name.trim()) return setError('リスト名を入力してください');
    try {
      if (list) await update(db, session, 'shoppingLists', list.id, { name: name.trim() });
      else {
        const id = await create(db, session, 'shoppingLists', { name: name.trim(), sortKey: keyAfterLast(lists.map((l) => l.sortKey)) });
        navigate(`/shopping?list=${id}`, { replace: true });
      }
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const remove = async () => {
    if (!list) return;
    if (!(await confirm({ title: 'リストを削除', message: `「${list.name}」と中の商品を削除します。`, confirmLabel: '削除', danger: true }))) return;
    await softDelete(db, session, 'shoppingLists', list.id);
    toast({ message: 'リストを削除しました', onAction: () => void restoreDeleted(db, session, 'shoppingLists', list.id) });
    navigate('/shopping', { replace: true });
    onClose();
  };
  return (
    <Sheet title={list ? 'リストの設定' : '新しいリスト'} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="リスト名" error={error}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.name} placeholder="例: ドラッグストア" />
        </Field>
        <button className="btn primary block" type="submit">
          保存
        </button>
        {list && lists.length > 1 && (
          <button className="btn danger block" type="button" onClick={() => void remove()}>
            <Icon name="trash" />
            このリストを削除
          </button>
        )}
      </form>
    </Sheet>
  );
}

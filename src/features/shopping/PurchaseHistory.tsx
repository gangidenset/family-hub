import { useApp } from '../../app/context';
import { useActive, useMemberMap } from '../../app/hooks';
import { EmptyState, PageHeader, useFeedback } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { create, listActive } from '../../db/repo';
import { friendlyDate, isoToLocalDate, isoToLocalTime } from '../../lib/date';
import { keyAfterLast } from '../../lib/sortkey';
import type { Purchase } from '../../domain/schemas';

export function PurchaseHistory() {
  const { db, session } = useApp();
  const purchases = useActive('purchases');
  const lists = useActive('shoppingLists');
  const members = useMemberMap();
  const { toast } = useFeedback();

  const sorted = (purchases ?? []).slice().sort((a, b) => (a.purchasedAt < b.purchasedAt ? 1 : -1)).slice(0, 500);
  const byDay = new Map<string, Purchase[]>();
  for (const p of sorted) {
    const d = isoToLocalDate(p.purchasedAt);
    byDay.set(d, [...(byDay.get(d) ?? []), p]);
  }

  const readd = async (p: Purchase) => {
    const listId = lists?.some((l) => l.id === p.listId) ? p.listId : lists?.[0]?.id;
    if (!listId) return;
    const items = (await listActive(db, session.groupId, 'shoppingItems')).filter((i) => i.listId === listId);
    await create(db, session, 'shoppingItems', {
      listId,
      name: p.name,
      quantity: p.quantity,
      unit: p.unit,
      categoryId: p.categoryId,
      note: '',
      checked: false,
      checkedAt: null,
      checkedBy: null,
      sortKey: keyAfterLast(items.map((i) => i.sortKey)),
    });
    toast(`「${p.name}」をリストに追加しました`);
  };

  return (
    <>
      <PageHeader title="購入履歴" back="/shopping" />
      <main className="main no-tabs">
        {sorted.length === 0 && <EmptyState icon="history" title="購入履歴はまだありません" hint="買い物リストでチェックした商品がここに記録されます" />}
        {[...byDay.entries()].map(([day, ps]) => (
          <section key={day} className="section">
            <h2 className="section-title">{friendlyDate(day)}</h2>
            <ul className="list">
              {ps.map((p) => (
                <li className="row row-pad" key={p.id}>
                  <div className="row-main static">
                    <div className="row-title">
                      {p.name}
                      {(p.quantity > 1 || p.unit) && <span className="muted"> × {p.quantity}{p.unit}</span>}
                    </div>
                    <div className="row-sub">
                      {isoToLocalTime(p.purchasedAt)} ・ {members.get(p.purchasedBy)?.name ?? ''}
                    </div>
                  </div>
                  <button className="btn small ghost" onClick={() => void readd(p)} aria-label={`${p.name} をもう一度リストに追加`}>
                    <Icon name="plus" />
                    もう一度
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </main>
    </>
  );
}

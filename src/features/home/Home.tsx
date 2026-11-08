import { useApp } from '../../app/context';
import { useActive, useMemberMap } from '../../app/hooks';
import { Link } from '../../app/router';
import { MainHeader } from '../../app/Shell';
import { Icon } from '../../components/Icon';
import { Avatar, CheckButton } from '../../components/ui';
import { update } from '../../db/repo';
import { addDays, formatDate, friendlyDate, today } from '../../lib/date';
import { isStandalone } from '../../lib/device';
import { compareEvents, timeLabel } from '../calendar/eventUtils';
import { isOverdue, sortTasks } from '../tasks/taskUtils';

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'こんばんは';
  if (h < 11) return 'おはようございます';
  if (h < 18) return 'こんにちは';
  return 'こんばんは';
}

export function Home() {
  const { db, session } = useApp();
  const members = useMemberMap();
  const tasks = useActive('tasks');
  const events = useActive('events');
  const lists = useActive('shoppingLists');
  const items = useActive('shoppingItems');
  const memos = useActive('memos');
  const groups = useActive('groups');
  const me = members.get(session.memberId);
  const t = today();
  const weekEnd = addDays(t, 7);

  const upcoming = (events ?? []).filter((e) => e.endDate >= t && e.startDate <= weekEnd).sort(compareEvents).slice(0, 3);
  const openTasks = sortTasks((tasks ?? []).filter((x) => !x.done));
  const mine = openTasks.filter((x) => x.assigneeId === session.memberId);
  const topTasks = [...mine, ...openTasks.filter((x) => x.assigneeId !== session.memberId)].slice(0, 5);
  const pinned = (memos ?? []).filter((m) => m.pinned).slice(0, 2);
  const remaining = (items ?? []).filter((i) => !i.checked);

  return (
    <>
      <MainHeader title={groups?.[0]?.name ?? 'FamilyHub'} />
      <main className="main">
        <div className="greet">
          <div className="date">{formatDate(t, { weekday: true, year: true })}</div>
          <h2>
            {greeting()}
            {me && `、${me.name}さん`}
          </h2>
        </div>

        {!isStandalone() && (
          <div className="notice" style={{ marginTop: 12 }}>
            <Icon name="info" />
            <span className="small">
              ホーム画面に追加すると、アプリのように起動でき、データも消えにくくなります (iPhone: 共有ボタン →「ホーム画面に追加」/ Android: メニュー →「アプリをインストール」)。
            </span>
          </div>
        )}

        <h2 className="section-title">
          直近の予定
          <Link to="/calendar">カレンダー</Link>
        </h2>
        {upcoming.length === 0 ? (
          <div className="card muted">1 週間以内の予定はありません</div>
        ) : (
          <ul className="list">
            {upcoming.map((e) => (
              <li className="row" key={e.id}>
                <div className="time-col">{e.startDate < t ? '継続中' : friendlyDate(e.startDate)}</div>
                <Link to={`/calendar?date=${e.startDate < t ? t : e.startDate}`} className="row-main">
                  <div className="row-title">{e.title}</div>
                  <div className="row-sub">{timeLabel(e)}</div>
                </Link>
                <span className="avatars">
                  {e.memberIds.slice(0, 3).map((id) => (
                    <Avatar key={id} member={members.get(id)} size="sm" />
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}

        <h2 className="section-title">
          未完了のタスク {openTasks.length > 0 && `(${openTasks.length})`}
          <Link to="/tasks">すべて</Link>
        </h2>
        {topTasks.length === 0 ? (
          <div className="card muted">未完了のタスクはありません</div>
        ) : (
          <ul className="list">
            {topTasks.map((x) => (
              <li className="row" key={x.id}>
                <CheckButton
                  checked={false}
                  label={`${x.title} を完了にする`}
                  onToggle={() => void update(db, session, 'tasks', x.id, { done: true, doneAt: new Date().toISOString(), doneBy: session.memberId })}
                />
                <Link to="/tasks" className="row-main">
                  <div className="row-title">{x.title}</div>
                  {x.dueDate && <div className="row-sub">{isOverdue(x) ? <span className="badge warn">期限切れ {friendlyDate(x.dueDate)}</span> : `期限 ${friendlyDate(x.dueDate)}`}</div>}
                </Link>
                {x.assigneeId && <Avatar member={members.get(x.assigneeId)} size="sm" />}
              </li>
            ))}
          </ul>
        )}

        <h2 className="section-title">
          買い物
          <Link to="/shopping">リストを開く</Link>
        </h2>
        <div className="tiles">
          {(lists ?? [])
            .slice()
            .sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1))
            .map((l) => {
              const n = remaining.filter((i) => i.listId === l.id).length;
              return (
                <Link key={l.id} to={`/shopping?list=${l.id}`} className="tile">
                  <Icon name="cart" />
                  <strong>{l.name}</strong>
                  <span className="muted">{n ? `あと ${n} 品` : '買う物はありません'}</span>
                </Link>
              );
            })}
        </div>

        {pinned.length > 0 && (
          <>
            <h2 className="section-title">
              ピン留めメモ
              <Link to="/memos">メモ一覧</Link>
            </h2>
            <ul className="list">
              {pinned.map((m) => (
                <li className="row row-pad" key={m.id}>
                  <Link to={`/memos/${m.id}`} className="row-main">
                    <div className="row-title">{m.title || '無題のメモ'}</div>
                    <div className="row-sub">{m.body.split('\n').slice(0, 2).join(' ')}</div>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    </>
  );
}

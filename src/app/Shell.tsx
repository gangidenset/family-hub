import type { ReactNode } from 'react';
import { Icon, type IconName } from '../components/Icon';
import { PageHeader } from '../components/ui';
import { relativeTime } from '../lib/date';
import { useSyncSummary } from './hooks';
import { Link, matchPath, useRoute } from './router';
import { Home } from '../features/home/Home';
import { Shopping } from '../features/shopping/Shopping';
import { PurchaseHistory } from '../features/shopping/PurchaseHistory';
import { Memos } from '../features/memos/Memos';
import { MemoEditor } from '../features/memos/MemoEditor';
import { Calendar } from '../features/calendar/Calendar';
import { Tasks } from '../features/tasks/Tasks';
import { Members } from '../features/members/Members';
import { Settings } from '../features/settings/Settings';
import { Categories } from '../features/settings/Categories';
import { BackupPage } from '../features/settings/BackupPage';
import { SyncHub } from '../features/sync/SyncHub';
import { Connect } from '../features/sync/Connect';
import { Legal } from '../features/settings/Legal';

const TABS: { to: string; label: string; icon: IconName }[] = [
  { to: '/', label: 'ホーム', icon: 'home' },
  { to: '/shopping', label: '買い物', icon: 'cart' },
  { to: '/calendar', label: '予定', icon: 'calendar' },
  { to: '/tasks', label: 'タスク', icon: 'task' },
  { to: '/memos', label: 'メモ', icon: 'memo' },
];

export function SyncPill() {
  const s = useSyncSummary();
  if (!s) return null;
  let cls = '';
  let text = '同期';
  if (s.otherDevices === 0) {
    text = '家族とつなぐ';
  } else if (s.pending > 0) {
    cls = 'pending';
    text = `未送信 ${s.pending}`;
  } else if (s.lastSyncAt) {
    cls = 'ok';
    text = relativeTime(s.lastSyncAt);
  }
  return (
    <Link to="/sync" className={`sync-pill ${cls}`} aria-label={`同期: ${text}`}>
      <Icon name="sync" />
      {text}
    </Link>
  );
}

export function MainHeader({ title, extra }: { title: string; extra?: ReactNode }) {
  return (
    <PageHeader
      title={title}
      actions={
        <>
          {extra}
          <SyncPill />
          <Link to="/settings" className="icon-btn" aria-label="設定">
            <Icon name="gear" />
          </Link>
        </>
      }
    />
  );
}

function route(path: string): { page: ReactNode; tabs: boolean } {
  const tab = (page: ReactNode) => ({ page, tabs: true });
  const sub = (page: ReactNode) => ({ page, tabs: false });
  if (path === '/') return tab(<Home />);
  if (path === '/shopping') return tab(<Shopping />);
  if (path === '/shopping/history') return sub(<PurchaseHistory />);
  if (path === '/memos') return tab(<Memos />);
  if (path === '/calendar') return tab(<Calendar />);
  if (path === '/tasks') return tab(<Tasks />);
  if (path === '/members') return sub(<Members />);
  if (path === '/settings') return sub(<Settings />);
  if (path === '/settings/categories') return sub(<Categories />);
  if (path === '/settings/backup') return sub(<BackupPage />);
  if (path === '/sync') return sub(<SyncHub />);
  let m = matchPath('/memos/:id', path);
  if (m) return sub(<MemoEditor id={m.id!} />);
  m = matchPath('/connect/:mode/:role', path);
  if (m && (m.mode === 'pair' || m.mode === 'sync') && (m.role === 'host' || m.role === 'guest')) return sub(<Connect mode={m.mode} role={m.role} />);
  m = matchPath('/legal/:doc', path);
  if (m && (m.doc === 'terms' || m.doc === 'privacy')) return sub(<Legal doc={m.doc} />);
  return tab(<Home />);
}

export function Shell() {
  const { path } = useRoute();
  const { page, tabs } = route(path);
  return (
    <div className="app">
      {page}
      {tabs && (
        <nav className="tabbar" aria-label="メイン">
          {TABS.map((t) => (
            <Link key={t.to} to={t.to} aria-current={path === t.to ? 'page' : undefined}>
              <Icon name={t.icon} />
              {t.label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}

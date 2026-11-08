import { useCallback, useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { db } from '../db/instance';
import { getSession, type Session } from '../db/repo';
import { FeedbackProvider } from '../components/ui';
import { AppContext } from './context';
import { useSettings } from './hooks';
import { Shell } from './Shell';
import { Onboarding } from '../features/onboarding/Onboarding';

function useApplySettings() {
  const settings = useSettings();
  useEffect(() => {
    const root = document.documentElement;
    if (!settings) return;
    if (settings.theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = settings.theme;
    root.dataset.font = settings.fontScale;
    const dark = settings.theme === 'dark' || (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#111416' : '#f6f7f8');
  }, [settings]);
}

/** Service Worker の登録 (オフライン起動に必須) と更新通知。自動リロードはせず利用者の操作で適用する */
function UpdateBanner() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({ immediate: true });
  if (!needRefresh) return null;
  return (
    <div className="banner" role="status">
      <span>新しいバージョンがあります</span>
      <button className="btn small primary" onClick={() => void updateServiceWorker(true)}>
        更新
      </button>
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [fatal, setFatal] = useState(false);
  useApplySettings();

  const reload = useCallback(async () => {
    try {
      setSession(await getSession(db));
    } catch {
      setFatal(true);
    }
  }, []);

  useEffect(() => {
    void reload();
    // ブラウザによる自動削除を防ぐ (docs/03-architecture.md)
    void navigator.storage?.persist?.().catch(() => undefined);
  }, [reload]);

  if (fatal) {
    return (
      <div className="welcome">
        <h1>データを読み込めませんでした</h1>
        <p className="muted">ブラウザのプライベートモードではデータを保存できない場合があります。通常モードで開き直してください。</p>
      </div>
    );
  }
  if (session === undefined) return <div className="spinner" aria-label="読み込み中" />;

  return (
    <FeedbackProvider>
      <UpdateBanner />
      {session ? (
        <AppContext.Provider value={{ db, session, reload }}>
          <Shell />
        </AppContext.Provider>
      ) : (
        <Onboarding db={db} onDone={reload} />
      )}
    </FeedbackProvider>
  );
}

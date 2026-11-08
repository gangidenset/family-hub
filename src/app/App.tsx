import { useCallback, useEffect, useState } from 'react';
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

import { createContext, useContext } from 'react';
import type { FamilyDB } from '../db/db';
import type { Session } from '../db/repo';

export interface AppContextValue {
  db: FamilyDB;
  session: Session;
  /** セッション (所属グループ) が変わったときに再読込する */
  reload: () => Promise<void>;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const v = useContext(AppContext);
  if (!v) throw new Error('AppContext missing');
  return v;
}

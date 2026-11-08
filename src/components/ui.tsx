import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { COLORS, type Color, type Member } from '../domain/schemas';
import { goBack } from '../app/router';
import { Icon, type IconName } from './Icon';

// ---- ヘッダー ----
export function PageHeader({ title, back, actions }: { title: string; back?: string | boolean; actions?: ReactNode }) {
  return (
    <header className="header">
      {back && (
        <button className="icon-btn back" onClick={() => goBack(typeof back === 'string' ? back : '/')} aria-label="戻る">
          <Icon name="back" />
        </button>
      )}
      <h1>{title}</h1>
      {actions}
    </header>
  );
}

// ---- ボトムシート ----
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select');
    (first ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1}>
        <div className="sheet-handle" />
        <div className="sheet-head">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="閉じる">
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---- 確認ダイアログ / トースト ----
interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
}
interface ToastOptions {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}
interface FeedbackApi {
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  toast: (o: ToastOptions | string) => void;
}
const FeedbackContext = createContext<FeedbackApi | null>(null);
export const useFeedback = () => {
  const v = useContext(FeedbackContext);
  if (!v) throw new Error('FeedbackProvider missing');
  return v;
};

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const [toast, setToast] = useState<(ToastOptions & { id: number }) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setDialog({ ...o, resolve })), []);
  const showToast = useCallback((o: ToastOptions | string) => {
    const opts = typeof o === 'string' ? { message: o } : o;
    clearTimeout(timer.current);
    setToast({ ...opts, id: Date.now() });
    timer.current = setTimeout(() => setToast(null), opts.onAction ? 5000 : 2500);
  }, []);
  const close = (v: boolean) => {
    dialog?.resolve(v);
    setDialog(null);
  };
  return (
    <FeedbackContext.Provider value={{ confirm, toast: showToast }}>
      {children}
      {dialog && (
        <div className="overlay dialog-overlay" onClick={(e) => e.target === e.currentTarget && close(false)}>
          <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title">
            <h2 id="dlg-title">{dialog.title}</h2>
            {dialog.message && <p>{dialog.message}</p>}
            <div className="btn-row">
              <button className="btn" onClick={() => close(false)} autoFocus>
                キャンセル
              </button>
              <button className={`btn ${dialog.danger ? 'danger' : 'primary'}`} onClick={() => close(true)}>
                {dialog.confirmLabel ?? 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div className="toast" role="status" aria-live="polite" key={toast.id}>
          <span>{toast.message}</span>
          {toast.onAction && (
            <button
              onClick={() => {
                toast.onAction?.();
                setToast(null);
              }}
            >
              {toast.actionLabel ?? '元に戻す'}
            </button>
          )}
        </div>
      )}
    </FeedbackContext.Provider>
  );
}

// ---- フォーム部品 ----
/**
 * 入力欄 1 つなら <label>、ボタン群 (色・メンバー選択など) なら group を指定する。
 * <label> 内に複数のボタンを置くと、見出しのタップで先頭ボタンが押されてしまうため。
 */
export function Field({ label, children, error, group }: { label: string; children: ReactNode; error?: string | null; group?: boolean }) {
  if (group) {
    return (
      <div className="field" role="group" aria-label={label}>
        <span>{label}</span>
        {children}
        {error && <small className="error-text">{error}</small>}
      </div>
    );
  }
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {error && <small className="error-text">{error}</small>}
    </label>
  );
}

export function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="switch-row">
      <span>{label}</span>
      <input type="checkbox" role="switch" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function CheckButton({ checked, onToggle, label }: { checked: boolean; onToggle: () => void; label: string }) {
  return (
    <button className="check" role="checkbox" aria-checked={checked} aria-label={label} onClick={onToggle}>
      <span>{checked && <Icon name="check" />}</span>
    </button>
  );
}

export const colorVar = (c: Color | undefined) => `var(--c-${c ?? 'gray'})`;

export function ColorPicker({ value, onChange }: { value: Color; onChange: (c: Color) => void }) {
  return (
    <div className="picker" role="radiogroup" aria-label="色">
      {COLORS.map((c) => (
        <button key={c} type="button" className="swatch" role="radio" aria-checked={value === c} aria-label={c} style={{ background: colorVar(c) }} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}

export function Avatar({ member, size }: { member: Pick<Member, 'name' | 'color'> | undefined; size?: 'sm' | 'lg' }) {
  return (
    <span className={`avatar ${size ?? ''}`} style={{ background: colorVar(member?.color) }} aria-hidden="true">
      {member ? Array.from(member.name)[0] : '?'}
    </span>
  );
}

export function MemberPicker({ members, value, onChange, multiple }: { members: Member[]; value: string[]; onChange: (ids: string[]) => void; multiple?: boolean }) {
  return (
    <div className="chips" role="group">
      {!multiple && (
        <button type="button" className="chip" aria-pressed={value.length === 0} onClick={() => onChange([])}>
          未定
        </button>
      )}
      {members.map((m) => {
        const on = value.includes(m.id);
        return (
          <button
            key={m.id}
            type="button"
            className="chip"
            aria-pressed={on}
            onClick={() => onChange(multiple ? (on ? value.filter((v) => v !== m.id) : [...value, m.id]) : [m.id])}
          >
            <Avatar member={m} size="sm" />
            {m.name}
          </button>
        );
      })}
    </div>
  );
}

export function EmptyState({ icon, title, hint }: { icon: IconName; title: string; hint?: string }) {
  return (
    <div className="empty">
      <Icon name={icon} />
      <p>
        <strong>{title}</strong>
      </p>
      {hint && <p className="small">{hint}</p>}
    </div>
  );
}

export function Fab({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="fab" onClick={onClick}>
      <Icon name="plus" />
      {label}
    </button>
  );
}

/** zod エラーなどを利用者向けの文に */
export function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'issues' in e) {
    const issue = (e as { issues: { message: string; code?: string }[] }).issues[0];
    if (issue?.code === 'too_big') return '文字数が多すぎます';
    if (issue?.code === 'too_small') return '入力してください';
    return issue?.message ?? '入力内容を確認してください';
  }
  return '保存できませんでした';
}

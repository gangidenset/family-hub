import { PageHeader } from '../../components/ui';

export function Legal({ doc }: { doc: 'terms' | 'privacy' }) {
  return (
    <>
      <PageHeader title={doc === 'terms' ? '利用規約' : 'プライバシーポリシー'} back="/settings" />
      <iframe
        src={`./legal/${doc}.html`}
        title={doc === 'terms' ? '利用規約' : 'プライバシーポリシー'}
        style={{ border: 0, width: '100%', flex: 1, minHeight: 'calc(100dvh - 64px)', background: 'var(--surface)' }}
        sandbox=""
      />
    </>
  );
}

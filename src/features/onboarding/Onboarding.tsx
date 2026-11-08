import { useState } from 'react';
import type { FamilyDB } from '../../db/db';
import { createGroup } from '../../db/group';
import type { Color } from '../../domain/schemas';
import { ColorPicker, errorMessage, Field } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { guessDeviceName } from '../../lib/device';
import { ConnectFlow } from '../sync/Connect';
import { navigate } from '../../app/router';

type Step = 'welcome' | 'create' | 'join';

export function Onboarding({ db, onDone }: { db: FamilyDB; onDone: () => Promise<void> }) {
  const [step, setStep] = useState<Step>('welcome');

  if (step === 'create') return <CreateGroup db={db} onBack={() => setStep('welcome')} onDone={onDone} />;
  if (step === 'join') {
    return (
      <div className="app">
        <ConnectFlow
          db={db}
          session={null}
          mode="pair"
          role="guest"
          onExit={() => setStep('welcome')}
          onFinished={async () => {
            navigate('/', { replace: true });
            await onDone();
          }}
        />
      </div>
    );
  }
  return (
    <main className="welcome">
      <img className="logo" src="./icons/icon-192.png" alt="" />
      <div>
        <h1>FamilyHub へようこそ</h1>
        <p className="muted">家族の買い物・予定・タスク・メモを、家族のスマホの中だけで共有します。</p>
      </div>
      <ul className="points">
        <li>
          <Icon name="shield" />
          <span>アカウント登録は不要。データは外部サーバーに送られません。</span>
        </li>
        <li>
          <Icon name="wifiOff" />
          <span>インターネットがなくても使えます。</span>
        </li>
        <li>
          <Icon name="qr" />
          <span>家族の端末とは QR コードでつながり、同じ Wi-Fi で直接同期します。</span>
        </li>
      </ul>
      <div className="stack">
        <button className="btn primary block" onClick={() => setStep('create')}>
          家族グループを作る
        </button>
        <button className="btn block" onClick={() => setStep('join')}>
          家族のグループに参加する
        </button>
        <p className="small muted center">
          家族の誰かが先にグループを作っている場合は「参加する」を選んでください。
          <br />
          <a href="./legal/terms.html" target="_blank" rel="noopener noreferrer">
            利用規約
          </a>
          ・
          <a href="./legal/privacy.html" target="_blank" rel="noopener noreferrer">
            プライバシーポリシー
          </a>
        </p>
      </div>
    </main>
  );
}

function CreateGroup({ db, onBack, onDone }: { db: FamilyDB; onBack: () => void; onDone: () => Promise<void> }) {
  const [groupName, setGroupName] = useState('');
  const [memberName, setMemberName] = useState('');
  const [deviceName, setDeviceName] = useState(guessDeviceName());
  const [color, setColor] = useState<Color>('teal');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (!groupName.trim() || !memberName.trim() || !deviceName.trim()) return setError('すべての項目を入力してください');
    setBusy(true);
    try {
      await createGroup(db, { groupName: groupName.trim(), memberName: memberName.trim(), memberColor: color, deviceName: deviceName.trim() });
      navigate('/', { replace: true });
      await onDone();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <main className="welcome">
      <div>
        <button className="btn ghost small" onClick={onBack}>
          <Icon name="back" />
          戻る
        </button>
        <h1>家族グループを作る</h1>
      </div>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="グループ名">
          <input className="input" value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="例: 山田家" maxLength={50} />
        </Field>
        <Field label="あなたの名前 (家族に表示されます)">
          <input className="input" value={memberName} onChange={(e) => setMemberName(e.target.value)} placeholder="例: ママ" maxLength={50} />
        </Field>
        <Field label="あなたの色" group>
          <ColorPicker value={color} onChange={setColor} />
        </Field>
        <Field label="この端末の名前">
          <input className="input" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} maxLength={50} />
        </Field>
        {error && <p className="error-text">{error}</p>}
        <button className="btn primary block" type="submit" disabled={busy}>
          はじめる
        </button>
      </form>
    </main>
  );
}

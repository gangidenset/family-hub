// 2 つの独立したブラウザコンテキスト (= 別々の端末相当。ストレージは共有しない) で
// ペアリング・同期・同時編集・失敗からの復旧を検証する。
// 接続コードの受け渡しは QR の代わりに「コードを貼り付け」機能を使う (ヘッドレス環境にカメラがないため)。
import { expect, test, type Browser, type Page } from '@playwright/test';
import { addShoppingItem, createGroup } from './helpers';

async function newDevice(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, locale: 'ja-JP' });
  return ctx.newPage();
}

async function readCode(page: Page): Promise<string> {
  await page.getByText('カメラが使えない場合 (コードで共有)').click();
  const code = await page.getByTestId('code-text').inputValue();
  expect(code).toMatch(/^FH1:/);
  return code;
}

async function pasteCode(page: Page, code: string) {
  // ヘッドレス環境にはカメラがないため「カメラを使えません」表示 (貼り付け欄が開いた状態) になるのを待つ
  await expect(page.getByText(/カメラを使えません/)).toBeVisible();
  const input = page.getByTestId('code-input');
  await input.fill(code);
  await page.getByRole('button', { name: 'このコードで接続' }).click();
}

/** host 側で QR を表示し guest が読み取る、の一連の受け渡し */
async function exchange(host: Page, guest: Page) {
  const offer = await readCode(host);
  await pasteCode(guest, offer);
  const answer = await readCode(guest);
  await host.getByRole('button', { name: '次へ: 相手の QR を読み取る' }).click();
  await pasteCode(host, answer);
  return { offer, answer };
}

async function pair(a: Page, b: Page) {
  await a.goto('/#/members');
  await a.getByRole('button', { name: '端末を追加' }).click();
  await b.goto('/');
  await b.getByRole('button', { name: '家族のグループに参加する' }).click();
  await exchange(a, b);
  const sasA = await a.getByTestId('sas').innerText();
  const sasB = await b.getByTestId('sas').innerText();
  expect(sasA).toMatch(/^\d{3} \d{3}$/);
  expect(sasA).toBe(sasB);
  await a.getByRole('button', { name: '一致している' }).click();
  await b.getByRole('button', { name: '一致している' }).click();
  await expect(b.getByText('「テスト家」に参加します')).toBeVisible();
  await b.getByLabel('あなたの名前').fill('パパ');
  await b.getByLabel('この端末の名前').fill('パパのスマホ');
  await b.getByRole('button', { name: '参加する' }).click();
  await expect(a.getByTestId('sync-done')).toBeVisible();
  await expect(b.getByTestId('sync-done')).toBeVisible();
  await b.getByRole('button', { name: 'はじめる' }).click();
  await a.getByRole('button', { name: '完了' }).click();
  await expect(a).toHaveURL(/#\/members$/);
  await expect(b.getByText(/パパさん/)).toBeVisible();
}

async function sync(host: Page, guest: Page) {
  await host.goto('/#/sync');
  await host.getByRole('button', { name: 'QR を表示' }).click();
  await guest.goto('/#/sync');
  await guest.getByRole('button', { name: 'QR を読み取る' }).click();
  const r = await exchange(host, guest);
  await expect(host.getByTestId('sync-done')).toBeVisible({ timeout: 30_000 });
  await expect(guest.getByTestId('sync-done')).toBeVisible({ timeout: 30_000 });
  await host.getByRole('button', { name: '完了' }).click();
  await guest.getByRole('button', { name: '完了' }).click();
  await expect(host).toHaveURL(/#\/$/);
  await expect(guest).toHaveURL(/#\/$/);
  return r;
}

test('ペアリング → 双方向同期 → 同時編集の収束 → 失敗からの復旧', async ({ browser }) => {
  test.setTimeout(180_000);
  const a = await newDevice(browser);
  const b = await newDevice(browser);

  await createGroup(a);
  await addShoppingItem(a, '卵');
  await pair(a, b);

  // B に A のデータが届いている
  await b.goto('/#/shopping');
  await expect(b.getByRole('button', { name: '卵', exact: true })).toBeVisible();
  await b.goto('/#/members');
  await expect(b.getByRole('button', { name: /^ママ/ })).toBeVisible();
  await expect(b.getByRole('button', { name: /^パパ/ })).toBeVisible();

  // 両端末でオフラインのまま別々に編集 (同一項目の別フィールド + それぞれ新規追加)
  await a.context().setOffline(true);
  await b.context().setOffline(true);
  await a.goto('/#/shopping');
  await a.getByRole('button', { name: '卵', exact: true }).click();
  await a.getByRole('textbox', { name: '数量' }).fill('2');
  await a.getByRole('button', { name: '保存' }).click();
  await b.goto('/#/shopping');
  await b.getByRole('button', { name: '卵', exact: true }).click();
  await b.getByLabel('メモ').fill('Lサイズ');
  await b.getByRole('button', { name: '保存' }).click();
  await addShoppingItem(a, 'パン');
  await addShoppingItem(b, 'バナナ');
  await expect(a.getByRole('link', { name: /未送信/ })).toBeVisible();

  // 同期 (オフラインのまま: 同一マシン内の P2P 通信はネットワーク切断の影響を受けない想定ではないため、ここではオンラインに戻す)
  await a.context().setOffline(false);
  await b.context().setOffline(false);
  await sync(a, b);

  for (const p of [a, b]) {
    await p.goto('/#/shopping');
    await expect(p.getByRole('button', { name: 'パン', exact: true })).toBeVisible();
    await expect(p.getByRole('button', { name: 'バナナ', exact: true })).toBeVisible();
    await expect(p.getByRole('button', { name: /^卵 × 2/ })).toBeVisible();
    await expect(p.getByText('Lサイズ')).toBeVisible();
  }

  // メモ本文の同時編集 → 競合として両方の内容を保持
  await a.goto('/#/memos/new');
  await a.getByLabel('タイトル').fill('持ち物');
  await a.getByLabel('本文').fill('体操服');
  await expect(a.getByText('保存しました')).toBeVisible();
  await sync(a, b);
  await b.goto('/#/memos');
  await b.getByRole('link', { name: /持ち物/ }).click();
  await b.getByLabel('本文').fill('体操服、水筒');
  await expect(b.getByText('保存しました')).toBeVisible();
  await a.goto('/#/memos');
  await a.getByRole('link', { name: /持ち物/ }).click();
  await a.getByLabel('本文').fill('体操服、上履き');
  await expect(a.getByText('保存しました')).toBeVisible();
  await b.goto('/#/');
  await a.goto('/#/');
  await sync(b, a);
  await a.goto('/#/memos');
  await expect(a.getByText('競合あり')).toBeVisible();
  await a.getByRole('link', { name: /持ち物/ }).click();
  await expect(a.getByText(/同時に「本文」が編集されました/)).toBeVisible();
  const bodyA = await a.getByLabel('本文').inputValue();
  await b.goto('/#/memos');
  await b.getByRole('link', { name: /持ち物/ }).click();
  expect(await b.getByLabel('本文').inputValue()).toBe(bodyA);
  await a.getByRole('button', { name: '現在の内容のまま' }).click();
  await expect(a.getByText(/同時に「本文」が編集されました/)).toHaveCount(0);

  // 失敗ケース 1: 接続コードではない文字列
  await b.goto('/#/sync');
  await b.getByRole('button', { name: 'QR を読み取る' }).click();
  await pasteCode(b, 'https://example.com/not-a-code');
  await expect(b.getByText(/FamilyHub の接続コードではありません/)).toBeVisible();

  // 失敗ケース 2: 古い (使用済みの) 応答コード → 接続できずタイムアウト → 再試行で成功
  await a.goto('/#/');
  await addShoppingItem(a, '牛乳');
  await a.goto('/#/sync');
  await a.getByRole('button', { name: 'QR を表示' }).click();
  await b.goto('/#/sync');
  await b.getByRole('button', { name: 'QR を読み取る' }).click();
  const offer = await readCode(a);
  await pasteCode(b, offer);
  await readCode(b);
  // B の画面を閉じて相手がいなくなった状態で、A に別の (無関係な) 応答を読ませる
  const stale = await newDevice(browser);
  await createGroup(stale, { group: '他人の家' });
  await stale.goto('/#/sync');
  await b.goto('/#/');
  await a.getByRole('button', { name: '次へ: 相手の QR を読み取る' }).click();
  await pasteCode(a, offer.replace(/.$/, offer.endsWith('A') ? 'B' : 'A'));
  // offer を応答として読ませると拒否される
  await expect(a.getByText(/2 枚目/)).toBeVisible();
  await a.goto('/#/');
  await sync(a, b);
  await b.goto('/#/shopping');
  await expect(b.getByRole('button', { name: '牛乳', exact: true })).toBeVisible();
  const peers = await b.goto('/#/sync').then(() => b.getByText('同期の履歴'));
  await expect(peers).toBeVisible();
});

test('接続タイムアウト時はエラーと代替手段 (ファイル同期) を案内し、ファイルで同期できる', async ({ browser }) => {
  test.setTimeout(180_000);
  const a = await newDevice(browser);
  const b = await newDevice(browser);
  await createGroup(a);
  await pair(a, b);
  await addShoppingItem(a, 'りんご');

  // B が応答コードを出した後に B を閉じる → A は接続できずタイムアウト
  await a.goto('/#/sync');
  await a.getByRole('button', { name: 'QR を表示' }).click();
  await b.goto('/#/sync');
  await b.getByRole('button', { name: 'QR を読み取る' }).click();
  const offer = await readCode(a);
  await pasteCode(b, offer);
  const answer = await readCode(b);
  await b.goto('/#/'); // 接続相手がいなくなる
  await a.getByRole('button', { name: '次へ: 相手の QR を読み取る' }).click();
  await pasteCode(a, answer);
  await expect(a.getByTestId('sync-error')).toBeVisible({ timeout: 60_000 });
  await expect(a.getByText(/同じ Wi-Fi/)).toBeVisible();

  // 代替: 暗号化ファイルで同期
  await a.getByRole('button', { name: 'ファイルで同期する' }).click();
  const download = a.waitForEvent('download');
  await a.getByRole('button', { name: 'ファイルを送る' }).click();
  const file = await (await download).path();
  await b.goto('/#/sync');
  await b.getByTestId('sync-file-input').setInputFiles(file);
  await expect(b.getByText(/件の変更を取り込みました/)).toBeVisible();
  await b.goto('/#/shopping');
  await expect(b.getByRole('button', { name: 'りんご', exact: true })).toBeVisible();
});

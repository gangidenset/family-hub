import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addShoppingItem, createGroup } from './helpers';

test('インターネットなしで起動し、データ登録・再起動後の保持ができる', async ({ page, context }) => {
  await createGroup(page);
  await addShoppingItem(page, 'オンライン時の商品');
  // Service Worker がインストールされ、ページを制御するまで待つ
  expect(await page.evaluate(async () => !!(await navigator.serviceWorker.ready).active)).toBe(true);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  await context.setOffline(true);
  // 完全な再読み込み (アプリの再起動相当)
  await page.goto('/');
  await page.reload();
  await expect(page.getByText(/おはようございます|こんにちは|こんばんは/)).toBeVisible();
  await addShoppingItem(page, 'オフラインで追加');
  await page.reload();
  await page.goto('/#/shopping');
  await expect(page.getByRole('button', { name: 'オフラインで追加', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'オンライン時の商品', exact: true })).toBeVisible();
  // 法務ページもオフラインで表示できる
  await page.goto('/legal/privacy.html');
  await expect(page.getByRole('heading', { name: 'プライバシーポリシー' })).toBeVisible();
});

test('外部への通信が発生しない (CSP とリクエスト監視)', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['localhost', '127.0.0.1'].includes(u.hostname) && !u.protocol.startsWith('data') && !u.protocol.startsWith('blob')) external.push(r.url());
  });
  await createGroup(page);
  await addShoppingItem(page, 'テスト');
  for (const p of ['/#/calendar', '/#/tasks', '/#/memos', '/#/settings', '/#/members', '/#/sync']) await page.goto(p);
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("script-src 'self'");
  expect(external).toEqual([]);
});

test('バックアップ → 全削除 → 復元、不正ファイルの拒否', async ({ page }) => {
  // ASCII 以外を含むパスだと setInputFiles が失敗する環境があるため、一時ディレクトリを使う
  const dir = await mkdtemp(join(tmpdir(), 'fh-backup-'));
  const out = (name: string) => join(dir, name);
  await createGroup(page);
  await addShoppingItem(page, 'バックアップ対象');
  await page.goto('/#/settings/backup');

  // パスフレーズ暗号化バックアップを書き出す
  await page.getByLabel('パスフレーズ (8 文字以上)').fill('family-pass-123');
  await page.getByLabel('パスフレーズ (確認)').fill('family-pass-123');
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: '書き出す' }).click();
  const encPath = out('backup-enc.json');
  await (await dl).saveAs(encPath);
  expect(await readFile(encPath, 'utf8')).not.toContain('バックアップ対象');

  // 平文バックアップも書き出す
  await page.getByRole('switch', { name: 'パスフレーズで暗号化する (おすすめ)' }).uncheck();
  const dl2 = page.waitForEvent('download');
  await page.getByRole('button', { name: '書き出す' }).click();
  const plainPath = out('backup-plain.json');
  await (await dl2).saveAs(plainPath);

  // 不正なバックアップファイル
  const bad = out('bad.json');
  await writeFile(bad, '{"format":"familyhub-backup","formatVersion":1}');
  await page.getByTestId('backup-file-input').setInputFiles(bad);
  await expect(page.getByRole('alert')).toContainText('バックアップファイルではない');
  const tampered = out('tampered.json');
  await writeFile(tampered, (await readFile(plainPath, 'utf8')).replace('バックアップ対象', '改ざんされた'));
  await page.getByTestId('backup-file-input').setInputFiles(tampered);
  await expect(page.getByRole('alert')).toContainText('書き換えられています');
  await expect(page.getByTestId('restore-preview')).toHaveCount(0);

  // 全削除
  await page.getByLabel(/確認のため、グループ名/).fill('テスト家');
  await page.getByRole('button', { name: 'すべて削除する' }).click();
  await page.getByRole('button', { name: 'すべて削除', exact: true }).click();
  await expect(page.getByRole('button', { name: '家族グループを作る' })).toBeVisible();

  // オンボーディングから暗号化バックアップを復元 (誤ったパスフレーズ → 正しいパスフレーズ)
  await page.getByRole('button', { name: 'バックアップから復元する' }).click();
  await page.getByTestId('backup-file-input').setInputFiles(encPath);
  await expect(page.getByRole('alert')).toContainText('パスフレーズで保護');
  await page.getByLabel('パスフレーズ').fill('wrong-pass');
  await page.getByRole('button', { name: '開く' }).click();
  await expect(page.getByRole('alert')).toContainText('パスフレーズが違います');
  await page.getByLabel('パスフレーズ').fill('family-pass-123');
  await page.getByRole('button', { name: '開く' }).click();
  await expect(page.getByTestId('restore-preview')).toContainText('同期用の鍵: 含む');
  await page.getByRole('button', { name: 'この内容で復元する' }).click();
  await page.getByRole('button', { name: '復元する', exact: true }).click();
  await expect(page.getByText(/こんにちは|おはようございます|こんばんは/)).toBeVisible();
  await page.goto('/#/shopping');
  await expect(page.getByRole('button', { name: 'バックアップ対象', exact: true })).toBeVisible();
});

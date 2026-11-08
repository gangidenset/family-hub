import { expect, test } from '@playwright/test';
import { addShoppingItem, createGroup } from './helpers';

test('グループ作成 → 各機能でデータ登録 → 再起動後もデータが残る', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await createGroup(page);

  // 買い物
  await addShoppingItem(page, '牛乳');
  await page.getByRole('checkbox', { name: '牛乳 を購入済みにする' }).click();
  await expect(page.getByText('購入済み (1)')).toBeVisible();

  // タスク
  await page.getByRole('link', { name: 'タスク' }).click();
  await page.getByRole('button', { name: 'タスク', exact: true }).click();
  await page.getByLabel('タスク', { exact: true }).fill('ゴミ出し');
  await page.getByRole('button', { name: '明日' }).click();
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('button', { name: /ゴミ出し/ })).toBeVisible();

  // 予定
  await page.getByRole('link', { name: '予定' }).click();
  await page.getByRole('button', { name: '予定', exact: true }).click();
  await page.getByLabel('タイトル').fill('保護者会');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('button', { name: /保護者会/ })).toBeVisible();

  // メモ (自動保存)
  await page.getByRole('link', { name: 'メモ' }).click();
  await page.getByRole('button', { name: 'メモ', exact: true }).click();
  await page.getByLabel('タイトル').fill('Wi-Fi');
  await page.getByLabel('本文').fill('SSID: home-net');
  await expect(page.getByText('保存しました')).toBeVisible();
  await page.getByRole('button', { name: 'ピン留めする' }).click();
  await expect(page.getByRole('button', { name: 'ピン留めを外す' })).toHaveAttribute('aria-pressed', 'true');

  // 再読み込み (アプリ再起動相当) 後も残っている
  await page.goto('/');
  await page.reload();
  await expect(page.getByText('ゴミ出し')).toBeVisible();
  await expect(page.getByText('Wi-Fi')).toBeVisible();
  await page.goto('/#/shopping');
  await expect(page.getByText('購入済み (1)')).toBeVisible();
  await page.goto('/#/shopping/history');
  await expect(page.getByText('牛乳')).toBeVisible();

  expect(errors).toEqual([]);
});

test('ダークモードと文字サイズの切り替え', async ({ page }) => {
  await createGroup(page);
  await page.goto('/#/settings');
  await page.getByRole('button', { name: 'ダーク', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '特大', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-font', 'xlarge');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('XSS: 入力した HTML はテキストとして表示される', async ({ page }) => {
  let dialog = false;
  page.on('dialog', async (d) => {
    dialog = true;
    await d.dismiss();
  });
  await createGroup(page);
  await addShoppingItem(page, '<img src=x onerror=alert(1)>');
  await expect(page.getByText('<img src=x onerror=alert(1)>')).toBeVisible();
  expect(await page.locator('main img[src="x"]').count()).toBe(0);
  expect(dialog).toBe(false);
});

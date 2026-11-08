import { expect, type Page } from '@playwright/test';

export async function createGroup(page: Page, opts: { group?: string; name?: string; device?: string } = {}) {
  await page.goto('/');
  await page.getByRole('button', { name: '家族グループを作る' }).click();
  await page.getByLabel('グループ名').fill(opts.group ?? 'テスト家');
  await page.getByLabel('あなたの名前 (家族に表示されます)').fill(opts.name ?? 'ママ');
  await page.getByLabel('この端末の名前').fill(opts.device ?? 'ママのスマホ');
  await page.getByRole('button', { name: 'はじめる' }).click();
  await expect(page.getByText(/おはようございます|こんにちは|こんばんは/)).toBeVisible();
}

export async function addShoppingItem(page: Page, name: string) {
  await page.goto('/#/shopping');
  await page.getByRole('button', { name: '追加', exact: true }).click();
  await page.getByLabel('商品名').fill(name);
  await page.getByRole('button', { name: '追加して閉じる' }).click();
  await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
}

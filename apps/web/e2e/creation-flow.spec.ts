import { expect, test } from '@playwright/test';

test('create → live progress → preview → export mp4 → revisit', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '绘本工坊' })).toBeVisible();
  await page.getByLabel('故事主题').fill('小恐龙学飞');
  await page.getByRole('button', { name: '开始创作' }).click();
  await expect(page).toHaveURL(/\/book\//);

  // Fake Provider 下管线秒级完成；等待预览画布与页码指示出现（e2e 用 3 页小书）
  await expect(page.getByLabel('绘本预览画布')).toBeVisible({ timeout: 60_000 });
  // e2e 用 3 正文页小书，加上片头幕共 4 页
  await expect(page.getByText(/\/ 4/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('option')).toHaveCount(4);

  // 单语模式：语言切换已隐藏
  await expect(page.getByRole('button', { name: 'English' })).toHaveCount(0);

  // 单页重画可用且给出剩余次数
  await page.getByRole('button', { name: '重画这一页' }).click();
  await expect(page.getByText(/本页还可重画/)).toBeVisible({ timeout: 60_000 });

  // 导出视频（e2e 以 320x180@10fps 的小书几秒完成，exporting 状态转瞬即逝，
  // 直接等待持久出现的下载链接）
  await page.getByRole('button', { name: '导出视频' }).click();
  await expect(page.getByRole('link', { name: '下载视频' })).toBeVisible({ timeout: 240_000 });

  // 刷新回访：凭 URL 重新加载同一本绘本
  await page.reload();
  await expect(page.getByRole('link', { name: '下载视频' })).toBeVisible({ timeout: 60_000 });
});

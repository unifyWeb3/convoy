import { expect, test } from '@playwright/test';

const runId = process.env['CONVOY_E2E_RUN_ID'] ?? '00000000-0000-4000-8000-000000000003';

test('refresh replays the full timeline', async ({ page }) => {
  await page.goto(`/runs/${runId}`);
  const rows = page.getByRole('listitem');
  await expect(rows.first()).toBeVisible();
  const before = await rows.count();
  await page.reload();
  await expect(page.getByRole('listitem')).toHaveCount(before);
});

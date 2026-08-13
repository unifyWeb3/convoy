import { expect, test } from '@playwright/test';

const runId = process.env['CONVOY_E2E_RUN_ID'];

test('Run Board keyboard navigation and audit drawer focus remain contained', async ({ page }) => {
  test.skip(runId === undefined, 'CONVOY_E2E_RUN_ID is required for a real run');
  if (runId === undefined) return;

  await page.goto(`/runs/${runId}`);

  const rows = page.locator('[aria-label="Run items"] [role="listitem"]');
  const openerRow = rows.filter({ hasText: 'Landed on Base Sepolia' }).first();
  const opener = openerRow.getByRole('button');
  await expect(openerRow).toBeVisible();
  await opener.focus();
  await expect(opener).toBeFocused();
  await opener.press('Enter');

  const dialog = page.getByRole('dialog', { name: /Audit for item/ });
  const close = dialog.getByRole('button', { name: 'Close audit drawer' });
  await expect(dialog).toBeVisible();
  await expect(close).toBeFocused();

  const focusables = dialog.locator(
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  const focusableCount = await focusables.count();
  expect(focusableCount).toBeGreaterThan(0);
  await focusables.first().focus();
  await page.keyboard.press('Shift+Tab');
  await expect(focusables.nth(focusableCount - 1)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(focusables.first()).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();

  const tabs = page.getByRole('tablist', { name: 'Run views' }).getByRole('tab');
  await expect(tabs).toHaveCount(3);
  await tabs.nth(0).focus();
  await tabs.nth(0).press('ArrowRight');
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'run-tab-dag');
  await expect(page.getByTestId('dag-canvas')).toBeVisible();

  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(2)).toBeFocused();
  await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(0)).toBeFocused();
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
});

test('Run Board keeps mobile proof and state surfaces readable', async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(runId === undefined, 'CONVOY_E2E_RUN_ID is required for a real run');
  if (runId === undefined) return;

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new DOMException('Write permission denied.', 'NotAllowedError');
        },
      },
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/runs/${runId}`, { waitUntil: 'domcontentloaded' });

  const tally = page
    .getByRole('heading', { name: 'Action tally' })
    .locator('xpath=ancestor::section[1]');
  const tallyGrid = tally.locator('dl').first();
  const skippedCell = tally.getByText('Skipped', { exact: true }).locator('..');
  const [gridBox, skippedBox] = await Promise.all([
    tallyGrid.boundingBox(),
    skippedCell.boundingBox(),
  ]);
  expect(gridBox).not.toBeNull();
  expect(skippedBox).not.toBeNull();
  expect(skippedBox!.width).toBeGreaterThan(gridBox!.width * 0.9);

  await page.getByRole('tab', { name: 'Dependency DAG' }).click();
  const dependencyRows = page
    .getByRole('heading', { name: 'Dependency list' })
    .locator('xpath=ancestor::section[1]')
    .locator('ol > li');
  await expect(dependencyRows.first()).toBeVisible();
  for (let index = 0; index < (await dependencyRows.count()); index += 1) {
    await expect(dependencyRows.nth(index).locator('.convoy-state-chip:visible')).toHaveCount(1);
  }

  await page.getByRole('tab', { name: 'Proof manifest' }).click();
  await expect(page.getByText('Canonical SHA-256')).toBeVisible({ timeout: 120_000 });
  const table = page.locator('table').first();
  await expect(table).toBeVisible();
  expect(
    await table.evaluate((element) => {
      const wrapper = element.parentElement;
      return wrapper !== null && wrapper.scrollWidth > wrapper.clientWidth;
    }),
  ).toBe(true);

  await page.getByRole('button', { name: 'Copy JSON' }).click();
  await expect(page.getByText('Copy unavailable. Use Download JSON.')).toBeVisible();
  await expect(
    page.getByText(/Failed to execute|DOMException|Write permission denied/i),
  ).toHaveCount(0);
});

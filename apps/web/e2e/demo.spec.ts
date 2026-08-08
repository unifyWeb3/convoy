import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const runId = process.env['CONVOY_E2E_RUN_ID'];
const evidenceDir = process.env['GATE2_EVIDENCE_DIR'] ?? '/tmp/convoy-gate2-evidence';

test('CVY-GATE2 12-item run, live DAG, refresh and manifest', async ({ page }) => {
  test.skip(runId === undefined, 'CONVOY_E2E_RUN_ID is required for the real gate run');
  test.setTimeout(600_000);
  mkdirSync(evidenceDir, { recursive: true });

  await page.goto(`/runs/${runId}`);
  const rows = page.locator('[aria-label="Run items"] [role="listitem"]');
  await expect(rows).toHaveCount(12);

  const terminal = page
    .getByText('SEALED OK', { exact: true })
    .or(page.getByText('SEALED PARTIAL', { exact: true }))
    .first();
  if (process.env['GATE2_FINAL_ONLY'] !== '1' && (await terminal.count()) === 0) {
    await page.getByRole('button', { name: 'Dependency DAG' }).click();
    await expect(page.getByTestId('dag-canvas')).toBeVisible();
    await expect(page.locator('.react-flow__node')).toHaveCount(12);
    await expect(page.locator('.react-flow__edge')).toHaveCount(7);
    await expect(page.locator('.convoy-edge-deferred').first()).toBeVisible({ timeout: 240_000 });
    await page.screenshot({ path: `${evidenceDir}/dag-deferred.png`, fullPage: true });

    await page.getByRole('button', { name: 'Actions & timeline' }).click();
    await expect(page.getByText('Landed on Base Sepolia').first()).toBeVisible({
      timeout: 240_000,
    });
    await expect(terminal).toHaveCount(0);
    const countBeforeRefresh = await rows.count();
    await page.reload();
    await expect(page.locator('[aria-label="Run items"] [role="listitem"]')).toHaveCount(
      countBeforeRefresh,
    );
    await expect(page.getByText('Execution timeline')).toBeVisible();
    await page.screenshot({ path: `${evidenceDir}/timeline-refresh.png`, fullPage: true });
  }

  await expect(terminal).toBeVisible({ timeout: 360_000 });
  await expect(rows.filter({ hasText: 'Landed on Base Sepolia' })).toHaveCount(10);
  await expect(rows.filter({ hasText: 'Stopped before execution' })).toHaveCount(2);
  await expect(page.getByText('MarketAlreadyEnabled').first()).toBeVisible();
  await expect(page.getByText('RootAlreadySet').first()).toBeVisible();

  await page.getByRole('button', { name: 'Dependency DAG' }).click();
  await expect(page.locator('.convoy-edge-ready')).toHaveCount(7);
  await page.screenshot({ path: `${evidenceDir}/dag-final.png`, fullPage: true });

  await page.getByRole('button', { name: 'Proof manifest' }).click();
  await page.getByRole('button', { name: 'Copy JSON' }).click();
  await expect(page.getByText('Canonical SHA-256')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('tbody tr')).toHaveCount(12, { timeout: 120_000 });
  await expect(page.getByText('AMBER')).toHaveCount(12);
  // The current registry-provider error embeds the configured RPC URL (G-42).
  // Keep the browser proof useful without persisting that credential in the
  // screenshot; the raw manifest itself remains the canonical local artifact.
  await page.screenshot({
    path: `${evidenceDir}/manifest.png`,
    fullPage: true,
    mask: [page.locator('tbody td:nth-child(3)')],
  });
});

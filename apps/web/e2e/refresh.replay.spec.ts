import { expect, test } from '@playwright/test';

const runId = process.env['CONVOY_E2E_RUN_ID'] ?? '00000000-0000-4000-8000-000000000003';

test('refresh replays the database history and keeps streaming for later events', async ({
  page,
}) => {
  await page.goto(`/runs/${runId}`);
  const rows = page.getByRole('listitem');
  await expect(rows.first()).toBeVisible();

  const replay = await page.evaluate(
    (id) =>
      new Promise<{ id: string; type: string; readyState: number }>((resolve, reject) => {
        const source = new EventSource(`/api/runs/${encodeURIComponent(id)}/stream`);
        const timer = window.setTimeout(() => {
          source.close();
          reject(new Error('SSE replay did not arrive'));
        }, 5_000);
        source.addEventListener(
          'convoy',
          (message) => {
            window.clearTimeout(timer);
            const event = message as MessageEvent<string>;
            window.setTimeout(() => {
              resolve({
                id: event.lastEventId,
                type: JSON.parse(event.data).type,
                readyState: source.readyState,
              });
              source.close();
            }, 750);
          },
          { once: true },
        );
        source.addEventListener(
          'error',
          () => {
            window.clearTimeout(timer);
            source.close();
            reject(new Error('SSE stream closed before continued streaming was observed'));
          },
          { once: true },
        );
      }),
    runId,
  );
  expect(replay.id).not.toBe('');
  expect(replay.type).toBe('RUN_RECEIVED');
  expect(replay.readyState).toBe(1);

  const before = await rows.count();
  await page.reload();
  await expect(page.getByRole('listitem')).toHaveCount(before);
  await expect(page.getByText('Execution timeline')).toBeVisible();
});

import { expect, test } from '@e2e-orchestrator/playwright';

test('checkout survives faults', async ({ page, argusFault }) => {
  await page.goto('/');
  await page.getByTestId('checkout').click();
  const gracefulFailure = argusFault && ['timeout', '5xx', 'reset'].includes(argusFault.type);
  if (gracefulFailure) {
    await expect(page.getByTestId('checkout-error')).toBeVisible();
  } else {
    await expect(page.getByTestId('checkout-ok')).toBeVisible();
  }
});

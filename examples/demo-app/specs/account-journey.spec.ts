import { expect, grab, test } from '@e2e-orchestrator/playwright';

test('open and delete the seeded account', async ({ page }) => {
  const seed = await grab('create-accounts');
  await page.goto('/');
  const link = page.getByRole('link', { name: 'alice' });
  await expect(link).toHaveAttribute('href', `/accounts/${String(seed.account_id)}`);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/accounts/${String(seed.account_id)}$`));
  await page.getByTestId('delete-account').click();
  await expect(page).toHaveURL(/\/$/);
  // Let the redirect settle so teardown trace finalization has a quiet network.
  await page.waitForLoadState('networkidle');
});

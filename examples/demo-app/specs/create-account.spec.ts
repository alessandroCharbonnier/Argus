import { expect, publish, test } from '@e2e-orchestrator/playwright';

test('create an account and publish it', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Name').fill('alice');
  await page.getByTestId('create-account').click();
  await expect(page).toHaveURL(/\/accounts\/\d+$/);
  const id = new URL(page.url()).pathname.split('/').pop();
  const email = await page.locator('p').first().textContent();
  await publish({ account_id: id, account_email: email ?? '' });
});

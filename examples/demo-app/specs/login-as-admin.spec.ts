import path from 'node:path';
import { test } from '@e2e-orchestrator/playwright';

// The crawler runs this spec first, then boots a context with the saved
// storage state and inventories every clickable control on the declared URLs.
test('save a session for the crawler', async ({ page }) => {
  await page.goto('/');
  await page
    .context()
    .storageState({ path: path.join(process.env.ARTIFACTS_DIR ?? '.', 'session.json') });
});

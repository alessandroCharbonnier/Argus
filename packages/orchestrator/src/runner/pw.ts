import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Resolve the `@playwright/test` CLI entry (its `bin.playwright`) from the
 * user's project so the spawned runner matches their installed Playwright
 * version. The package's `exports` map hides `./cli.js`, so we resolve the
 * package root and read `bin` from its package.json. Spawning `node <cli.js>`
 * avoids Windows `.cmd` spawn restrictions entirely.
 */
export function resolvePlaywrightCli(projectRoot: string): string {
  const req = createRequire(path.join(projectRoot, 'package.json'));
  let entry: string;
  try {
    entry = req.resolve('@playwright/test');
  } catch {
    entry = createRequire(import.meta.url).resolve('@playwright/test');
  }
  const pkgDir = path.dirname(entry);
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const bin = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin?.['playwright'] ?? 'cli.js');
  return path.join(pkgDir, bin);
}

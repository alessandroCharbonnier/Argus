import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import type { HttpEntry } from './guard/storm.js';
import { resolveUrl } from './http.js';

export interface CrawlControl {
  route: string;
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  testId?: string;
  href?: string;
  url: string;
}

export interface CrawlResult {
  controls: CrawlControl[];
  visited: string[];
}

const COLLECT = `() => {
  const route = new URL(location.href).pathname;
  const out = [];
  const seen = new Set();
  const els = document.querySelectorAll(
    'a[href], button, input, select, textarea, [role="button"], [role="link"], [onclick]'
  );
  for (const el of els) {
    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const name = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || undefined;
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || undefined;
    const href = tag === 'a' ? (el.getAttribute('href') || undefined) : undefined;
    const sig = [route, tag, name || '', testId || '', href || '', text].join('|');
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ route, tag, role: el.getAttribute('role') || undefined, name, text: text || undefined, testId, href, url: location.href });
  }
  return out;
}`;

export async function crawlNode(opts: {
  baseUrl: string;
  urls: string[];
  sitemap?: string;
  storageState?: unknown;
  httpLog: HttpEntry[];
}): Promise<CrawlResult> {
  const browser = await chromium.launch();
  const controls: CrawlControl[] = [];
  const visited = new Set<string>();
  try {
    const context = opts.storageState
      ? await browser.newContext({ storageState: opts.storageState as never })
      : await browser.newContext();
    const urls = [...opts.urls];
    if (opts.sitemap) {
      try {
        const res = await fetch(resolveUrl(opts.sitemap, opts.baseUrl));
        const xml = await res.text();
        for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
          if (m[1] && !urls.includes(m[1])) urls.push(m[1]);
        }
      } catch {
        /* sitemap is best-effort; crawled URLs still count */
      }
    }
    for (const u of urls) {
      const page = await context.newPage();
      page.on('response', (r) => opts.httpLog.push({ status: r.status(), timestamp: Date.now() }));
      try {
        await page.goto(resolveUrl(u, opts.baseUrl), {
          waitUntil: 'networkidle',
          timeout: 30_000,
        });
        // COLLECT is a string so the orchestrator needs no DOM types; invoke it.
        const found = (await page.evaluate(`(${COLLECT})()`)) as CrawlControl[];
        controls.push(...found);
        visited.add(page.url());
      } catch {
        /* a single unreachable route must not sink the crawl */
      }
      await page.close().catch(() => undefined);
    }
    await context.close().catch(() => undefined);
  } finally {
    await browser.close().catch(() => undefined);
  }
  return { controls, visited: [...visited] };
}

export function ensureBlobDir(blobDir: string): void {
  mkdirSync(blobDir, { recursive: true });
}

import {
  chromium,
  defineConfig,
  devices,
  expect,
  firefox,
  request,
  selectors,
  webkit,
  test as base,
} from '@playwright/test';
import type { BrowserContext, Route } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type * from '@playwright/test';
export { chromium, defineConfig, devices, expect, firefox, request, selectors, webkit };

export interface RecordedEvent {
  type: string;
  isTrusted: boolean;
  route: string;
  url: string;
  tag: string;
  name?: string;
  text?: string;
  testId?: string;
  href?: string;
  ts: number;
}

export interface RecordedHttp {
  status?: number;
  error?: string;
  url: string;
  method?: string;
  timestamp: number;
}

export interface RecordedConsole {
  type: string;
  text: string;
  timestamp: number;
}

export interface FaultContext {
  type: string; // 'clean' | 'timeout' | '5xx' | 'reset' | 'latency'
  when: string; // injection point, e.g. 'POST /api/payment'
  pass: number; // sweep index (0 = clean)
}

// Per-process accumulators: one orchestrator node = one spawned spec process.
const events: RecordedEvent[] = [];
const http: RecordedHttp[] = [];
const consoleMessages: RecordedConsole[] = [];
const pageErrors: string[] = [];

function artifactDir(): string | undefined {
  return process.env.ARTIFACTS_DIR;
}

function flush(): void {
  const dir = artifactDir();
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const trusted = events.filter((e) => e.type !== 'heartbeat');
  writeFileSync(path.join(dir, 'recorded.json'), JSON.stringify(trusted));
  writeFileSync(path.join(dir, 'http.json'), JSON.stringify(http));
  writeFileSync(path.join(dir, 'console.json'), JSON.stringify(consoleMessages));
  writeFileSync(path.join(dir, 'pageerrors.json'), JSON.stringify(pageErrors));
  writeFileSync(
    path.join(dir, 'heartbeat.json'),
    JSON.stringify({ heartbeat: true, events: trusted.length, at: Date.now() }),
  );
}

/**
 * Publish node outputs. Merges into `publish.json` in `ARTIFACTS_DIR` — call
 * once per node with all its declared outputs.
 */
export async function publish(outputs: Record<string, unknown>): Promise<void> {
  const dir = artifactDir();
  if (!dir) {
    throw new Error('publish() failed: ARTIFACTS_DIR not set — run under the Argus orchestrator');
  }
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'publish.json');
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    /* first publish */
  }
  writeFileSync(file, JSON.stringify({ ...existing, ...outputs }, null, 2));
}

/**
 * Read a transitive ancestor's published outputs. A non-ancestor is an
 * undeclared edge — a runtime error, not silent staleness.
 */
export async function grab(nodeId: string): Promise<Record<string, unknown>> {
  const dir = artifactDir();
  if (!dir) {
    throw new Error('grab() failed: ARTIFACTS_DIR not set — run under the Argus orchestrator');
  }
  const file = path.join(dir, 'ancestors.json');
  let map: Record<string, string>;
  try {
    map = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
  } catch {
    throw new Error('grab() failed: ancestors.json not found — run under the Argus orchestrator');
  }
  const artifact = map[nodeId];
  if (!artifact) {
    throw new Error(`grab('${nodeId}') failed: not a transitive ancestor — undeclared edge`);
  }
  try {
    return JSON.parse(readFileSync(artifact, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new Error(`grab('${nodeId}') failed: cannot read ancestor artifact at ${artifact}`);
  }
}

async function installRecorder(context: BrowserContext): Promise<void> {
  await context.exposeBinding('__argusRecord', (_source, payload: unknown) => {
    for (const entry of payload as RecordedEvent[]) {
      if (entry && typeof entry === 'object') events.push(entry);
    }
    flush();
  });
  await context.addInitScript(() => {
    const w = window as unknown as { __argusRecord?: (entries: Record<string, unknown>[]) => void };
    const emit = (entry: Record<string, unknown>): void => w.__argusRecord?.([entry]);
    const capture = (event: Event): void => {
      if (!event.isTrusted) return; // synthetic dispatchEvent never counts
      const raw = event.target as HTMLElement | null;
      if (!raw) return;
      // Resolve to the nearest interactive element so clicks on a <span>/<i>
      // inside a <button>/<a> record the SAME tag the crawler enumerates —
      // otherwise `button:` clicks land on the inner span and never match
      // the gate's `button:` denominator. Selector mirrors crawler COLLECT.
      const el =
        (raw.closest(
          'a[href], button, input, select, textarea, [role="button"], [role="link"], [onclick]',
        ) as HTMLElement | null) ?? raw;
      const tag = el.tagName.toLowerCase();
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
      const name =
        el.getAttribute('aria-label') ??
        el.getAttribute('title') ??
        el.getAttribute('placeholder') ??
        undefined;
      const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test') ?? undefined;
      const href = tag === 'a' ? (el.getAttribute('href') ?? undefined) : undefined;
      emit({
        type: event.type,
        isTrusted: event.isTrusted,
        route: new URL(location.href).pathname,
        url: location.href,
        tag,
        name,
        text: text || undefined,
        testId,
        href,
        ts: Date.now(),
      });
    };
    for (const t of ['click', 'input', 'change', 'submit'])
      document.addEventListener(t, capture, true);
    const beat = (): void =>
      emit({
        type: 'heartbeat',
        isTrusted: true,
        route: new URL(location.href).pathname,
        url: location.href,
        tag: 'html',
        ts: Date.now(),
      });
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', beat, { once: true });
    } else {
      beat();
    }
  });
  context.on('response', (r) =>
    http.push({
      status: r.status(),
      url: r.url(),
      method: r.request().method(),
      timestamp: Date.now(),
    }),
  );
  context.on('requestfailed', (r) =>
    http.push({
      error: r.failure()?.errorText ?? 'requestfailed',
      url: r.url(),
      timestamp: Date.now(),
    }),
  );
  context.on('console', (m) =>
    consoleMessages.push({ type: m.type(), text: m.text(), timestamp: Date.now() }),
  );
  context.on('weberror', (e) => pageErrors.push(e.error().message));
}

function currentFault(): FaultContext | null {
  const raw = process.env.ARGUS_FAULT;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { type: string; when: string; pass: number };
    return { type: parsed.type, when: parsed.when, pass: parsed.pass };
  } catch {
    return null;
  }
}

function parseWhen(when: string): { method: string; glob: RegExp } {
  const m = when.match(/^(\S+)\s+(\S.*)$/);
  const method = m ? m[1]!.toUpperCase() : '*';
  const pathPart = m ? m[2]! : when;
  const escaped = pathPart.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  return { method, glob: new RegExp(escaped) };
}

/** Deterministic transport-fault injection via route interception. */
function installFault(context: BrowserContext, fault: FaultContext): void {
  if (fault.type === 'clean') return;
  const { method, glob } = parseWhen(fault.when);
  const handler = async (route: Route): Promise<void> => {
    if (method !== '*' && route.request().method().toUpperCase() !== method) {
      await route.continue();
      return;
    }
    switch (fault.type) {
      case 'timeout':
        return; // never resolve → the request hangs
      case '5xx':
        await route.fulfill({ status: 503, body: 'service unavailable (fault injected)' });
        return;
      case 'reset':
        await route.abort('connectionreset');
        return;
      case 'latency':
        await new Promise((resolve) => setTimeout(resolve, 3000));
        await route.continue();
        return;
      default:
        await route.continue();
    }
  };
  void context.route((url) => glob.test(url.pathname), handler);
}

export const test = base.extend<{ argusRecorder: void; argusFault: FaultContext | null }, object>({
  argusRecorder: [
    async ({ context }, use) => {
      if (artifactDir()) {
        await installRecorder(context);
        const fault = currentFault();
        if (fault) installFault(context, fault);
      }
      await use();
      flush();
    },
    { auto: true },
  ],
  argusFault: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring
    async ({}, use) => {
      await use(currentFault());
    },
    { auto: true },
  ],
});

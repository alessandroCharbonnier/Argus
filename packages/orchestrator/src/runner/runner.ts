import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RunPaths } from '../artifacts.js';
import { nodeAttemptDir, writeJson } from '../artifacts.js';
import { crawlNode } from '../crawler.js';
import type { HttpEntry } from '../guard/storm.js';
import type { FaultsConfig, FaultType, Plan, TestNode } from '../plan/types.js';
import { spawnWithTimeout } from './kill.js';
import { resolvePlaywrightCli } from './pw.js';

export interface NodeRunOutcome {
  outcome: 'passed' | 'failed';
  detail?: string;
  durationMs: number;
  httpLog: HttpEntry[];
  passes?: FaultPassResult[];
}

export interface FaultPassResult {
  type: string;
  outcome: 'passed' | 'failed';
  detail?: string;
  durationMs: number;
}

export function aggregateFaultPasses(
  passes: FaultPassResult[],
  faults: FaultsConfig,
): { outcome: 'passed' | 'failed'; detail?: string } {
  const clean = passes.find((p) => p.type === 'clean');
  if (!clean || clean.outcome !== 'passed') {
    return {
      outcome: 'failed',
      detail: clean ? `clean pass failed: ${clean.detail ?? ''}` : 'clean pass missing',
    };
  }
  const ungraceful = passes.filter(
    (p) =>
      p.type !== 'clean' && p.outcome !== 'passed' && !faults.allow.includes(p.type as FaultType),
  );
  if (ungraceful.length > 0 && faults.fail) {
    return {
      outcome: 'failed',
      detail: `ungraceful under ${ungraceful.map((p) => p.type).join(', ')}`,
    };
  }
  return { outcome: 'passed' };
}

interface RunnerEnv {
  plan: Plan;
  paths: RunPaths;
  node: TestNode;
  attempt: number;
  ancestors: Record<string, string>;
  onProgress?: (line: string) => void;
}

export function buildNodeEnv(
  plan: Plan,
  paths: RunPaths,
  node: TestNode,
  attempt: number,
): NodeJS.ProcessEnv {
  const dir = nodeAttemptDir(paths, node.id, attempt);
  return {
    ...process.env,
    BASE_URL: plan.env.base_url,
    ARTIFACTS_DIR: dir,
    E2E_NAMESPACE: `e2e-${node.id}-a${attempt}`,
    ...(plan.env.vars ?? {}),
  };
}

interface PwError {
  message?: string;
}
interface PwResult {
  error?: PwError;
}
interface PwTest {
  status?: string;
  results?: PwResult[];
}
interface PwSpec {
  tests?: PwTest[];
  suites?: PwSpec[];
  specs?: PwSpec[];
}

function extractFirstError(root: PwSpec): string | undefined {
  const stack: PwSpec[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const test of node.tests ?? []) {
      if (test.status === 'failed' || test.status === 'timedOut') {
        const err = (test.results ?? []).find((r) => r.error)?.error;
        if (err) return err.message ?? JSON.stringify(err);
      }
    }
    if (node.suites) stack.push(...node.suites);
    if (node.specs) stack.push(...node.specs);
  }
  return undefined;
}

export interface PwStats {
  expected: number;
  unexpected: number;
  flaky: number;
  skipped: number;
  interrupted: number;
  firstError?: string;
}

export function parsePlaywrightJson(stdout: string): PwStats | undefined {
  const text = stdout.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    try {
      obj = JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }
  if (obj === null || typeof obj !== 'object') return undefined;
  const stats = (obj as { stats?: Record<string, unknown> }).stats ?? {};
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    expected: num(stats['expected']),
    unexpected: num(stats['unexpected']),
    flaky: num(stats['flaky']),
    skipped: num(stats['skipped']),
    interrupted: num(stats['interrupted']),
    firstError: extractFirstError(obj as PwSpec),
  };
}

function readJsonIfExists<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function exists(file: string): boolean {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}

function copyFailureArtifacts(outputDir: string, opts: RunnerEnv, artifactDir: string): void {
  const dest = path.join(opts.paths.failuresRoot, opts.node.id, `a${opts.attempt}`);
  try {
    mkdirSync(dest, { recursive: true });
    cpSync(outputDir, dest, { recursive: true, force: true });
    for (const f of ['http.json', 'console.json', 'recorded.json', 'session.json']) {
      const src = path.join(artifactDir, f);
      if (exists(src)) cpSync(src, path.join(dest, f));
    }
  } catch {
    /* triage artifacts are best-effort */
  }
}

export async function runNode(opts: RunnerEnv): Promise<NodeRunOutcome> {
  const { plan, paths, node, attempt, ancestors } = opts;
  const dir = nodeAttemptDir(paths, node.id, attempt);
  mkdirSync(dir, { recursive: true });
  // Ancestors travel via a file, not an env var: Windows backslash paths get
  // mangled inside env-var JSON, and env vars are size-limited.
  writeJson(path.join(dir, 'ancestors.json'), ancestors);
  const env = buildNodeEnv(plan, paths, node, attempt);

  if (node.kind === 'crawl') {
    return runCrawlNode(opts, env, dir);
  }
  return runTestNode(opts, env, dir);
}

async function runOnePass(
  opts: RunnerEnv,
  env: NodeJS.ProcessEnv,
  dir: string,
): Promise<NodeRunOutcome> {
  const { plan, node } = opts;
  // Relative to project_root: Playwright mis-parses absolute Windows paths
  // (backslashes read as glob escapes), and the spawn cwd IS project_root.
  const spec = node.spec!;
  const started = Date.now();
  const cli = resolvePlaywrightCli(plan.project_root);
  // Playwright's trace finalize fails on SMB/NAS shares (EPERM); redirect its
  // output to a local temp dir and copy failure artifacts back afterwards.
  const outputDir = mkdtempSync(path.join(tmpdir(), 'argus-out-'));
  let result: Awaited<ReturnType<typeof spawnWithTimeout>>;
  try {
    result = await spawnWithTimeout({
      command: process.execPath,
      args: [
        cli,
        'test',
        spec,
        '--project=chromium',
        '--workers=1',
        '--reporter=json',
        '--output',
        outputDir,
      ],
      cwd: plan.project_root,
      env,
      timeoutMs: node.timeout_seconds * 1000,
    });
  } catch (err) {
    rmSync(outputDir, { recursive: true, force: true });
    return {
      outcome: 'failed',
      detail: (err as Error).message,
      durationMs: Date.now() - started,
      httpLog: [],
    };
  }
  const durationMs = Date.now() - started;
  const httpLog = readJsonIfExists<HttpEntry[]>(path.join(dir, 'http.json')) ?? [];
  const heartbeat = exists(path.join(dir, 'heartbeat.json'));
  const pageErrors = readJsonIfExists<string[]>(path.join(dir, 'pageerrors.json')) ?? [];
  writeFileSync(path.join(dir, 'pw.stdout.txt'), result.stdout);
  writeFileSync(path.join(dir, 'pw.stderr.txt'), result.stderr);

  let outcome: NodeRunOutcome;
  if (result.timedOut) {
    outcome = {
      outcome: 'failed',
      detail: `failed: timeout after ${node.timeout_seconds}s`,
      durationMs,
      httpLog,
    };
  } else {
    const stats = parsePlaywrightJson(result.stdout);
    if (!stats) {
      outcome = {
        outcome: 'failed',
        detail:
          result.stderr.slice(-500) || result.stdout.slice(-500) || 'no playwright output parsed',
        durationMs,
        httpLog,
      };
    } else if (stats.unexpected > 0 || stats.interrupted > 0) {
      outcome = {
        outcome: 'failed',
        detail:
          stats.firstError ??
          result.stderr.slice(-500) ??
          `unexpected=${stats.unexpected} interrupted=${stats.interrupted}`,
        durationMs,
        httpLog,
      };
    } else if (pageErrors.length > 0) {
      outcome = {
        outcome: 'failed',
        detail: `pageerror: ${pageErrors[0]}`,
        durationMs,
        httpLog,
      };
    } else if (!heartbeat) {
      outcome = {
        outcome: 'failed',
        detail:
          'recorder silent — import `test` from @e2e-orchestrator/playwright, not @playwright/test',
        durationMs,
        httpLog,
      };
    } else if (stats.expected + stats.flaky === 0) {
      outcome = { outcome: 'failed', detail: 'no tests ran', durationMs, httpLog };
    } else {
      outcome = { outcome: 'passed', durationMs, httpLog };
    }
  }
  if (outcome.outcome === 'failed') {
    copyFailureArtifacts(outputDir, opts, dir);
  }
  rmSync(outputDir, { recursive: true, force: true });
  return outcome;
}

async function runTestNode(
  opts: RunnerEnv,
  env: NodeJS.ProcessEnv,
  dir: string,
): Promise<NodeRunOutcome> {
  const { node } = opts;
  if (!node.faults) {
    return runOnePass(opts, env, dir);
  }
  const passes: FaultPassResult[] = [];
  let cleanHttpLog: HttpEntry[] = [];
  for (const [i, type] of node.faults.sweep.entries()) {
    const passEnv = {
      ...env,
      ARGUS_FAULT: JSON.stringify({ type, when: node.faults.when, pass: i }),
    };
    const res = await runOnePass(opts, passEnv, dir);
    if (type === 'clean') cleanHttpLog = res.httpLog;
    passes.push({ type, outcome: res.outcome, detail: res.detail, durationMs: res.durationMs });
  }
  const agg = aggregateFaultPasses(passes, node.faults);
  return {
    outcome: agg.outcome,
    detail: agg.detail,
    durationMs: passes.reduce((s, p) => s + p.durationMs, 0),
    httpLog: cleanHttpLog,
    passes,
  };
}

/**
 * Fill `{{key}}` placeholders in crawl URLs from the merged publish.json of
 * the node's ancestors (validation guarantees every key is in `reads`).
 */
export function resolveCrawlUrls(urls: string[], ancestors: Record<string, string>): string[] {
  const values: Record<string, unknown> = {};
  for (const file of Object.values(ancestors)) {
    const pub = readJsonIfExists<Record<string, unknown>>(file);
    if (pub) Object.assign(values, pub);
  }
  return urls.map((u) =>
    u.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_m, key: string) => {
      const v = values[key];
      if (v === undefined || v === null || v === '') {
        throw new Error(`crawl url \`${u}\`: ancestor output \`${key}\` not published`);
      }
      return encodeURIComponent(String(v));
    }),
  );
}

async function runCrawlNode(
  opts: RunnerEnv,
  env: NodeJS.ProcessEnv,
  dir: string,
): Promise<NodeRunOutcome> {
  const { plan, node } = opts;
  const started = Date.now();
  // Optional login spec: run it first so it saves a session into ARTIFACTS_DIR.
  if (node.login) {
    const loginSpec = node.login;
    const cli = resolvePlaywrightCli(plan.project_root);
    const login = await spawnWithTimeout({
      command: process.execPath,
      args: [cli, 'test', loginSpec, '--project=chromium', '--workers=1', '--reporter=json'],
      cwd: plan.project_root,
      env,
      timeoutMs: node.timeout_seconds * 1000,
    });
    const stats = parsePlaywrightJson(login.stdout);
    if (login.timedOut || !stats || stats.unexpected > 0 || stats.interrupted > 0) {
      return {
        outcome: 'failed',
        detail: `crawler login failed: ${stats?.firstError ?? login.stderr.slice(-300)}`,
        durationMs: Date.now() - started,
        httpLog: readJsonIfExists<HttpEntry[]>(path.join(dir, 'http.json')) ?? [],
      };
    }
  }
  const sessionPath = path.join(dir, 'session.json');
  const storageState = exists(sessionPath) ? readJsonIfExists<unknown>(sessionPath) : undefined;
  const httpLog: HttpEntry[] = [];
  let urls: string[];
  try {
    urls = resolveCrawlUrls(node.urls, opts.ancestors);
  } catch (err) {
    return {
      outcome: 'failed',
      detail: (err as Error).message,
      durationMs: Date.now() - started,
      httpLog: [],
    };
  }
  const crawl = await crawlNode({
    baseUrl: plan.env.base_url,
    urls,
    sitemap: node.sitemap,
    storageState,
    httpLog,
  });
  writeJson(path.join(dir, 'crawl.json'), {
    controls: crawl.controls,
    visited: crawl.visited,
    pass: opts.attempt,
  });
  writeJson(path.join(dir, 'heartbeat.json'), { crawler: true, at: Date.now() });
  return {
    outcome: 'passed',
    durationMs: Date.now() - started,
    httpLog,
  };
}

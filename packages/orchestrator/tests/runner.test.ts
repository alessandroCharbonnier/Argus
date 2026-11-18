import { describe, expect, it } from 'vitest';
import type { Plan, TestNode } from '../src/plan/types.js';
import { runPaths } from '../src/artifacts.js';
import { buildNodeEnv, parsePlaywrightJson } from '../src/runner/runner.js';

const node: TestNode = {
  id: 'a',
  kind: 'test',
  spec: 'specs/a.spec.ts',
  depends_on: [],
  critical: false,
  idempotent: false,
  retries: 0,
  outputs: [],
  reads: [],
  writes: [],
  exclusive: false,
  timeout_seconds: 900,
  line: 1,
  urls: [],
};

const plan = {
  file: '/x/e2e-plan.yaml',
  project_root: '/x',
  output_dir: '/x/.argus',
  env: {
    base_url: 'http://staging.example.com',
    workers: 2,
    env_marker: { url: '/api/health', expect_json: {} },
    drift_interval_seconds: 600,
    storm_probe_seconds: 60,
    storm_timeout_seconds: 600,
  },
  reset: { verify: {} },
  tests: [node],
} as unknown as Plan;

describe('buildNodeEnv', () => {
  it('exposes the node contract to spawned specs', () => {
    const paths = runPaths('/x/.argus', 'run-1');
    const env = buildNodeEnv(plan, paths, node, 3);
    expect(env.BASE_URL).toBe('http://staging.example.com');
    expect(env.E2E_NAMESPACE).toBe('e2e-a-a3');
    expect(env.ARTIFACTS_DIR).toMatch(/a3$/);
  });
});

describe('parsePlaywrightJson', () => {
  it('extracts stats from the JSON reporter output', () => {
    const stdout = JSON.stringify({
      stats: { expected: 3, unexpected: 1, flaky: 1, skipped: 0, interrupted: 0 },
    });
    const stats = parsePlaywrightJson(stdout);
    expect(stats?.expected).toBe(3);
    expect(stats?.unexpected).toBe(1);
  });

  it('tolerates surrounding non-JSON noise', () => {
    const stdout =
      'downloading browsers...\n' +
      JSON.stringify({
        stats: { unexpected: 0, expected: 1, flaky: 0, skipped: 0, interrupted: 0 },
      }) +
      '\n';
    expect(parsePlaywrightJson(stdout)?.unexpected).toBe(0);
  });

  it('returns undefined for garbage', () => {
    expect(parsePlaywrightJson('no json here')).toBeUndefined();
  });

  it('extracts the first test error', () => {
    const stdout = JSON.stringify({
      stats: { unexpected: 1, expected: 0, flaky: 0, skipped: 0, interrupted: 0 },
      suites: [
        {
          specs: [
            {
              tests: [
                {
                  status: 'failed',
                  results: [{ error: { message: 'Expected 1 to be 2' } }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(parsePlaywrightJson(stdout)?.firstError).toContain('Expected 1 to be 2');
  });
});

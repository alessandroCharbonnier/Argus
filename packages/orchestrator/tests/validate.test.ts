import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PlanError } from '../src/errors.js';
import { loadPlan } from '../src/plan/load.js';

function makePlan(yaml: string, specs: string[] = []): { load: () => unknown; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'argus-plan-'));
  mkdirSync(path.join(dir, 'specs'), { recursive: true });
  for (const s of specs) writeFileSync(path.join(dir, 'specs', s), '// stub\n');
  writeFileSync(path.join(dir, 'e2e-plan.yaml'), yaml);
  return { dir, load: () => loadPlan(path.join(dir, 'e2e-plan.yaml')) };
}

const ENV = `
env:
  base_url: http://staging.example.com
  workers: 2
  env_marker:
    url: /api/health
    expect_json: { env: staging, db: staging-db }
`;

const RESET = `
reset:
  http:
    url: /api/e2e/reset
  verify:
    expect_status: 200
`;

describe('plan validation', () => {
  it('accepts a minimal valid plan', () => {
    const { load } = makePlan(`${ENV}${RESET}\ntests:\n  - id: a\n    spec: specs/a.spec.ts\n`, [
      'a.spec.ts',
    ]);
    const plan = load() as { env: { workers: number }; tests: unknown[] };
    expect(plan.env.workers).toBe(2);
    expect(plan.tests).toHaveLength(1);
  });

  it('rejects a relative base_url with a file:line issue', () => {
    const yaml = `env:\n  base_url: staging.example.com\n  workers: 2\n  env_marker:\n    url: /api/health\n    expect_json: { env: staging }\n${RESET}\ntests:\n  - id: a\n    spec: specs/a.spec.ts\n`;
    const { load } = makePlan(yaml, ['a.spec.ts']);
    try {
      load();
      throw new Error('should have thrown');
    } catch (err) {
      const message = (err as PlanError).message;
      expect(message).toContain('absolute http(s)');
      expect(message).toMatch(/line \d+/);
    }
  });

  it('rejects a missing reset block', () => {
    const yaml = `${ENV}\ntests:\n  - id: a\n    spec: specs/a.spec.ts\n`;
    const { load } = makePlan(yaml, ['a.spec.ts']);
    expect(() => load()).toThrow(/reset is mandatory/);
  });

  it('rejects a missing env_marker', () => {
    const yaml = `env:\n  base_url: http://staging.example.com\n  workers: 2\n${RESET}\ntests:\n  - id: a\n    spec: specs/a.spec.ts\n`;
    const { load } = makePlan(yaml, ['a.spec.ts']);
    expect(() => load()).toThrow(/env_marker is mandatory/);
  });

  it('rejects a dependency cycle', () => {
    const yaml = `${ENV}${RESET}\ntests:\n  - id: a\n    spec: specs/a.spec.ts\n    depends_on: [b]\n  - id: b\n    spec: specs/b.spec.ts\n    depends_on: [a]\n`;
    const { load } = makePlan(yaml, ['a.spec.ts', 'b.spec.ts']);
    expect(() => load()).toThrow(/cycle/);
  });

  it('rejects an unknown dependency', () => {
    const yaml = `${ENV}${RESET}\ntests:\n  - id: a\n    spec: specs/a.spec.ts\n    depends_on: [z]\n`;
    const { load } = makePlan(yaml, ['a.spec.ts']);
    expect(() => load()).toThrow(/unknown node `z`/);
  });

  it('rejects a read not present in any ancestor output', () => {
    const yaml = `${ENV}${RESET}\ntests:\n  - id: a\n    spec: specs/a.spec.ts\n    outputs: [x]\n  - id: b\n    spec: specs/b.spec.ts\n    depends_on: [a]\n    reads: [y]\n`;
    const { load } = makePlan(yaml, ['a.spec.ts', 'b.spec.ts']);
    expect(() => load()).toThrow(/reads `y`/);
  });

  it('accepts a read declared by an ancestor', () => {
    const yaml = `${ENV}${RESET}\ntests:\n  - id: a\n    spec: specs/a.spec.ts\n    outputs: [x]\n  - id: b\n    spec: specs/b.spec.ts\n    depends_on: [a]\n    reads: [x]\n`;
    const { load } = makePlan(yaml, ['a.spec.ts', 'b.spec.ts']);
    expect(() => load()).not.toThrow();
  });

  it('rejects a missing spec file', () => {
    const yaml = `${ENV}${RESET}\ntests:\n  - id: a\n    spec: specs/missing.spec.ts\n`;
    const { load } = makePlan(yaml);
    expect(() => load()).toThrow(/spec file not found/);
  });

  it('rejects retries without idempotent', () => {
    const yaml = `${ENV}${RESET}\ntests:\n  - id: a\n    spec: specs/a.spec.ts\n    retries: 1\n`;
    const { load } = makePlan(yaml, ['a.spec.ts']);
    expect(() => load()).toThrow(/idempotent/);
  });

  it('rejects a duplicate node id', () => {
    const yaml = `${ENV}${RESET}\ntests:\n  - id: a\n    spec: specs/a.spec.ts\n  - id: a\n    spec: specs/b.spec.ts\n`;
    const { load } = makePlan(yaml, ['a.spec.ts', 'b.spec.ts']);
    expect(() => load()).toThrow(/duplicate node id/);
  });

  it('requires crawl nodes to declare urls or sitemap', () => {
    const yaml = `${ENV}${RESET}\ntests:\n  - id: crawl\n    kind: crawl\n    urls: ['/']\n`;
    const { load } = makePlan(yaml);
    expect(() => load()).not.toThrow();
  });

  it('interpolates ${VAR} from the environment', () => {
    const yaml = `${ENV}${RESET}\ntests:\n  - id: a\n    spec: specs/a.spec.ts\n    timeout_seconds: \${TIMEOUT}\n`;
    const { load } = makePlan(yaml, ['a.spec.ts']);
    process.env.TIMEOUT = '42';
    try {
      const plan = load() as { tests: { timeout_seconds: number }[] };
      expect(plan.tests[0]!.timeout_seconds).toBe(42);
    } finally {
      delete process.env.TIMEOUT;
    }
  });

  it('accepts a faults block with a default sweep', () => {
    const yaml = `${ENV}${RESET}\ntests:\n  - id: pay\n    spec: specs/pay.spec.ts\n    faults:\n      when: POST /api/payment\n`;
    const { load } = makePlan(yaml, ['pay.spec.ts']);
    const plan = load() as { tests: { faults?: { when: string; sweep: string[] } }[] };
    expect(plan.tests[0]!.faults?.when).toBe('POST /api/payment');
    expect(plan.tests[0]!.faults?.sweep).toEqual(['clean', 'timeout', '5xx', 'reset', 'latency']);
  });

  it('rejects an unknown fault type', () => {
    const yaml = `${ENV}${RESET}\ntests:\n  - id: pay\n    spec: specs/pay.spec.ts\n    faults:\n      when: POST /api/payment\n      sweep: [clean, boom]\n`;
    const { load } = makePlan(yaml, ['pay.spec.ts']);
    expect(() => load()).toThrow(/unknown fault type/);
  });

  it('rejects a faults block without when', () => {
    const yaml = `${ENV}${RESET}\ntests:\n  - id: pay\n    spec: specs/pay.spec.ts\n    faults:\n      sweep: [clean]\n`;
    const { load } = makePlan(yaml, ['pay.spec.ts']);
    expect(() => load()).toThrow(/when is required/);
  });
});

describe('gate + crawl placeholders', () => {
  it('accepts gate.route_patterns and crawl {{key}} listed in reads', () => {
    const { load } = makePlan(
      `${ENV}${RESET}\ngate:\n  route_patterns: ['/cheval/:code']\ntests:\n  - id: w\n    spec: specs/w.spec.ts\n    outputs: [code]\n  - id: c\n    kind: crawl\n    depends_on: [w]\n    reads: [code]\n    urls: ['/cheval/{{code}}']\n`,
      ['w.spec.ts'],
    );
    const plan = load() as { gate: { route_patterns: string[] } };
    expect(plan.gate.route_patterns).toEqual(['/cheval/:code']);
  });

  it('rejects a crawl {{key}} that is not in reads', () => {
    const { load } = makePlan(
      `${ENV}${RESET}\ntests:\n  - id: c\n    kind: crawl\n    urls: ['/cheval/{{code}}']\n`,
    );
    expect(load).toThrow(PlanError);
  });

  it('rejects a route pattern without a leading slash', () => {
    const { load } = makePlan(
      `${ENV}${RESET}\ngate:\n  route_patterns: ['cheval/:code']\ntests:\n  - id: a\n    spec: specs/a.spec.ts\n`,
      ['a.spec.ts'],
    );
    expect(load).toThrow(PlanError);
  });
});

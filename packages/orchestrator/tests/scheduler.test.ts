import { describe, expect, it, vi } from 'vitest';
import { buildGraph } from '../src/graph.js';
import type { ExecResult, Executor, NodeRunInfo, StormGate } from '../src/scheduler.js';
import { Scheduler } from '../src/scheduler.js';
import type { TestNode } from '../src/plan/types.js';

function makeNode(id: string, overrides: Partial<TestNode> = {}): TestNode {
  return {
    id,
    kind: 'test',
    spec: 'specs/x.spec.ts',
    depends_on: [],
    critical: false,
    idempotent: false,
    retries: 0,
    outputs: [],
    reads: [],
    writes: [],
    exclusive: false,
    timeout_seconds: 900,
    line: 0,
    urls: [],
    ...overrides,
  };
}

function setup(nodes: TestNode[], workers: number, executor: Executor, storm?: StormGate) {
  const depsOf = new Map(nodes.map((n) => [n.id, n.depends_on]));
  const graph = buildGraph(
    nodes.map((n) => n.id),
    depsOf,
  );
  const map = new Map(nodes.map((n) => [n.id, n]));
  return new Scheduler(graph, map, { workers, executor, storm });
}

function outcomeExecutor(script: Record<string, Array<'passed' | 'failed' | 'blocked'>>): Executor {
  const calls = new Map<string, number>();
  return {
    run: async (r: NodeRunInfo): Promise<ExecResult> => {
      const n = calls.get(r.node.id) ?? 0;
      calls.set(r.node.id, n + 1);
      const seq = script[r.node.id] ?? ['passed'];
      const outcome = seq[Math.min(n, seq.length - 1)] ?? seq[seq.length - 1]!;
      return { outcome };
    },
  };
}

class FakeStorm implements StormGate {
  frozen = false;
  isFrozen(): boolean {
    return this.frozen;
  }
  waitForClear(): Promise<void> {
    return Promise.resolve().then(() => {
      this.frozen = false;
    });
  }
}

describe('scheduler', () => {
  it('skips dependents of a failed node and keeps independents running', async () => {
    const nodes = [makeNode('a'), makeNode('b', { depends_on: ['a'] }), makeNode('c')];
    const scheduler = setup(nodes, 2, outcomeExecutor({ a: ['failed'], c: ['passed'] }));
    const summary = await scheduler.run();
    expect(summary.states.get('a')).toBe('failed');
    expect(summary.states.get('b')).toBe('skipped');
    expect(summary.states.get('c')).toBe('passed');
  });

  it('aborts the whole run when a critical node fails', async () => {
    const nodes = [makeNode('a', { critical: true }), makeNode('b')];
    const scheduler = setup(nodes, 2, outcomeExecutor({ a: ['failed'], b: ['passed'] }));
    const summary = await scheduler.run();
    expect(summary.aborted).toBe(true);
    expect(summary.states.get('a')).toBe('failed');
    expect(summary.states.get('b')).toBe('aborted');
  });

  it('never runs two writers of the same resource concurrently', async () => {
    const nodes = [makeNode('a', { writes: ['x'] }), makeNode('b', { writes: ['x'] })];
    let active = 0;
    let max = 0;
    const executor: Executor = {
      run: async () => {
        active += 1;
        max = Math.max(max, active);
        await Promise.resolve();
        await Promise.resolve();
        active -= 1;
        return { outcome: 'passed' };
      },
    };
    const summary = await setup(nodes, 2, executor).run();
    expect(max).toBe(1);
    expect(summary.states.get('a')).toBe('passed');
    expect(summary.states.get('b')).toBe('passed');
  });

  it('exclusive node drains the pool and runs alone', async () => {
    const nodes = [makeNode('a'), makeNode('b', { exclusive: true }), makeNode('c')];
    const starts: string[] = [];
    const release: Record<string, () => void> = {};
    const executor: Executor = {
      run: (r) =>
        new Promise<ExecResult>((resolve) => {
          starts.push(r.node.id);
          release[r.node.id] = () => resolve({ outcome: 'passed' });
        }),
    };
    const scheduler = setup(nodes, 2, executor);
    const p = scheduler.run();
    await vi.waitFor(() => expect(starts).toEqual(['b']));
    expect(starts).toEqual(['b']); // A and C are blocked by the exclusive node
    release['b']!();
    await vi.waitFor(() => expect(starts).toContain('a'));
    await vi.waitFor(() => expect(starts).toContain('c'));
    release['a']!();
    release['c']!();
    const summary = await p;
    expect(summary.states.get('a')).toBe('passed');
    expect(summary.states.get('b')).toBe('passed');
    expect(summary.states.get('c')).toBe('passed');
  });

  it('retries an idempotent node with a fresh attempt', async () => {
    const nodes = [makeNode('a', { idempotent: true, retries: 1 })];
    const summary = await setup(nodes, 1, outcomeExecutor({ a: ['failed', 'passed'] })).run();
    expect(summary.states.get('a')).toBe('passed');
    expect(summary.attempts.get('a')).toBe(2);
  });

  it('does not retry a non-idempotent node', async () => {
    const nodes = [makeNode('a', { retries: 1 })];
    const summary = await setup(nodes, 1, outcomeExecutor({ a: ['failed', 'passed'] })).run();
    expect(summary.states.get('a')).toBe('failed');
    expect(summary.attempts.get('a')).toBe(1);
  });

  it('re-queues an idempotent blocked node after the storm clears', async () => {
    const nodes = [makeNode('a', { idempotent: true })];
    const storm = new FakeStorm();
    const calls = new Map<string, number>();
    const executor: Executor = {
      run: async (r) => {
        const n = calls.get(r.node.id) ?? 0;
        calls.set(r.node.id, n + 1);
        if (n === 0) {
          storm.frozen = true;
          return { outcome: 'blocked' };
        }
        return { outcome: 'passed' };
      },
    };
    const summary = await setup(nodes, 1, executor, storm).run();
    expect(summary.states.get('a')).toBe('passed');
    expect(summary.attempts.get('a')).toBe(2);
  });

  it('holds dependents of a non-idempotent blocked node', async () => {
    const nodes = [makeNode('a'), makeNode('b', { depends_on: ['a'] })];
    const storm = new FakeStorm();
    const executor: Executor = {
      run: async (r) => {
        if (r.node.id === 'a') {
          storm.frozen = true;
          return { outcome: 'blocked' };
        }
        return { outcome: 'passed' };
      },
    };
    const summary = await setup(nodes, 1, executor, storm).run();
    expect(summary.states.get('a')).toBe('blocked');
    expect(summary.states.get('b')).toBe('held');
  });
});

import { dependentsClosure } from './graph.js';
import type { Graph } from './graph.js';
import type { TestNode } from './plan/types.js';

export type NodeState =
  'pending' | 'running' | 'passed' | 'failed' | 'blocked' | 'skipped' | 'aborted' | 'held';

export interface NodeRunInfo {
  node: TestNode;
  attempt: number;
}

export interface ExecResult {
  outcome: 'passed' | 'failed' | 'blocked';
  detail?: string;
}

export interface Executor {
  run(run: NodeRunInfo): Promise<ExecResult>;
  cancelAll?(): void;
}

export interface StormGate {
  isFrozen(): boolean;
  waitForClear(signal?: AbortSignal): Promise<void>;
}

export type SchedulerEvent = {
  type: 'start' | 'finish' | 'retry' | 'skip' | 'blocked' | 'abort';
  nodeId: string;
  attempt?: number;
  state?: NodeState;
  detail?: string;
};

export interface SchedulerOptions {
  workers: number;
  executor: Executor;
  storm?: StormGate;
  onEvent?: (event: SchedulerEvent) => void;
  signal?: AbortSignal;
}

export interface SchedulerSummary {
  states: Map<string, NodeState>;
  attempts: Map<string, number>;
  details: Map<string, string>;
  aborted: boolean;
}

export function writesConflict(a: TestNode, b: TestNode): boolean {
  if (a.exclusive || b.exclusive) return true;
  const bw = new Set(b.writes);
  return a.writes.some((w) => bw.has(w));
}

export class Scheduler {
  private states = new Map<string, NodeState>();
  private attempts = new Map<string, number>();
  private details = new Map<string, string>();
  private running = new Map<string, Promise<{ id: string; result: ExecResult }>>();
  private aborted = false;

  constructor(
    private graph: Graph,
    private nodes: Map<string, TestNode>,
    private opts: SchedulerOptions,
  ) {
    for (const id of graph.ids) {
      this.states.set(id, 'pending');
      this.attempts.set(id, 0);
    }
  }

  private emit(event: SchedulerEvent): void {
    this.opts.onEvent?.(event);
  }

  private depsPassed(id: string): boolean {
    return (this.graph.depsOf.get(id) ?? []).every((d) => this.states.get(d) === 'passed');
  }

  private readyPending(): TestNode[] {
    const ready: TestNode[] = [];
    for (const id of this.graph.order) {
      if (this.states.get(id) === 'pending' && this.depsPassed(id)) {
        ready.push(this.nodes.get(id)!);
      }
    }
    return ready;
  }

  private conflictsWithRunning(node: TestNode): boolean {
    for (const id of this.running.keys()) {
      if (writesConflict(node, this.nodes.get(id)!)) return true;
    }
    return false;
  }

  private launchReady(): number {
    let launched = 0;
    while (this.running.size < this.opts.workers) {
      const candidates = this.readyPending();
      if (candidates.length === 0) break;
      const exclusiveReady = candidates.find((n) => n.exclusive);
      if (exclusiveReady) {
        if (this.running.size > 0) break; // drain the pool first
        this.launch(exclusiveReady);
        launched++;
        break; // runs alone
      }
      const node = candidates.find((n) => !this.conflictsWithRunning(n));
      if (!node) break; // every ready node conflicts with something running
      this.launch(node);
      launched++;
    }
    return launched;
  }

  private launch(node: TestNode): void {
    const attempt = (this.attempts.get(node.id) ?? 0) + 1;
    this.attempts.set(node.id, attempt);
    this.states.set(node.id, 'running');
    this.emit({ type: 'start', nodeId: node.id, attempt });
    const promise = this.opts.executor.run({ node, attempt }).then(
      (result) => ({ id: node.id, result }),
      (error: Error) => ({
        id: node.id,
        result: { outcome: 'failed' as const, detail: error.message },
      }),
    );
    this.running.set(node.id, promise);
  }

  private async waitOne(): Promise<void> {
    const done = await Promise.race(this.running.values());
    this.running.delete(done.id);
    this.settle(done.id, done.result);
  }

  private settle(id: string, result: ExecResult): void {
    const node = this.nodes.get(id)!;
    if (this.aborted) {
      this.states.set(id, 'aborted');
      return;
    }
    if (result.outcome === 'passed') {
      this.states.set(id, 'passed');
      this.emit({ type: 'finish', nodeId: id, state: 'passed', attempt: this.attempts.get(id) });
      return;
    }
    if (result.outcome === 'blocked') {
      this.states.set(id, 'blocked');
      this.details.set(id, result.detail ?? 'blocked: infra');
      this.emit({ type: 'blocked', nodeId: id, state: 'blocked', detail: result.detail });
      return;
    }
    const attempt = this.attempts.get(id) ?? 1;
    if (node.idempotent && attempt < node.retries + 1) {
      this.states.set(id, 'pending');
      this.emit({ type: 'retry', nodeId: id, attempt });
      return;
    }
    this.states.set(id, 'failed');
    this.details.set(id, result.detail ?? 'failed');
    this.emit({ type: 'finish', nodeId: id, state: 'failed', detail: result.detail });
    if (node.critical) {
      this.aborted = true;
      this.emit({ type: 'abort', nodeId: id, detail: 'critical node failed' });
      this.opts.executor.cancelAll?.();
      this.abortRemaining();
    } else {
      this.skipSubtree(id);
    }
  }

  private skipSubtree(id: string): void {
    for (const child of dependentsClosure(id, this.graph.dependentsOf)) {
      if (this.states.get(child) === 'pending') {
        this.states.set(child, 'skipped');
        this.details.set(child, `skipped: ancestor \`${id}\` failed`);
        this.emit({ type: 'skip', nodeId: child });
      }
    }
  }

  private abortRemaining(): void {
    for (const id of this.graph.ids) {
      const s = this.states.get(id);
      if (s === 'pending' || s === 'blocked' || s === 'running') {
        this.states.set(id, 'aborted');
      }
    }
  }

  private requeueBlockedIdempotent(): void {
    for (const id of this.graph.ids) {
      if (this.states.get(id) !== 'blocked') continue;
      if (this.nodes.get(id)!.idempotent) {
        this.states.set(id, 'pending');
        this.emit({ type: 'retry', nodeId: id, attempt: this.attempts.get(id) });
      }
    }
  }

  private stormFrozen(): boolean {
    return this.opts.storm?.isFrozen() ?? false;
  }

  async run(): Promise<SchedulerSummary> {
    for (;;) {
      if (this.opts.signal?.aborted) {
        this.abortAll('run interrupted');
        break;
      }
      if (this.aborted) break;

      if (!this.stormFrozen()) this.launchReady();

      const hasRunning = this.running.size > 0;
      if (hasRunning) {
        await this.waitOne();
        continue;
      }

      const hasBlocked = [...this.states.values()].some((s) => s === 'blocked');
      if (hasBlocked && this.stormFrozen()) {
        await this.opts.storm!.waitForClear(this.opts.signal);
        this.requeueBlockedIdempotent();
        continue;
      }
      // No running work; either fully settled or held-on-blocked.
      break;
    }
    // Any node still pending never got its dependencies satisfied — hold it.
    for (const id of this.graph.ids) {
      if (this.states.get(id) === 'pending') this.states.set(id, 'held');
    }
    return {
      states: this.states,
      attempts: this.attempts,
      details: this.details,
      aborted: this.aborted,
    };
  }

  private abortAll(reason: string): void {
    this.aborted = true;
    this.opts.executor.cancelAll?.();
    for (const id of this.graph.ids) {
      const s = this.states.get(id);
      if (s === 'pending' || s === 'running' || s === 'blocked') {
        this.states.set(id, 'aborted');
        this.details.set(id, `aborted: ${reason}`);
      }
    }
  }
}

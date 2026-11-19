import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import {
  buildAncestorsMap,
  createRunDirs,
  findPublishedAttempt,
  newRunId,
  nodeAttemptDir,
  resolveOutputDir,
  runPaths,
  writeJson,
} from './artifacts.js';
import type { RunPaths } from './artifacts.js';
import { ArgusError, GuardError } from './errors.js';
import { EXIT } from './exitcodes.js';
import type { ExitCode } from './exitcodes.js';
import { computeGate } from './gate/gate.js';
import type { GateReport } from './gate/gate.js';
import type { ControlLike } from './gate/identity.js';
import { ancestorsOf, buildGraph } from './graph.js';
import type { Graph } from './graph.js';
import { DriftGuard, preflightProbe } from './guard/drift.js';
import { checkEnvMarker } from './guard/marker.js';
import { classifyInfra, StormController } from './guard/storm.js';
import { deepSubsetEqual } from './guard/subset.js';
import { httpRequest, resolveUrl } from './http.js';
import { clearProgressLine, log, progressLine } from './log.js';
import { loadPlan } from './plan/load.js';
import type { Plan, TestNode } from './plan/types.js';
import { formatLiveLine, writeHtmlReport, writeReportJson } from './report.js';
import type { NodeReport, RunReport } from './report.js';
import { runNode } from './runner/runner.js';
import { runShell } from './shell.js';
import { Scheduler } from './scheduler.js';
import type { ExecResult, Executor, NodeRunInfo, SchedulerSummary } from './scheduler.js';

export interface RunOptions {
  node?: string;
  fromRun?: string;
  unsafeSkipGuard?: boolean;
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
}

export interface RunResult {
  exitCode: ExitCode;
  outcome: string;
  report: RunReport;
  paths: RunPaths;
  runId: string;
}

interface Fatal {
  reason?: string;
  exitCode: ExitCode;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function loadExclusions(projectRoot: string): string[] {
  const p = path.join(projectRoot, 'exclusions.yaml');
  if (!existsSync(p)) return [];
  try {
    const data = parse(readFileSync(p, 'utf8')) as unknown;
    if (Array.isArray(data)) return data.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
  return [];
}

async function doReset(plan: Plan): Promise<void> {
  if (plan.reset.http) {
    const url = resolveUrl(plan.reset.http.url, plan.env.base_url);
    const baseOrigin = new URL(plan.env.base_url).origin;
    const resetOrigin = new URL(url).origin;
    if (baseOrigin !== resetOrigin) {
      throw new GuardError('reset.http must be same-origin as env.base_url');
    }
    await httpRequest(url, { method: plan.reset.http.method, headers: plan.reset.http.headers });
  } else {
    const attestCfg = plan.reset.attest;
    if (!attestCfg)
      throw new GuardError('reset.command requires reset.attest (read-only, runs first)');
    const attest = runShell(attestCfg.command, plan.project_root);
    if (attest.status !== 0) {
      throw new GuardError(
        `attest command failed (exit ${attest.status}): ${attest.stderr.slice(-500)}`,
      );
    }
    let attestJson: unknown;
    try {
      attestJson = JSON.parse(attest.stdout) as unknown;
    } catch {
      throw new GuardError('attest output is not valid JSON');
    }
    const mismatches = deepSubsetEqual(attestCfg.expect_json, attestJson);
    if (mismatches.length > 0) {
      throw new GuardError(`attest mismatch: ${mismatches.join('; ')}`);
    }
    // Same identity, field-by-field, against the HTTP marker's expected fields.
    const markerMismatches = deepSubsetEqual(plan.env.env_marker.expect_json, attestJson);
    if (markerMismatches.length > 0) {
      throw new GuardError(`attest vs marker mismatch: ${markerMismatches.join('; ')}`);
    }
    const reset = runShell(plan.reset.command!, plan.project_root);
    if (reset.status !== 0) {
      throw new GuardError(
        `reset command failed (exit ${reset.status}): ${reset.stderr.slice(-500)}`,
      );
    }
  }
  const v = plan.reset.verify;
  const vurl = v.url
    ? resolveUrl(v.url, plan.env.base_url)
    : resolveUrl(plan.env.env_marker.url, plan.env.base_url);
  const res = await httpRequest(vurl, { expectStatus: v.expect_status });
  if (v.expect_json) {
    const mismatches = deepSubsetEqual(v.expect_json, res.bodyJson);
    if (mismatches.length > 0) {
      throw new GuardError(`reset verify failed: ${mismatches.join('; ')}`);
    }
  }
}

interface GateCollected {
  controls: ControlLike[];
  recorded: ControlLike[];
  exclusions: string[];
}

function collectGate(plan: Plan, paths: RunPaths, summary: SchedulerSummary): GateCollected {
  const controls: ControlLike[] = [];
  const recorded: ControlLike[] = [];
  for (const node of plan.tests) {
    if (summary.states.get(node.id) !== 'passed') continue;
    const attempt = summary.attempts.get(node.id) ?? 1;
    const dir = nodeAttemptDir(paths, node.id, attempt);
    if (node.kind === 'crawl') {
      const crawl = readJson<{ controls?: ControlLike[] }>(path.join(dir, 'crawl.json'));
      controls.push(...(crawl?.controls ?? []));
    } else {
      const rec = readJson<ControlLike[]>(path.join(dir, 'recorded.json'));
      recorded.push(...(rec ?? []));
    }
  }
  return { controls, recorded, exclusions: loadExclusions(plan.project_root) };
}

export async function run(planPath: string, opts: RunOptions = {}): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const plan = loadPlan(planPath);
  const outputDir = resolveOutputDir(plan);
  const runId = newRunId();
  const paths = runPaths(outputDir, runId);
  createRunDirs(paths);
  const errors: string[] = [];
  const nodeMeta = new Map<string, NodeReport>();
  const fatal: Fatal = { exitCode: EXIT.invalid };

  let schedulerSummary: SchedulerSummary | undefined;
  let gateReport: GateReport | undefined;

  try {
    if (opts.unsafeSkipGuard) {
      errors.push('guard skipped: --unsafe-skip-guard marks this run invalid: unguarded');
    } else {
      await checkEnvMarker(plan.env.env_marker, plan.env.base_url);
      await preflightProbe(plan.env.base_url);
    }

    if (opts.node) {
      const replay = await runReplay(plan, opts, paths, startedAt, errors);
      return replay;
    }

    await doReset(plan);

    const drift = new DriftGuard(plan.env, (reason) => {
      fatal.reason = reason;
      fatal.exitCode = EXIT.invalid;
    });
    await drift.initial();
    drift.start(async () => {
      await checkEnvMarker(plan.env.env_marker, plan.env.base_url);
    });

    const graph = buildGraph(
      plan.tests.map((n) => n.id),
      new Map(plan.tests.map((n) => [n.id, n.depends_on])),
    );
    schedulerSummary = await schedule(plan, paths, graph, nodeMeta, opts);

    drift.stop();
  } catch (err) {
    if (err instanceof GuardError) {
      fatal.reason = err.message;
      fatal.exitCode = err.exitCode as ExitCode;
    } else if (err instanceof ArgusError) {
      fatal.reason = err.message;
      fatal.exitCode = err.exitCode as ExitCode;
    } else {
      fatal.reason = (err as Error).message;
      fatal.exitCode = EXIT.invalid;
    }
  }

  if (fatal.reason) log(`fatal: ${fatal.reason}`);

  if (!fatal.reason && schedulerSummary && !schedulerSummary.aborted) {
    try {
      const collected = collectGate(plan, paths, schedulerSummary);
      gateReport = computeGate(collected);
      writeJson(paths.gateJsonPath, gateReport);
    } catch (err) {
      errors.push(`gate computation failed: ${(err as Error).message}`);
    }
  }

  const { outcome, exitCode } = decideOutcome(fatal, schedulerSummary, gateReport, opts);
  const report = buildReport(
    plan,
    runId,
    startedAt,
    outcome,
    exitCode,
    nodeMeta,
    schedulerSummary,
    gateReport,
    errors,
  );
  writeReportJson(paths, report);
  writeHtmlReport(paths, report);
  writePointer(outputDir, runId);
  return { exitCode, outcome, report, paths, runId };
}

export function decideOutcome(
  fatal: Fatal,
  summary: SchedulerSummary | undefined,
  gate: GateReport | undefined,
  opts: RunOptions,
): { outcome: string; exitCode: ExitCode } {
  if (opts.signal?.aborted) return { outcome: 'aborted', exitCode: EXIT.sigint };
  if (fatal.reason) return { outcome: 'invalid', exitCode: fatal.exitCode };
  if (!summary) return { outcome: 'invalid', exitCode: EXIT.invalid };
  if (summary.aborted) return { outcome: 'aborted', exitCode: EXIT.red };
  const states = [...summary.states.values()];
  if (states.includes('failed')) return { outcome: 'failed', exitCode: EXIT.red };
  if (states.includes('blocked') || states.includes('held')) {
    return { outcome: 'incomplete', exitCode: EXIT.incomplete };
  }
  if (gate && gate.uncovered.length > 0)
    return { outcome: 'incomplete', exitCode: EXIT.incomplete };
  return { outcome: 'passed', exitCode: EXIT.ok };
}

function buildReport(
  plan: Plan,
  runId: string,
  startedAt: string,
  outcome: string,
  exitCode: ExitCode,
  nodeMeta: Map<string, NodeReport>,
  summary: SchedulerSummary | undefined,
  gate: GateReport | undefined,
  errors: string[],
): RunReport {
  const nodes: NodeReport[] = plan.tests.map((n) => {
    const state = summary?.states.get(n.id) ?? 'pending';
    const attempts = summary?.attempts.get(n.id) ?? 0;
    const meta = nodeMeta.get(n.id);
    return {
      id: n.id,
      state,
      attempts,
      durationMs: meta?.durationMs,
      detail: summary?.details.get(n.id) ?? meta?.detail,
      flaky: state === 'passed' && attempts > 1,
      faults: meta?.faults,
    };
  });
  return {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    planFile: plan.file,
    baseUrl: plan.env.base_url,
    outcome,
    exitCode,
    nodes,
    gate,
    errors,
  };
}

function writePointer(outputDir: string, runId: string): void {
  try {
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(path.join(outputDir, 'last-run'), runId, 'utf8');
  } catch {
    /* pointer is convenience only */
  }
}

async function schedule(
  plan: Plan,
  paths: RunPaths,
  graph: Graph,
  nodeMeta: Map<string, NodeReport>,
  opts: RunOptions,
): Promise<SchedulerSummary> {
  const storm = new StormController({
    probe: async () => {
      try {
        await httpRequest(plan.env.base_url, { timeoutMs: 10_000 });
        return true;
      } catch {
        return false;
      }
    },
    probeMs: plan.env.storm_probe_seconds * 1000,
    timeoutMs: plan.env.storm_timeout_seconds * 1000,
  });

  const nodes = new Map<string, TestNode>(plan.tests.map((n) => [n.id, n]));
  const states = new Map<string, number>();
  const total = plan.tests.length;
  const bump = (k: string, d: number) => states.set(k, (states.get(k) ?? 0) + d);

  const executor: Executor = {
    run: async (runInfo: NodeRunInfo): Promise<ExecResult> => {
      const { node, attempt } = runInfo;
      const ancestors = ancestorsOf(node.id, graph.depsOf);
      const ancestorsMap = buildAncestorsMap(paths, plan, node, ancestors);
      const out = await runNode({
        plan,
        paths,
        node,
        attempt,
        ancestors: ancestorsMap,
      });
      nodeMeta.set(node.id, {
        id: node.id,
        state: out.outcome,
        attempts: attempt,
        durationMs: out.durationMs,
        detail: out.detail,
        faults: out.passes,
      });
      // Injected faults pollute http.json with 5xx/resets — never classify a
      // fault-ride node as blocked: infra.
      if (
        out.outcome === 'failed' &&
        !node.faults &&
        classifyInfra(out.httpLog, storm.windowStart)
      ) {
        storm.freeze();
        return { outcome: 'blocked', detail: 'blocked: infra (5xx or connection errors)' };
      }
      return { outcome: out.outcome, detail: out.detail };
    },
  };

  const scheduler = new Scheduler(graph, nodes, {
    workers: plan.env.workers,
    executor,
    storm,
    signal: opts.signal,
    onEvent: (e) => {
      switch (e.type) {
        case 'start':
          bump('running', 1);
          break;
        case 'retry':
          bump('running', -1);
          break;
        case 'finish':
          bump('running', -1);
          if (e.state === 'passed') bump(e.attempt && e.attempt > 1 ? 'flaky' : 'passed', 1);
          else if (e.state === 'failed') bump('failed', 1);
          break;
        case 'blocked':
          bump('running', -1);
          bump('blocked', 1);
          break;
        case 'skip':
          bump('skipped', 1);
          break;
        case 'abort':
          break;
        default:
          break;
      }
      const done = total - (states.get('running') ?? 0) - (states.get('pending') ?? 0);
      const line = formatLiveLine(total, states, done);
      opts.onProgress?.(line);
      progressLine(line);
    },
  });

  const summary = await scheduler.run();
  clearProgressLine();
  return summary;
}

async function runReplay(
  plan: Plan,
  opts: RunOptions,
  paths: RunPaths,
  startedAt: string,
  errors: string[],
): Promise<RunResult> {
  const node = plan.tests.find((n) => n.id === opts.node);
  if (!node) throw new ArgusError(`unknown node: ${opts.node}`, EXIT.config);
  if (!opts.fromRun) throw new ArgusError('--node requires --from-run <id>', EXIT.config);

  const fromRunPaths = runPaths(resolveOutputDir(plan), opts.fromRun);
  const graph = buildGraph(
    plan.tests.map((n) => n.id),
    new Map(plan.tests.map((n) => [n.id, n.depends_on])),
  );
  const ancestorsMap: Record<string, string> = {};
  for (const anc of ancestorsOf(node.id, graph.depsOf)) {
    const pub = findPublishedAttempt(fromRunPaths, anc);
    if (pub) ancestorsMap[anc] = pub;
  }

  const out = await runNode({ plan, paths, node, attempt: 1, ancestors: ancestorsMap });
  const outcome = out.outcome === 'passed' ? 'passed' : 'failed';
  const exitCode = out.outcome === 'passed' ? EXIT.ok : EXIT.red;
  const report: RunReport = {
    runId: paths.runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    planFile: plan.file,
    baseUrl: plan.env.base_url,
    outcome,
    exitCode,
    nodes: [
      {
        id: node.id,
        state: outcome,
        attempts: 1,
        durationMs: out.durationMs,
        detail: out.detail,
      },
    ],
    errors,
  };
  writeReportJson(paths, report);
  writeHtmlReport(paths, report);
  writePointer(resolveOutputDir(plan), paths.runId);
  log(`replay ${node.id}: ${outcome}${out.detail ? ` — ${out.detail}` : ''}`);
  return { exitCode, outcome, report, paths, runId: paths.runId };
}

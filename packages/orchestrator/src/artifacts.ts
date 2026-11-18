import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ArgusError } from './errors.js';
import type { Plan, TestNode } from './plan/types.js';

export interface RunPaths {
  runId: string;
  runDir: string;
  artifactsRoot: string;
  reportsRoot: string;
  failuresRoot: string;
  reportJsonPath: string;
  htmlReportDir: string;
  gateJsonPath: string;
}

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const hash = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${hash}`;
}

export function runPaths(outputDir: string, runId: string): RunPaths {
  const runDir = path.join(outputDir, 'runs', runId);
  return {
    runId,
    runDir,
    artifactsRoot: path.join(runDir, 'artifacts'),
    reportsRoot: path.join(runDir, 'reports'),
    failuresRoot: path.join(runDir, 'failures'),
    reportJsonPath: path.join(runDir, 'report.json'),
    htmlReportDir: path.join(runDir, 'report'),
    gateJsonPath: path.join(runDir, 'gate.json'),
  };
}

export function createRunDirs(paths: RunPaths): void {
  mkdirSync(paths.artifactsRoot, { recursive: true });
  mkdirSync(paths.reportsRoot, { recursive: true });
  mkdirSync(paths.failuresRoot, { recursive: true });
  mkdirSync(paths.htmlReportDir, { recursive: true });
}

export function nodeAttemptDir(paths: RunPaths, nodeId: string, attempt: number): string {
  return path.join(paths.artifactsRoot, nodeId, `a${attempt}`);
}

export function nodeArtifactDir(paths: RunPaths, nodeId: string): string {
  return path.join(paths.artifactsRoot, nodeId);
}

/** Path of a node's successful attempt publish.json, or undefined if absent. */
export function findPublishedAttempt(paths: RunPaths, nodeId: string): string | undefined {
  const nodeDir = nodeArtifactDir(paths, nodeId);
  let entries: string[];
  try {
    entries = readdirSync(nodeDir);
  } catch {
    return undefined;
  }
  const attempts = entries
    .filter((e) => /^a\d+$/.test(e))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  // Highest-numbered attempt wins (latest successful publish is last written).
  for (let i = attempts.length - 1; i >= 0; i--) {
    const pub = path.join(nodeDir, attempts[i]!, 'publish.json');
    if (exists(pub)) return pub;
  }
  return undefined;
}

function exists(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Verify that every declared output exists and is non-empty. */
export function verifyOutputs(paths: RunPaths, node: TestNode, attempt: number): string[] {
  const dir = nodeAttemptDir(paths, node.id, attempt);
  const publishPath = path.join(dir, 'publish.json');
  let published: Record<string, unknown> = {};
  try {
    published = JSON.parse(readFileSync(publishPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return node.outputs.map((o) => `output \`${o}\` missing: ${publishPath} not readable`);
  }
  const missing: string[] = [];
  for (const key of node.outputs) {
    const value = published[key];
    if (value === undefined || value === null) missing.push(`output \`${key}\` missing or empty`);
    if (typeof value === 'string' && value.trim() === '')
      missing.push(`output \`${key}\` empty string`);
    if (Array.isArray(value) && value.length === 0) missing.push(`output \`${key}\` empty array`);
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    ) {
      missing.push(`output \`${key}\` empty object`);
    }
  }
  return missing;
}

/**
 * Build the ARGUS_ANCESTORS map for a node: ancestorId → path to its final
 * successful publish.json. Transitive ancestors included; non-ancestors absent.
 */
export function buildAncestorsMap(
  paths: RunPaths,
  plan: Plan,
  node: TestNode,
  ancestors: Set<string>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const anc of ancestors) {
    const pub = findPublishedAttempt(paths, anc);
    if (pub) map[anc] = pub;
  }
  return map;
}

export function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function resolveOutputDir(plan: Plan): string {
  if (!path.isAbsolute(plan.output_dir)) {
    return path.resolve(plan.project_root, plan.output_dir);
  }
  return plan.output_dir;
}

export function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new ArgusError(message);
}

import { existsSync } from 'node:fs';
import path from 'node:path';
import type { PlanIssue } from '../errors.js';
import { ArgusError } from '../errors.js';
import { ancestorsOf, buildGraph } from '../graph.js';
import type { Annotated } from './annotate.js';
import {
  DEFAULT_DRIFT_INTERVAL_SECONDS,
  DEFAULT_NODE_TIMEOUT_SECONDS,
  DEFAULT_STORM_PROBE_SECONDS,
  DEFAULT_STORM_TIMEOUT_SECONDS,
} from './types.js';
import type { EnvConfig, Plan, ResetConfig, TestNode } from './types.js';

interface Ctx {
  env: NodeJS.ProcessEnv;
  issues: PlanIssue[];
}

const HTTP_RE = /^https?:\/\//i;

function issue(ctx: Ctx, message: string, line?: number): void {
  ctx.issues.push(line ? { message, line } : { message });
}

function asMap(
  a: Annotated | undefined,
  ctx: Ctx,
  what: string,
): Record<string, Annotated> | undefined {
  if (a === undefined) return undefined;
  if (a.kind !== 'map') {
    issue(ctx, `${what} must be a mapping`, a.line);
    return undefined;
  }
  const out: Record<string, Annotated> = {};
  for (const e of a.entries) out[e.key] = e.value;
  return out;
}

function asSeq(a: Annotated | undefined, ctx: Ctx, what: string): Annotated[] | undefined {
  if (a === undefined) return undefined;
  if (a.kind !== 'seq') {
    issue(ctx, `${what} must be a list`, a.line);
    return undefined;
  }
  return a.items;
}

function asString(a: Annotated | undefined, ctx: Ctx, what: string): string | undefined {
  if (a === undefined) return undefined;
  if (a.kind !== 'scalar' || typeof a.value !== 'string') {
    issue(ctx, `${what} must be a string`, a.line);
    return undefined;
  }
  return a.value;
}

function str(a: Annotated | undefined, ctx: Ctx, what: string): string | undefined {
  const s = asString(a, ctx, what);
  return s !== undefined ? interpolate(s, a?.line, ctx) : undefined;
}

function asBool(a: Annotated | undefined, ctx: Ctx, what: string, fallback: boolean): boolean {
  if (a === undefined) return fallback;
  if (a.kind !== 'scalar') {
    issue(ctx, `${what} must be a boolean`, a.line);
    return fallback;
  }
  if (typeof a.value === 'boolean') return a.value;
  if (typeof a.value === 'string') {
    const s = interpolate(a.value, a.line, ctx);
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  issue(ctx, `${what} must be a boolean`, a.line);
  return fallback;
}

function asInt(a: Annotated | undefined, ctx: Ctx, what: string, fallback: number): number {
  if (a === undefined) return fallback;
  if (a.kind !== 'scalar') {
    issue(ctx, `${what} must be an integer`, a.line);
    return fallback;
  }
  if (typeof a.value === 'number') {
    if (!Number.isInteger(a.value)) {
      issue(ctx, `${what} must be an integer`, a.line);
      return fallback;
    }
    return a.value;
  }
  if (typeof a.value === 'string') {
    const s = interpolate(a.value, a.line, ctx);
    if (s !== '' && /^-?\d+$/.test(s)) return Number(s);
  }
  issue(ctx, `${what} must be an integer`, a.line);
  return fallback;
}

function interpolate(raw: string, line: number | undefined, ctx: Ctx): string {
  return raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const value = ctx.env[name];
    if (value === undefined) {
      issue(ctx, `environment variable \`${name}\` referenced in the plan is not set`, line);
      return `\${${name}}`;
    }
    return value;
  });
}

function asStringList(a: Annotated | undefined, ctx: Ctx, what: string): string[] {
  if (a === undefined) return [];
  const seq = asSeq(a, ctx, what);
  if (!seq) return [];
  const out: string[] = [];
  for (const item of seq) {
    const s = asString(item, ctx, what);
    if (s !== undefined) out.push(interpolate(s, item.line, ctx));
  }
  return out;
}

function parseHttpHeaders(
  a: Annotated | undefined,
  ctx: Ctx,
  what: string,
): Record<string, string> | undefined {
  if (a === undefined) return undefined;
  const map = asMap(a, ctx, what);
  if (!map) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    const s = asString(value, ctx, `${what}.${key}`);
    if (s !== undefined) out[key] = interpolate(s, value.line, ctx);
  }
  return out;
}

function parseJsonValue(a: Annotated | undefined, ctx: Ctx, what: string): unknown {
  if (a === undefined) return undefined;
  if (a.kind === 'scalar') {
    if (typeof a.value === 'string') return interpolate(a.value, a.line, ctx);
    return a.value;
  }
  if (a.kind === 'null') return null;
  if (a.kind === 'seq') {
    return a.items.map((item, i) => parseJsonValue(item, ctx, `${what}[${i}]`));
  }
  const out: Record<string, unknown> = {};
  for (const entry of a.entries) {
    out[entry.key] = parseJsonValue(entry.value, ctx, `${what}.${entry.key}`);
  }
  return out;
}

function parseJsonMap(
  a: Annotated | undefined,
  ctx: Ctx,
  what: string,
): Record<string, unknown> | undefined {
  if (a === undefined) return undefined;
  const map = asMap(a, ctx, what);
  if (!map) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(map))
    out[key] = parseJsonValue(value, ctx, `${what}.${key}`);
  return out;
}

export interface ValidatedPlan {
  plan: Plan;
  issues: PlanIssue[];
}

export function validatePlan(
  root: Annotated,
  planPath: string,
  env: NodeJS.ProcessEnv,
): ValidatedPlan {
  const ctx: Ctx = { env, issues: [] };
  const rootMap = asMap(root, ctx, 'plan document');
  if (!rootMap) {
    return { plan: undefined as unknown as Plan, issues: ctx.issues };
  }

  // ---- project_root / output_dir -------------------------------------------------
  const projectRootRaw = asString(rootMap['project_root'], ctx, 'project_root');
  const projectRoot = projectRootRaw
    ? path.resolve(path.dirname(planPath), interpolate(projectRootRaw, undefined, ctx))
    : path.dirname(planPath);
  const outputDirRaw = asString(rootMap['output_dir'], ctx, 'output_dir');
  const outputDir = outputDirRaw
    ? path.resolve(projectRoot, interpolate(outputDirRaw, undefined, ctx))
    : path.join(projectRoot, '.argus');

  // ---- env ------------------------------------------------------------------------
  const envMap = asMap(rootMap['env'], ctx, 'env');
  if (!envMap) {
    return { plan: undefined as unknown as Plan, issues: ctx.issues };
  }
  const baseUrlRaw = asString(envMap['base_url'], ctx, 'env.base_url');
  const baseUrl =
    baseUrlRaw !== undefined ? interpolate(baseUrlRaw, envMap['base_url']?.line, ctx) : undefined;
  if (baseUrl !== undefined && !HTTP_RE.test(baseUrl)) {
    issue(ctx, 'env.base_url must be an absolute http(s) URL', envMap['base_url']?.line);
  }
  const workers = asInt(envMap['workers'], ctx, 'env.workers', 1);
  if (workers !== undefined && workers < 1) {
    issue(ctx, 'env.workers must be >= 1', envMap['workers']?.line);
  }
  const markerMap = asMap(envMap['env_marker'], ctx, 'env.env_marker');
  let markerUrl: string | undefined;
  let markerExpect: Record<string, unknown> = {};
  if (markerMap) {
    markerUrl = str(markerMap['url'], ctx, 'env.env_marker.url');
    markerExpect = parseJsonMap(markerMap['expect_json'], ctx, 'env.env_marker.expect_json') ?? {};
  } else {
    issue(
      ctx,
      'env.env_marker is mandatory — the run cannot start without an environment marker',
      envMap['env_marker']?.line,
    );
  }
  const versionEndpoint = str(envMap['version_endpoint'], ctx, 'env.version_endpoint');
  const varsRaw = asMap(envMap['vars'], ctx, 'env.vars');
  const vars: Record<string, string> = {};
  if (varsRaw) {
    for (const [key, value] of Object.entries(varsRaw)) {
      const s = asString(value, ctx, `env.vars.${key}`);
      if (s !== undefined) vars[key] = interpolate(s, value.line, ctx);
    }
  }
  const globalTimeout = asInt(
    envMap['global_timeout_seconds'],
    ctx,
    'env.global_timeout_seconds',
    0,
  );
  const driftInterval = asInt(
    envMap['drift_interval_seconds'],
    ctx,
    'env.drift_interval_seconds',
    DEFAULT_DRIFT_INTERVAL_SECONDS,
  );
  const stormProbe = asInt(
    envMap['storm_probe_seconds'],
    ctx,
    'env.storm_probe_seconds',
    DEFAULT_STORM_PROBE_SECONDS,
  );
  const stormTimeout = asInt(
    envMap['storm_timeout_seconds'],
    ctx,
    'env.storm_timeout_seconds',
    DEFAULT_STORM_TIMEOUT_SECONDS,
  );

  const envConfig: EnvConfig = {
    base_url: baseUrl ?? '',
    workers: workers,
    version_endpoint: versionEndpoint && versionEndpoint !== 'off' ? versionEndpoint : undefined,
    env_marker: {
      url: markerUrl ?? '',
      expect_json: markerExpect,
      headers: parseHttpHeaders(markerMap?.['headers'], ctx, 'env.env_marker.headers'),
    },
    vars: Object.keys(vars).length > 0 ? vars : undefined,
    global_timeout_seconds: globalTimeout > 0 ? globalTimeout : undefined,
    drift_interval_seconds: driftInterval,
    storm_probe_seconds: stormProbe,
    storm_timeout_seconds: stormTimeout,
  };

  // ---- reset ----------------------------------------------------------------------
  const resetMap = asMap(rootMap['reset'], ctx, 'reset');
  if (!resetMap) {
    issue(ctx, 'reset is mandatory — every plan must define a reset hook', rootMap['reset']?.line);
    return { plan: undefined as unknown as Plan, issues: ctx.issues };
  }
  const resetHttpMap = asMap(resetMap['http'], ctx, 'reset.http');
  const resetCommand = asString(resetMap['command'], ctx, 'reset.command');
  const attestMap = asMap(resetMap['attest'], ctx, 'reset.attest');
  const verifyMap = asMap(resetMap['verify'], ctx, 'reset.verify');

  let attest: ResetConfig['attest'];
  if (attestMap) {
    const attestCommand = str(attestMap['command'], ctx, 'reset.attest.command');
    const attestExpect =
      parseJsonMap(attestMap['expect_json'], ctx, 'reset.attest.expect_json') ?? {};
    attest = { command: attestCommand ?? '', expect_json: attestExpect };
  }
  if (resetCommand && !attest) {
    issue(
      ctx,
      'reset.command requires a read-only reset.attest.command, which runs first and is compared field-by-field with the env marker',
      resetMap['command']?.line,
    );
  }

  let verifyUrl: string | undefined;
  let verifyStatus: number | undefined;
  let verifyJson: Record<string, unknown> | undefined;
  if (verifyMap) {
    verifyUrl = asString(verifyMap['url'], ctx, 'reset.verify.url');
    verifyStatus = asInt(verifyMap['expect_status'], ctx, 'reset.verify.expect_status', 0);
    verifyJson = parseJsonMap(verifyMap['expect_json'], ctx, 'reset.verify.expect_json');
    if (verifyUrl === undefined && verifyStatus === undefined && verifyJson === undefined) {
      issue(
        ctx,
        'reset.verify must define at least one check (url, expect_status, or expect_json)',
        resetMap['verify']?.line,
      );
    }
  } else {
    issue(
      ctx,
      'reset.verify is mandatory — reset must be verified or the run aborts',
      resetMap['verify']?.line,
    );
  }

  const reset: ResetConfig = {
    http: resetHttpMap
      ? {
          url: interpolate(
            asString(resetHttpMap['url'], ctx, 'reset.http.url') ?? '',
            resetHttpMap['url']?.line,
            ctx,
          ),
          method: asString(resetHttpMap['method'], ctx, 'reset.http.method') ?? 'POST',
          headers: parseHttpHeaders(resetHttpMap['headers'], ctx, 'reset.http.headers'),
        }
      : undefined,
    command: resetCommand ? interpolate(resetCommand, resetMap['command']?.line, ctx) : undefined,
    attest,
    verify: {
      url: verifyUrl ? interpolate(verifyUrl, verifyMap?.['url']?.line, ctx) : undefined,
      expect_status: verifyStatus && verifyStatus > 0 ? verifyStatus : undefined,
      expect_json: verifyJson,
    },
  };
  if (!reset.http && !reset.command) {
    issue(ctx, 'reset must define either reset.http or reset.command', rootMap['reset']?.line);
  }

  // ---- tests ----------------------------------------------------------------------
  const testsSeq = asSeq(rootMap['tests'], ctx, 'tests');
  if (!testsSeq || testsSeq.length === 0) {
    issue(ctx, 'tests must be a non-empty list', rootMap['tests']?.line);
    return { plan: undefined as unknown as Plan, issues: ctx.issues };
  }

  const nodes: TestNode[] = [];
  const ids = new Set<string>();
  const depsOf = new Map<string, string[]>();
  for (const item of testsSeq) {
    const nodeMap = asMap(item, ctx, 'tests[] entry');
    if (!nodeMap) continue;
    const id = asString(nodeMap['id'], ctx, 'tests[].id');
    if (id === undefined) continue;
    if (ids.has(id)) {
      issue(ctx, `duplicate node id \`${id}\``, nodeMap['id']?.line);
      continue;
    }
    ids.add(id);
    const kindRaw = asString(nodeMap['kind'], ctx, `tests.${id}.kind`);
    const kind: TestNode['kind'] = kindRaw === 'crawl' ? 'crawl' : 'test';
    if (kindRaw !== undefined && kindRaw !== 'test' && kindRaw !== 'crawl') {
      issue(ctx, `tests.${id}.kind must be 'test' or 'crawl'`, nodeMap['kind']?.line);
    }
    const spec = asString(nodeMap['spec'], ctx, `tests.${id}.spec`);
    const dependsOn = asStringList(nodeMap['depends_on'], ctx, `tests.${id}.depends_on`);
    const critical = asBool(nodeMap['critical'], ctx, `tests.${id}.critical`, false);
    const idempotent = asBool(nodeMap['idempotent'], ctx, `tests.${id}.idempotent`, false);
    const retries = asInt(nodeMap['retries'], ctx, `tests.${id}.retries`, 0);
    if (retries < 0) issue(ctx, `tests.${id}.retries must be >= 0`, nodeMap['retries']?.line);
    if (retries > 0 && !idempotent) {
      issue(
        ctx,
        `tests.${id}.retries > 0 requires idempotent: true — retrying a non-idempotent node corrupts state`,
        nodeMap['retries']?.line,
      );
    }
    const outputs = asStringList(nodeMap['outputs'], ctx, `tests.${id}.outputs`);
    const reads = asStringList(nodeMap['reads'], ctx, `tests.${id}.reads`);
    const writes = asStringList(nodeMap['writes'], ctx, `tests.${id}.writes`);
    const exclusive = asBool(nodeMap['exclusive'], ctx, `tests.${id}.exclusive`, false);
    const timeout = asInt(
      nodeMap['timeout_seconds'],
      ctx,
      `tests.${id}.timeout_seconds`,
      DEFAULT_NODE_TIMEOUT_SECONDS,
    );
    const urls = asStringList(nodeMap['urls'], ctx, `tests.${id}.urls`);
    const sitemap = asString(nodeMap['sitemap'], ctx, `tests.${id}.sitemap`);
    const login = asString(nodeMap['login'], ctx, `tests.${id}.login`);

    if (kind === 'test' && spec === undefined) {
      issue(ctx, `tests.${id}.spec is required for kind: test`, item.line);
    }
    if (kind === 'crawl' && urls.length === 0 && sitemap === undefined) {
      issue(ctx, `tests.${id} (crawl) must declare urls and/or sitemap`, item.line);
    }

    nodes.push({
      id,
      kind,
      spec: spec ? interpolate(spec, nodeMap['spec']?.line, ctx) : undefined,
      depends_on: dependsOn,
      critical,
      idempotent,
      retries,
      outputs,
      reads,
      writes,
      exclusive,
      timeout_seconds: timeout,
      line: item.line,
      urls,
      sitemap: sitemap ? interpolate(sitemap, nodeMap['sitemap']?.line, ctx) : undefined,
      login: login ? interpolate(login, nodeMap['login']?.line, ctx) : undefined,
    });
    depsOf.set(id, dependsOn);
  }

  // ---- graph checks ---------------------------------------------------------------
  for (const node of nodes) {
    for (const dep of node.depends_on) {
      if (!ids.has(dep)) {
        issue(ctx, `tests.${node.id} depends on unknown node \`${dep}\``, node.line);
      }
    }
  }
  if (ctx.issues.length > 0) return { plan: undefined as unknown as Plan, issues: ctx.issues };

  // Cycle detection throws on any cycle; the graph edges are reused below.
  buildGraph([...ids], depsOf);

  // reads ⊆ ancestors' outputs
  for (const node of nodes) {
    const ancestors = ancestorsOf(node.id, depsOf);
    const available = new Set<string>();
    for (const anc of ancestors) {
      const ancNode = nodes.find((n) => n.id === anc);
      for (const out of ancNode?.outputs ?? []) available.add(out);
    }
    for (const read of node.reads) {
      if (!available.has(read)) {
        issue(
          ctx,
          `tests.${node.id} reads \`${read}\` but no ancestor declares it in outputs`,
          node.line,
        );
      }
    }
  }

  // spec files must exist
  for (const node of nodes) {
    if (node.kind === 'test' && node.spec) {
      const abs = path.resolve(projectRoot, node.spec);
      if (!existsSync(abs)) {
        issue(ctx, `tests.${node.id}: spec file not found: ${node.spec}`, node.line);
      }
    }
    if (node.kind === 'crawl' && node.login) {
      const abs = path.resolve(projectRoot, node.login);
      if (!existsSync(abs)) {
        issue(ctx, `tests.${node.id}: login spec not found: ${node.login}`, node.line);
      }
    }
  }

  if (ctx.issues.length > 0) return { plan: undefined as unknown as Plan, issues: ctx.issues };

  const plan: Plan = {
    file: planPath,
    project_root: projectRoot,
    output_dir: outputDir,
    env: envConfig,
    reset,
    tests: nodes,
  };
  return { plan, issues: [] };
}

// Retained for use by load.ts — surfaces the environment-variable lookup as an error.
export function resolveEnv(value: string, env: NodeJS.ProcessEnv): string {
  const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = env[name];
    if (v === undefined) throw new ArgusError(`environment variable \`${name}\` is not set`);
    return v;
  });
  return out;
}

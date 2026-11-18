#!/usr/bin/env node
import { ArgusError, PlanError } from './errors.js';
import { EXIT } from './exitcodes.js';
import { log } from './log.js';
import { run } from './run.js';
import { printSchema } from './schema.js';
import { VERSION } from './version.js';

const USAGE = `Argus — dependency-graph orchestrator for Playwright E2E tests.

Usage:
  e2e-orchestrator run [plan.yaml] [--node X --from-run <id>] [--unsafe-skip-guard]
  e2e-orchestrator --print-schema
  e2e-orchestrator --version

Exit codes:
  0 green  1 red  2 config  3 invalid  4 incomplete  130 SIGINT`;

function valueOf(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(USAGE);
    process.exitCode = args.length === 0 ? EXIT.config : EXIT.ok;
    return;
  }
  if (args[0] === '--version' || args[0] === '-v') {
    console.log(VERSION);
    return;
  }
  if (args[0] === '--print-schema') {
    console.log(printSchema());
    return;
  }
  if (args[0] !== 'run') {
    console.error(`unknown command: ${args[0]}`);
    console.log(USAGE);
    process.exitCode = EXIT.config;
    return;
  }

  const rest = args.slice(1);
  const planPath = rest.find((a) => !a.startsWith('-')) ?? 'e2e-plan.yaml';
  const node = valueOf(rest, '--node');
  const fromRun = valueOf(rest, '--from-run');
  const unsafeSkipGuard = rest.includes('--unsafe-skip-guard');

  const controller = new AbortController();
  process.on('SIGINT', () => {
    controller.abort();
    process.exitCode = EXIT.sigint;
  });

  try {
    const result = await run(planPath, {
      node,
      fromRun,
      unsafeSkipGuard,
      signal: controller.signal,
    });
    log(`outcome: ${result.outcome} (exit ${result.exitCode})`);
    log(`report: ${result.paths.reportJsonPath}`);
    process.exitCode = result.exitCode;
  } catch (err) {
    if (err instanceof PlanError) {
      console.error(err.message);
      process.exitCode = EXIT.config;
    } else if (err instanceof ArgusError) {
      console.error(err.message);
      process.exitCode = err.exitCode;
    } else {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = EXIT.invalid;
    }
  }
}

void main();

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const demoDir = path.join(root, 'examples', 'demo-app');
const cli = path.join(root, 'packages', 'orchestrator', 'dist', 'cli.js');
const serverJs = path.join(demoDir, 'dist', 'server.js');
const baseUrl = process.env.DEMO_BASE_URL ?? 'http://localhost:3000';
const dbPath = process.env.ARGUS_DEMO_DB ?? path.join(demoDir, 'demo.db');

const server = spawn(process.execPath, [serverJs], {
  cwd: demoDir,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: '3000', ARGUS_DEMO_DB: dbPath },
});
server.stdout.on('data', (d) => process.stdout.write(d));
server.stderr.on('data', (d) => process.stderr.write(d));

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(baseUrl + '/api/health');
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('demo server did not start in time');
    await new Promise((r) => setTimeout(r, 300));
  }
}

function runCli() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'run', 'e2e-plan.yaml'], {
      cwd: demoDir,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

let cliCode = 1;
try {
  await waitForHealth();
  cliCode = await runCli();
  const runId = readFileSync(path.join(demoDir, '.argus', 'last-run'), 'utf8').trim();
  const report = JSON.parse(
    readFileSync(path.join(demoDir, '.argus', 'runs', runId, 'report.json'), 'utf8'),
  );
  console.log(`demo e2e outcome: ${report.outcome} (${report.nodes.length} nodes)`);
  process.exitCode = report.outcome === 'passed' ? 0 : cliCode || 1;
} finally {
  server.kill();
}

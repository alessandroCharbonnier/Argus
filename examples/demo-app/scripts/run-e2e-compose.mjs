import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const demoDir = path.join(root, 'examples', 'demo-app');
const cli = path.join(root, 'packages', 'orchestrator', 'dist', 'cli.js');
const baseUrl = 'http://localhost:3000';

function compose(args) {
  const r = spawnSync('docker', ['compose', ...args], { cwd: demoDir, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('docker compose failed — is Docker running?');
    process.exit(r.status ?? 1);
  }
}

async function waitForHealth() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(baseUrl + '/api/health');
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('compose demo did not start in time');
    await new Promise((r) => setTimeout(r, 500));
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
  compose(['up', '-d', '--build']);
  await waitForHealth();
  cliCode = await runCli();
  const runId = readFileSync(path.join(demoDir, '.argus', 'last-run'), 'utf8').trim();
  const report = JSON.parse(
    readFileSync(path.join(demoDir, '.argus', 'runs', runId, 'report.json'), 'utf8'),
  );
  console.log(`demo (compose) e2e outcome: ${report.outcome} (${report.nodes.length} nodes)`);
  process.exitCode = report.outcome === 'passed' ? 0 : cliCode || 1;
} finally {
  compose(['down']);
}

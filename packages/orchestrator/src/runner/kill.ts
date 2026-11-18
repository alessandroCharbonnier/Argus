import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { log } from '../log.js';

/**
 * Kill a process and its whole tree. Playwright/Chromium spawn children that
 * must not survive a per-node timeout.
 */
export function killTree(child: ChildProcess, timeoutMs = 5_000): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  // Best-effort final nudge if it still lingers.
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }, timeoutMs);
  timer.unref();
}

export interface SpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface SpawnResult {
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export function spawnWithTimeout(opts: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      opts.onStdout?.(s);
    });
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      opts.onStderr?.(s);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs);
    timer.unref();

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log(`spawn error for ${opts.command}: ${err.message}`);
      resolve({ code: null, timedOut, stdout, stderr });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, timedOut, stdout, stderr });
    });
  });
}

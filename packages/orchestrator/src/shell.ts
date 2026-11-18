import { spawnSync } from 'node:child_process';
import { GuardError } from './errors.js';

export interface ShellResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a command through the platform shell (`/bin/sh -c` on POSIX,
 * `cmd.exe /c` on Windows) — the plan author owns the command text.
 */
export function runShell(command: string, cwd: string): ShellResult {
  const result = spawnSync(command, {
    shell: true,
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (result.error) {
    throw new GuardError(`failed to spawn command: ${(result.error as Error).message}`);
  }
  return { status: result.status ?? 0, stdout, stderr };
}

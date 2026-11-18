import { GuardError } from '../errors.js';
import { httpRequest, resolveUrl } from '../http.js';
import type { EnvConfig } from '../plan/types.js';

/**
 * Polls `version_endpoint` and re-checks the env marker on every tick.
 * A mid-run change aborts the run as `invalid: env changed`.
 */
export class DriftGuard {
  private version: string | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private env: EnvConfig,
    private onAbort: (reason: string) => void,
  ) {}

  async initial(): Promise<void> {
    if (!this.env.version_endpoint) return;
    this.version = await this.fetchVersion();
  }

  start(markerChecker: () => Promise<void>): void {
    if (!this.env.version_endpoint) return;
    const intervalMs = this.env.drift_interval_seconds * 1000;
    this.timer = setInterval(() => {
      void this.tick(markerChecker);
    }, intervalMs);
    this.timer.unref?.();
  }

  private async tick(markerChecker: () => Promise<void>): Promise<void> {
    try {
      const current = await this.fetchVersion();
      if (this.version !== undefined && current !== this.version) {
        this.stop();
        this.onAbort('invalid: env changed');
        return;
      }
      this.version = current;
      await markerChecker();
    } catch (err) {
      this.stop();
      this.onAbort(`invalid: ${(err as Error).message}`);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async fetchVersion(): Promise<string> {
    const url = resolveUrl(this.env.version_endpoint!, this.env.base_url);
    const res = await httpRequest(url, { timeoutMs: 10_000 });
    return res.bodyText.trim();
  }
}

/** Preflight: the base URL must respond over HTTP (any status = up). */
export async function preflightProbe(baseUrl: string): Promise<void> {
  try {
    await httpRequest(baseUrl, { timeoutMs: 15_000 });
  } catch (err) {
    throw new GuardError(
      `preflight failed: base_url ${baseUrl} unreachable (${(err as Error).message})`,
    );
  }
}

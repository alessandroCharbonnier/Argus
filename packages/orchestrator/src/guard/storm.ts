import { StormAbort } from '../errors.js';

export interface HttpEntry {
  status?: number;
  error?: string;
  timestamp: number;
}

const INFRA_ERROR =
  /(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|CONNECTION_REFUSED|NAME_NOT_RESOLVED|TIMED_OUT|INTERNET_DISCONNECTED|ERR_CONNECTION|ERR_NETWORK|ERR_TIMED_OUT)/i;

/** A node failed on infra iff its HTTP log shows 5xx or a connection-level error in the window. */
export function classifyInfra(http: HttpEntry[], windowStart: number): boolean {
  return http.some(
    (e) =>
      e.timestamp >= windowStart &&
      ((e.status !== undefined && e.status >= 500) ||
        (e.error !== undefined && INFRA_ERROR.test(e.error))),
  );
}

export type StormState = 'healthy' | 'frozen' | 'failed';

export interface StormOptions {
  probe: () => Promise<boolean>;
  probeMs: number;
  timeoutMs: number;
}

/**
 * Failure-storm circuit breaker: freeze on infra signals, probe health, resume
 * if healthy, abort `invalid: env unhealthy` if the storm outlives the timeout.
 */
export class StormController {
  private state: StormState = 'healthy';
  private frozenSince = 0;

  constructor(private opts: StormOptions) {}

  isFrozen(): boolean {
    return this.state === 'frozen';
  }

  /** Infra-signal classification window: the freeze start, or 0 before any freeze. */
  get windowStart(): number {
    return this.state === 'frozen' ? this.frozenSince : 0;
  }

  freeze(now = Date.now()): void {
    if (this.state === 'healthy') {
      this.state = 'frozen';
      this.frozenSince = now;
    }
  }

  async waitForClear(signal?: AbortSignal): Promise<void> {
    if (this.state !== 'frozen') return;
    const deadline = this.frozenSince + this.opts.timeoutMs;
    for (;;) {
      if (signal?.aborted) throw new StormAbort('run aborted during storm freeze');
      const healthy = await this.opts.probe();
      if (healthy) {
        this.state = 'healthy';
        return;
      }
      if (Date.now() > deadline) {
        this.state = 'failed';
        throw new StormAbort('environment unhealthy: infra failure storm did not clear in time');
      }
      await sleep(this.opts.probeMs, signal);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new StormAbort('run aborted'));
      },
      { once: true },
    );
  });
}

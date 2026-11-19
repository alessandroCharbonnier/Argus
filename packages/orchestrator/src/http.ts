import { GuardError } from './errors.js';

export interface HttpResponse {
  status: number;
  bodyText: string;
  bodyJson: unknown;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const GET_RETRY_ATTEMPTS = 3;
const GET_RETRY_BACKOFF_MS = 600;

export async function httpRequest(
  url: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    expectStatus?: number;
  } = {},
): Promise<HttpResponse> {
  const method = opts.method ?? 'GET';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Read-only guard probes hit Docker-published ports, which on Windows/WSL2
  // intermittently reset the first connection (ECONNRESET). Retry GETs so a
  // transient reset does not abort the whole run.
  const attempts = method === 'GET' ? GET_RETRY_ATTEMPTS : 1;
  let lastErr: Error | undefined;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: opts.headers,
        signal: controller.signal,
        redirect: 'follow',
      });
    } catch (err) {
      clearTimeout(timer);
      lastErr = err as Error;
      if (attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, GET_RETRY_BACKOFF_MS * (attempt + 1)));
        continue;
      }
      const cause = (lastErr as Error & { cause?: Error }).cause;
      const detail = cause ? `${cause.message} (${cause.name})` : lastErr.message;
      throw new GuardError(`request failed: ${method} ${url}: ${detail}`);
    }
    clearTimeout(timer);
    const bodyText = await res.text();
    let bodyJson: unknown;
    try {
      bodyJson = bodyText.length > 0 ? (JSON.parse(bodyText) as unknown) : null;
    } catch {
      bodyJson = undefined;
    }
    if (opts.expectStatus !== undefined && res.status !== opts.expectStatus) {
      throw new GuardError(
        `expected status ${opts.expectStatus} from ${url}, got ${res.status}: ${bodyText.slice(0, 200)}`,
      );
    }
    return { status: res.status, bodyText, bodyJson };
  }

  const cause = (lastErr as Error & { cause?: Error } | undefined)?.cause;
  const detail = cause ? `${cause.message} (${cause.name})` : lastErr?.message;
  throw new GuardError(`request failed: ${method} ${url}: ${detail ?? 'unknown'}`);
}

/** Resolve a possibly-relative URL against the plan base URL. */
export function resolveUrl(maybeRelative: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  if (!maybeRelative.startsWith('/')) maybeRelative = '/' + maybeRelative;
  return baseUrl.replace(/\/+$/, '') + maybeRelative;
}

import { GuardError } from './errors.js';

export interface HttpResponse {
  status: number;
  bodyText: string;
  bodyJson: unknown;
}

const DEFAULT_TIMEOUT_MS = 10_000;

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
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
    throw new GuardError(`request failed: ${method} ${url}: ${(err as Error).message}`);
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

/** Resolve a possibly-relative URL against the plan base URL. */
export function resolveUrl(maybeRelative: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  if (!maybeRelative.startsWith('/')) maybeRelative = '/' + maybeRelative;
  return baseUrl.replace(/\/+$/, '') + maybeRelative;
}

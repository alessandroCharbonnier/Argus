import { GuardError } from '../errors.js';
import { httpRequest, resolveUrl } from '../http.js';
import type { EnvMarkerConfig } from '../plan/types.js';
import { deepSubsetEqual } from './subset.js';

export interface MarkerCheck {
  marker: Record<string, unknown>;
  url: string;
}

/** Fetch and validate the environment marker. Hard-aborts on mismatch. */
export async function checkEnvMarker(cfg: EnvMarkerConfig, baseUrl: string): Promise<MarkerCheck> {
  const url = resolveUrl(cfg.url, baseUrl);
  const res = await httpRequest(url, { headers: cfg.headers });
  const json = res.bodyJson;
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new GuardError(`environment marker at ${url} did not return a JSON object`);
  }
  const mismatches = deepSubsetEqual(cfg.expect_json, json);
  if (mismatches.length > 0) {
    throw new GuardError(`environment marker mismatch at ${url}: ${mismatches.join('; ')}`);
  }
  return { marker: json as Record<string, unknown>, url };
}

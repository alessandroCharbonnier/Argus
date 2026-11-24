import type { ControlLike } from './identity.js';
import { identityKey, normalizeControl } from './identity.js';

export interface GateInput {
  /** Crawler-denominator controls (both passes unioned). */
  controls: ControlLike[];
  /** Recorder-seen controls from passed nodes. */
  recorded: ControlLike[];
  /** User-maintained exclusion list (exact identity keys). */
  exclusions: string[];
  /** Route patterns collapsing dynamic routes into one identity (plan `gate.route_patterns`). */
  routePatterns?: string[];
}

export interface GateReport {
  denominator: number;
  numerator: number;
  covered: string[];
  uncovered: string[];
  denominatorKeys: string[];
  /** Controls excluded by the user (not counted as uncovered). */
  excluded: string[];
}

export function computeGate(input: GateInput): GateReport {
  const patterns = input.routePatterns ?? [];
  const denominator = new Map<string, ControlLike>();
  for (const c of input.controls) {
    const key = identityKey(normalizeControl(c, patterns));
    if (!denominator.has(key)) denominator.set(key, c);
  }
  const numerator = new Set(input.recorded.map((r) => identityKey(normalizeControl(r, patterns))));
  const excluded = new Set(input.exclusions);
  const covered = [...denominator.keys()].filter((k) => numerator.has(k));
  const uncovered = [...denominator.keys()].filter((k) => !numerator.has(k) && !excluded.has(k));
  const excludedFound = [...denominator.keys()].filter((k) => excluded.has(k));
  return {
    denominator: denominator.size,
    numerator: covered.length,
    covered,
    uncovered,
    denominatorKeys: [...denominator.keys()],
    excluded: excludedFound,
  };
}

/**
 * Strict-typed subset equality: every field in `expected` must be present in
 * `actual` with the same type and value (recursively). Extra fields in
 * `actual` are ignored. `1` never equals `"1"`.
 */
export function deepSubsetEqual(expected: unknown, actual: unknown, path = '$'): string[] {
  const mismatches: string[] = [];
  if (expected === null || typeof expected !== 'object') {
    if (typeof expected !== typeof actual || expected !== actual) {
      mismatches.push(
        `${path}: expected ${JSON.stringify(expected)} (${typeof expected}), got ${JSON.stringify(actual)} (${typeof actual})`,
      );
    }
    return mismatches;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      mismatches.push(`${path}: expected array, got ${typeof actual}`);
      return mismatches;
    }
    if (expected.length !== actual.length) {
      mismatches.push(`${path}: expected array of length ${expected.length}, got ${actual.length}`);
      return mismatches;
    }
    expected.forEach((item, i) => {
      mismatches.push(...deepSubsetEqual(item, actual[i], `${path}[${i}]`));
    });
    return mismatches;
  }
  if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) {
    mismatches.push(`${path}: expected object, got ${typeof actual}`);
    return mismatches;
  }
  const actualRecord = actual as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    mismatches.push(...deepSubsetEqual(value, actualRecord[key], `${path}.${key}`));
  }
  return mismatches;
}

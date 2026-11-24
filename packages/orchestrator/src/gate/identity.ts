export interface ControlLike {
  route: string;
  tag: string;
  name?: string;
  text?: string;
  testId?: string;
  href?: string;
}

/**
 * One identity function for both the crawler denominator and the recorder
 * numerator. Links key by destination; other controls key by
 * tag + route + accessible-name|test-id|text. Repeated controls on a page
 * (500 "Delete" buttons) collapse to one.
 */
export function identityKey(c: ControlLike): string {
  if (c.tag === 'a' && c.href) return `link:${c.href}`;
  const label = c.name ?? c.testId ?? c.text ?? '';
  return `${c.tag}:${c.route}:${label}`;
}

/**
 * Collapse a concrete path onto the first matching route pattern
 * (`/admin/users/:id` matches `/admin/users/0b1f…`). `:name` segments match
 * any one non-empty segment; literal segments must match exactly. A path that
 * matches no pattern is returned unchanged.
 */
export function normalizeRoute(route: string, patterns: readonly string[]): string {
  if (patterns.length === 0) return route;
  const segs = route.split('/');
  for (const pattern of patterns) {
    const psegs = pattern.split('/');
    if (psegs.length !== segs.length) continue;
    const ok = psegs.every((p, i) => (p.startsWith(':') ? segs[i] !== '' : p === segs[i]));
    if (ok) return pattern;
  }
  return route;
}

/** Apply route patterns to a control's route and (internal) link href. */
export function normalizeControl<T extends ControlLike>(c: T, patterns: readonly string[]): T {
  if (patterns.length === 0) return c;
  const out = { ...c, route: normalizeRoute(c.route, patterns) };
  if (c.href && c.href.startsWith('/')) {
    const cut = c.href.search(/[?#]/);
    const pathPart = cut === -1 ? c.href : c.href.slice(0, cut);
    const rest = cut === -1 ? '' : c.href.slice(cut);
    out.href = normalizeRoute(pathPart, patterns) + rest;
  }
  return out;
}

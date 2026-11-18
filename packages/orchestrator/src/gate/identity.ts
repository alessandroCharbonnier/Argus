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

import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { Pair, YAMLMap, YAMLSeq } from 'yaml';
import { PlanError } from '../errors.js';

export type Annotated =
  | { kind: 'scalar'; value: unknown; line: number }
  | { kind: 'map'; entries: AnnotatedEntry[]; line: number }
  | { kind: 'seq'; items: Annotated[]; line: number }
  | { kind: 'null'; line: number };

export interface AnnotatedEntry {
  key: string;
  keyLine: number;
  value: Annotated;
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineOf(offset: number | undefined, starts: number[]): number {
  if (offset === undefined) return 1;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function nodeRange(node: unknown): number | undefined {
  const n = node as { range?: [number, number, number] };
  return n.range?.[0];
}

function annotateNode(node: unknown, starts: number[]): Annotated {
  if (node === null || node === undefined) return { kind: 'null', line: 1 };
  const line = lineOf(nodeRange(node), starts);
  if (isMap(node)) {
    return {
      kind: 'map',
      line,
      entries: (node as YAMLMap).items.map((p) => annotatePair(p, starts)),
    };
  }
  if (isSeq(node)) {
    return {
      kind: 'seq',
      line,
      items: (node as YAMLSeq).items.map((n) => annotateNode(n, starts)),
    };
  }
  if (isScalar(node)) {
    if (node.value === null) return { kind: 'null', line };
    return { kind: 'scalar', value: node.value, line };
  }
  return { kind: 'scalar', value: null, line };
}

function annotatePair(pair: Pair, starts: number[]): AnnotatedEntry {
  const key = isScalar(pair.key) ? String(pair.key.value) : '?';
  const keyLine = lineOf(nodeRange(pair.key), starts);
  return { key, keyLine, value: annotateNode(pair.value, starts) };
}

/** Parse YAML into an annotated tree carrying `line` for every node. */
export function annotateYaml(text: string): Annotated {
  const doc = parseDocument(text, { prettyErrors: true });
  if (doc.errors.length > 0) {
    const err = doc.errors[0]!;
    const line = err.linePos?.[0]?.line;
    throw new PlanError([{ message: `YAML parse error: ${err.message}`, line }]);
  }
  const starts = computeLineStarts(text);
  return annotateNode(doc.contents, starts);
}

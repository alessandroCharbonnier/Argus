import { describe, expect, it } from 'vitest';
import { ancestorsOf, buildGraph, dependentsClosure } from '../src/graph.js';
import { PlanError } from '../src/errors.js';

function graphOf(edges: Record<string, string[]>) {
  const ids = Object.keys(edges);
  const depsOf = new Map<string, string[]>(Object.entries(edges));
  return buildGraph(ids, depsOf);
}

describe('graph', () => {
  it('topologically sorts dependencies before dependents', () => {
    const g = graphOf({ a: [], b: ['a'], c: ['a', 'b'] });
    expect(g.order).toEqual(['a', 'b', 'c']);
  });

  it('allows diamond dependencies', () => {
    const g = graphOf({ a: [], b: ['a'], c: ['a'], d: ['b', 'c'] });
    expect(g.order.indexOf('d')).toBeGreaterThan(g.order.indexOf('b'));
    expect(g.order.indexOf('d')).toBeGreaterThan(g.order.indexOf('c'));
  });

  it('detects a simple cycle', () => {
    expect(() => graphOf({ a: ['b'], b: ['a'] })).toThrow(PlanError);
  });

  it('detects a self-cycle', () => {
    expect(() => graphOf({ a: ['a'] })).toThrow(PlanError);
  });

  it('reports the cycle path', () => {
    try {
      graphOf({ a: ['b'], b: ['c'], c: ['a'] });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as PlanError).message).toContain('cycle');
    }
  });

  it('computes transitive ancestors', () => {
    const g = graphOf({ a: [], b: ['a'], c: ['b'] });
    expect([...ancestorsOf('c', g.depsOf)].sort()).toEqual(['a', 'b']);
  });

  it('computes transitive dependents', () => {
    const g = graphOf({ a: [], b: ['a'], c: ['b'] });
    expect([...dependentsClosure('a', g.dependentsOf)].sort()).toEqual(['b', 'c']);
  });
});

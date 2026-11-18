import { describe, expect, it } from 'vitest';
import { classifyInfra } from '../src/guard/storm.js';
import { deepSubsetEqual } from '../src/guard/subset.js';
import { identityKey } from '../src/gate/identity.js';
import { computeGate } from '../src/gate/gate.js';

describe('deepSubsetEqual (strict-typed subset)', () => {
  it('passes when actual has extra fields', () => {
    expect(deepSubsetEqual({ env: 'staging' }, { env: 'staging', db: 'x' })).toEqual([]);
  });

  it('fails on value mismatch', () => {
    expect(deepSubsetEqual({ env: 'staging' }, { env: 'prod' })).toHaveLength(1);
  });

  it('fails on type mismatch (1 !== "1")', () => {
    expect(deepSubsetEqual({ v: 1 }, { v: '1' })).toHaveLength(1);
  });

  it('compares nested objects recursively', () => {
    expect(deepSubsetEqual({ a: { b: 1 } }, { a: { b: 1, c: 2 } })).toEqual([]);
    expect(deepSubsetEqual({ a: { b: 1 } }, { a: { b: 2 } })).toHaveLength(1);
  });

  it('compares arrays by length and element', () => {
    expect(deepSubsetEqual([1, 2], [1, 2])).toEqual([]);
    expect(deepSubsetEqual([1, 2], [1, 2, 3])).toHaveLength(1);
  });
});

describe('classifyInfra', () => {
  it('flags 5xx statuses inside the window', () => {
    expect(classifyInfra([{ status: 502, timestamp: 10 }], 0)).toBe(true);
  });

  it('flags connection errors', () => {
    expect(classifyInfra([{ error: 'ECONNREFUSED', timestamp: 10 }], 0)).toBe(true);
  });

  it('does not flag CORS or generic request failures as infra', () => {
    expect(classifyInfra([{ error: 'net::ERR_FAILED', timestamp: 10 }], 0)).toBe(false);
  });

  it('ignores 4xx and assertion failures', () => {
    expect(classifyInfra([{ status: 404, timestamp: 10 }], 0)).toBe(false);
  });

  it('respects the freeze window', () => {
    expect(classifyInfra([{ status: 502, timestamp: 5 }], 10)).toBe(false);
  });
});

describe('identityKey', () => {
  it('keys links by destination href', () => {
    expect(identityKey({ route: '/users', tag: 'a', href: '/users/1', text: 'View' })).toBe(
      'link:/users/1',
    );
  });

  it('keys buttons by tag + route + accessible name', () => {
    const a = identityKey({ route: '/users', tag: 'button', name: 'Delete' });
    const b = identityKey({ route: '/users', tag: 'button', name: 'Delete' });
    expect(a).toBe(b);
  });
});

describe('computeGate', () => {
  const button = { route: '/', tag: 'button', name: 'Create' };
  const other = { route: '/', tag: 'button', name: 'Delete' };

  it('passes when every control is exercised', () => {
    const gate = computeGate({ controls: [button], recorded: [button], exclusions: [] });
    expect(gate.uncovered).toEqual([]);
    expect(gate.denominator).toBe(1);
    expect(gate.numerator).toBe(1);
  });

  it('flags uncovered controls', () => {
    const gate = computeGate({ controls: [button, other], recorded: [button], exclusions: [] });
    expect(gate.uncovered).toHaveLength(1);
  });

  it('honors the exclusion list', () => {
    const gate = computeGate({ controls: [other], recorded: [], exclusions: ['button:/:Delete'] });
    expect(gate.uncovered).toEqual([]);
    expect(gate.excluded).toHaveLength(1);
  });
});

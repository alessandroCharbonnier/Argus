import { PlanError } from './errors.js';

export interface Graph {
  ids: string[];
  depsOf: Map<string, string[]>;
  dependentsOf: Map<string, string[]>;
  order: string[];
}

export function buildGraph(ids: string[], depsOf: Map<string, string[]>): Graph {
  const dependentsOf = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const id of ids) {
    for (const dep of depsOf.get(id) ?? []) {
      dependentsOf.get(dep)?.push(id);
    }
  }
  const order = topoSort(ids, depsOf, dependentsOf);
  return { ids, depsOf, dependentsOf, order };
}

export function topoSort(
  ids: string[],
  depsOf: Map<string, string[]>,
  dependentsOf: Map<string, string[]>,
): string[] {
  const indeg = new Map<string, number>(ids.map((id) => [id, depsOf.get(id)?.length ?? 0]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const remaining = new Set(ids);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (!remaining.has(id)) continue;
    remaining.delete(id);
    order.push(id);
    for (const child of dependentsOf.get(id) ?? []) {
      const next = (indeg.get(child) ?? 0) - 1;
      indeg.set(child, next);
      if (next === 0) queue.push(child);
    }
  }
  if (remaining.size > 0) {
    const cycle = findCycle([...remaining], depsOf);
    throw new PlanError([{ message: `dependency cycle detected: ${cycle.join(' -> ')}` }]);
  }
  return order;
}

function findCycle(remainingIds: string[], depsOf: Map<string, string[]>): string[] {
  const remaining = new Set(remainingIds);
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];
  const dfs = (id: string): boolean => {
    if (inStack.has(id)) {
      path.push(id);
      return true;
    }
    if (visited.has(id)) return false;
    visited.add(id);
    inStack.add(id);
    path.push(id);
    for (const dep of depsOf.get(id) ?? []) {
      if (!remaining.has(dep)) continue;
      if (dfs(dep)) return true;
    }
    inStack.delete(id);
    path.pop();
    return false;
  };
  for (const id of remainingIds) {
    if (dfs(id)) {
      const last = path[path.length - 1]!;
      const start = path.indexOf(last);
      return path.slice(start);
    }
  }
  return remainingIds;
}

/** All transitive ancestors of `id` (nodes it directly or indirectly depends on). */
export function ancestorsOf(id: string, depsOf: Map<string, string[]>): Set<string> {
  const result = new Set<string>();
  const stack = [...(depsOf.get(id) ?? [])];
  while (stack.length > 0) {
    const dep = stack.pop()!;
    if (result.has(dep)) continue;
    result.add(dep);
    stack.push(...(depsOf.get(dep) ?? []));
  }
  return result;
}

/** All transitive dependents of `id` (nodes that directly or indirectly depend on it). */
export function dependentsClosure(id: string, dependentsOf: Map<string, string[]>): Set<string> {
  const result = new Set<string>();
  const stack = [...(dependentsOf.get(id) ?? [])];
  while (stack.length > 0) {
    const child = stack.pop()!;
    if (result.has(child)) continue;
    result.add(child);
    stack.push(...(dependentsOf.get(child) ?? []));
  }
  return result;
}

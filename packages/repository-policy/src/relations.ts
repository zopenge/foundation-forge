const compareCodePoint = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

export const stableTopologicalOrder = (
  ids: ReadonlySet<string>,
  requiresById: ReadonlyMap<string, readonly string[]>,
): readonly string[] => {
  const indegree = new Map<string, number>();
  const dependants = new Map<string, string[]>();

  for (const id of ids) {
    indegree.set(id, 0);
    dependants.set(id, []);
  }

  for (const id of ids) {
    for (const dependency of requiresById.get(id) ?? []) {
      if (!ids.has(dependency)) continue;
      indegree.set(id, (indegree.get(id) ?? 0) + 1);
      const targets = dependants.get(dependency);
      if (targets === undefined) {
        throw new Error('topological relation references an unknown id');
      }
      targets.push(id);
    }
  }

  for (const targets of dependants.values()) targets.sort(compareCodePoint);

  const ready = [...ids]
    .filter((id) => indegree.get(id) === 0)
    .sort(compareCodePoint);
  const output: string[] = [];

  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) break;
    output.push(id);
    for (const dependant of dependants.get(id) ?? []) {
      const next = (indegree.get(dependant) ?? 0) - 1;
      indegree.set(dependant, next);
      if (next === 0) {
        ready.push(dependant);
        ready.sort(compareCodePoint);
      }
    }
  }

  if (output.length !== ids.size) {
    throw new Error('dependency cycle detected during topological ordering');
  }
  return output;
};

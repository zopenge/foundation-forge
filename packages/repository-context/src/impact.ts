import type { RepositoryContextImpactNode } from './contracts.js';
import { RepositoryContextError, validateIdentifier, validateStringList } from './errors.js';

export function buildRepositoryContextImpactSlice(input: { readonly nodes: readonly RepositoryContextImpactNode[]; readonly rootIds: readonly string[] }): RepositoryContextImpactNode[] {
  const nodes = new Map<string, RepositoryContextImpactNode>();
  for (const node of input.nodes) {
    validateIdentifier(node.id, 'node.id');
    validateStringList(node.dependsOn, 'node.dependsOn');
    validateStringList(node.files, 'node.files');
    if (nodes.has(node.id)) throw new RepositoryContextError('DUPLICATE_IMPACT_NODE_ID', { id: node.id });
    nodes.set(node.id, node);
  }
  const selected = new Map<string, RepositoryContextImpactNode>();
  const pending = [...input.rootIds];
  for (const id of pending) {
    if (selected.has(id)) continue;
    const node = nodes.get(id);
    if (!node) throw new RepositoryContextError('UNKNOWN_IMPACT_NODE', { id });
    selected.set(id, { ...node, dependsOn: [...node.dependsOn], files: [...node.files] });
    pending.push(...node.dependsOn);
  }
  return [...selected.values()].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

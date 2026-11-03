import { posix } from 'node:path';
import { artifactInvalid, type ArtifactDirectory, type ArtifactFile, type ArtifactLink, type ArtifactLinkInput } from './prebuilt-inventory.js';

/** 按文件系统顺序处理 symlink 和 ..；不能先做词法 normalize，否则会改变 Node 的 realpath 语义。 */
export function resolveArtifactLinks(files: readonly ArtifactFile[], directories: readonly ArtifactDirectory[],
  links: readonly ArtifactLinkInput[], guard: () => void): ArtifactLink[] {
  type Node = { path: string; kind: 'file' | 'directory' | 'link'; target?: string };
  const nodes = new Map<string, Node>([['', { path: '', kind: 'directory' }]]);
  for (const item of files) nodes.set(item.path, { path: item.path, kind: 'file' });
  for (const item of directories) nodes.set(item.path, { path: item.path, kind: 'directory' });
  for (const item of links) nodes.set(item.path, { path: item.path, kind: 'link', target: item.target });
  const targets = new Map<string, string>();
  function resolve(link: ArtifactLinkInput): string {
    const previous = targets.get(link.path); if (previous !== undefined) return previous;
    let current = posix.dirname(link.path) === '.' ? [] : posix.dirname(link.path).split('/');
    const active = new Set([link.path]);
    const frames = [{ link: link.path, parts: link.target.split('/'), index: 0, directory: link.target.endsWith('/') }];
    while (frames.length) {
      guard(); const frame = frames.at(-1); if (!frame) return artifactInvalid('LINK_TARGET');
      if (frame.index === frame.parts.length) {
        const path = current.join('/'), node = nodes.get(path);
        if (!node || node.kind === 'link' || (frame.directory && node.kind !== 'directory')) return artifactInvalid('LINK_TARGET');
        targets.set(frame.link, path); active.delete(frame.link); frames.pop(); continue;
      }
      const part = frame.parts[frame.index++]; if (!part) continue;
      if (nodes.get(current.join('/'))?.kind !== 'directory') return artifactInvalid('LINK_TARGET');
      if (part === '.') continue;
      if (part === '..') { if (!current.length) return artifactInvalid('LINK_ESCAPE'); current.pop(); continue; }
      const path = [...current, part].join('/'), node = nodes.get(path);
      if (!node) return artifactInvalid('LINK_DANGLING');
      if (node.kind !== 'link') { current.push(part); continue; }
      const known = targets.get(path);
      if (known !== undefined) { current = known ? known.split('/') : []; continue; }
      if (active.has(path) || node.target === undefined) return artifactInvalid('LINK_CYCLE');
      active.add(path); frames.push({ link: path, parts: node.target.split('/'), index: 0, directory: node.target.endsWith('/') });
    }
    return targets.get(link.path) ?? artifactInvalid('LINK_TARGET');
  }
  for (const link of links) resolve(link);
  const children = new Map<string, string[]>();
  for (const node of nodes.values()) if (node.path) {
    const parent = posix.dirname(node.path), key = parent === '.' ? '' : parent;
    const entries = children.get(key) ?? []; entries.push(node.path); children.set(key, entries);
  }
  const state = new Map<string, 'active' | 'done'>();
  const edges = (path: string) => nodes.get(path)?.kind === 'link' ? [targets.get(path) ?? artifactInvalid('LINK_TARGET')] : children.get(path) ?? [];
  const stack = [{ path: '', next: 0, edges: edges('') }]; state.set('', 'active');
  while (stack.length) {
    guard(); const frame = stack.at(-1); if (!frame) return artifactInvalid('LINK_TARGET');
    if (frame.next === frame.edges.length) { state.set(frame.path, 'done'); stack.pop(); continue; }
    const target = frame.edges[frame.next++]; if (target === undefined) return artifactInvalid('LINK_TARGET');
    if (state.get(target) === 'active') return artifactInvalid('LINK_CYCLE');
    if (state.get(target) === 'done') continue;
    state.set(target, 'active'); stack.push({ path: target, next: 0, edges: edges(target) });
  }
  return links.map(link => {
    const resolvedPath = targets.get(link.path) ?? artifactInvalid('LINK_TARGET');
    return { ...link, resolvedPath, kind: nodes.get(resolvedPath)?.kind === 'directory' ? 'directory' : 'file' };
  });
}

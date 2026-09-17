import type { CatalogArtifact, CatalogEntry, CatalogLimits, CatalogReference, CatalogRoute, CatalogScope } from './read-catalog-contracts.js';
import { catalogJson, catalogLimit, makeCatalogArtifact } from './read-catalog-codec.js';
import { compareStrings } from './validation.js';
import { parseCatalogNode } from './read-catalog-parse.js';
interface SizedEntry { readonly entry: CatalogEntry; readonly bytes: number }
export class CatalogArtifactBuilder {
  private readonly artifacts = new Map<string, CatalogArtifact>();
  private total = 0;
  constructor(readonly limits: CatalogLimits) {}
  async add(path: string, content: string, limit: number): Promise<CatalogArtifact> {
    if (content.length > limit) catalogLimit('catalog-artifact');
    const artifact = await makeCatalogArtifact(path, content);
    if (artifact.byteLength > limit) catalogLimit('catalog-artifact');
    const final = path.startsWith('shards/') ? Object.freeze({ ...artifact, path: `${path}-${artifact.sha256}.json` }) : artifact;
    const existing = this.artifacts.get(final.path);
    if (existing) return existing;
    if (this.artifacts.size >= this.limits.maxArtifactCount) catalogLimit('catalog-artifact-count');
    if (artifact.byteLength > this.limits.maxTotalBytes - this.total) catalogLimit('catalog-total-bytes');
    this.total += artifact.byteLength; this.artifacts.set(final.path, final); return final;
  }
  values(): readonly CatalogArtifact[] { return Object.freeze([...this.artifacts.values()].sort((a, b) => compareStrings(a.path, b.path))); }
  totalBytes(): number { return this.total; }
  async tree(scope: CatalogScope, entries: readonly CatalogEntry[]): Promise<CatalogReference> {
    const sorted = entries.map(entry => ({ entry, bytes: new TextEncoder().encode(catalogJson(entry)).length }))
      .sort((a, b) => compareStrings(a.entry.key, b.entry.key));
    return this.branch(scope, sorted, '');
  }
  async route(scope: CatalogScope, entries: readonly CatalogEntry[]): Promise<CatalogRoute> {
    const ref = await this.tree(scope, entries);
    const artifact = this.artifacts.get(ref.path);
    if (!artifact) return ref;
    const node = parseCatalogNode(JSON.parse(artifact.content) as unknown, scope, ref.prefix);
    if (node.kind !== 'branch' || !node.children) return ref;
    this.artifacts.delete(ref.path); this.total -= artifact.byteLength;
    return Object.freeze({ prefix: ref.prefix, children: Object.freeze(node.children) });
  }
  private async branch(scope: CatalogScope, entries: readonly SizedEntry[], minimum: string): Promise<CatalogReference> {
    let prefix = minimum;
    const first = entries[0]?.entry.key; const last = entries.at(-1)?.entry.key;
    if (first !== undefined && last !== undefined) {
      while (prefix.length < first.length && first[prefix.length] === last[prefix.length]) prefix += first[prefix.length];
    }
    const base = { schemaVersion: 1, kind: 'leaf', scope, prefix, entries: [] };
    const wrapperBytes = new TextEncoder().encode(catalogJson(base)).length;
    let size = wrapperBytes + Math.max(0, entries.length - 1);
    for (const entry of entries) {
      if (entry.bytes > this.limits.maxShardBytes - wrapperBytes) catalogLimit('catalog-entry-too-large');
      size += entry.bytes;
    }
    let content: string;
    if (size <= this.limits.maxShardBytes) content = catalogJson({ ...base, entries: entries.map(value => value.entry) });
    else {
      if (prefix.length >= (scope === 'paths' ? 64 : 128)) catalogLimit('catalog-hash-collision');
      const buckets = new Map<string, SizedEntry[]>();
      for (const entry of entries) {
        const childPrefix = entry.entry.key.slice(0, prefix.length + 1);
        const bucket = buckets.get(childPrefix) ?? []; bucket.push(entry); buckets.set(childPrefix, bucket);
      }
      const children: CatalogReference[] = [];
      for (const [childPrefix, bucket] of buckets) children.push(await this.branch(scope, bucket, childPrefix));
      content = catalogJson({ schemaVersion: 1, kind: 'branch', scope, prefix, children });
    }
    const artifact = await this.add(`shards/${scope}`, content, this.limits.maxShardBytes);
    return Object.freeze({ path: artifact.path, sha256: artifact.sha256, byteLength: artifact.byteLength, prefix });
  }
}

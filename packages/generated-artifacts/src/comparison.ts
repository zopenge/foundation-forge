import type { GeneratedArtifactComparison, GeneratedArtifactDefinition, GeneratedArtifactPlan, GeneratedArtifactSnapshotEntry } from './contracts.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const normalizeNewlines = (value: string): string => value.replace(/\r\n?/gu, '\n');
export const artifactBytes = (artifact: GeneratedArtifactDefinition): Uint8Array => typeof artifact.content === 'string' ? encoder.encode(artifact.content) : artifact.content;

export function artifactContentMatches(artifact: GeneratedArtifactDefinition, actual: Uint8Array): boolean {
  if (artifact.comparison === 'normalize-newlines' && typeof artifact.content === 'string') {
    try { return normalizeNewlines(decoder.decode(artifactBytes(artifact))) === normalizeNewlines(decoder.decode(actual)); }
    catch { return false; }
  }
  const expected = artifactBytes(artifact);
  return expected.length === actual.length && expected.every((byte, index) => byte === actual[index]);
}

export function compareGeneratedArtifactSnapshot(plan: GeneratedArtifactPlan, snapshot: readonly GeneratedArtifactSnapshotEntry[]): GeneratedArtifactComparison {
  const entries = new Map(snapshot.map(entry => [entry.path, entry.content]));
  const missing: string[] = [];
  const stale: string[] = [];
  for (const artifact of plan.artifacts) {
    const actual = entries.get(artifact.path);
    if (actual === undefined) missing.push(artifact.path);
    else if (!artifactContentMatches(artifact, actual)) stale.push(artifact.path);
  }
  const retiredPresent = plan.retiredPaths.filter(path => entries.has(path)).sort();
  return { ok: missing.length + stale.length + retiredPresent.length === 0, missing: missing.sort(), stale: stale.sort(), retiredPresent };
}

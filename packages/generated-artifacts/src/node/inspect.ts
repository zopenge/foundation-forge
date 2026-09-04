import { compareGeneratedArtifactSnapshot } from '../comparison.js';
import type { GeneratedArtifactComparison, GeneratedArtifactPlan } from '../contracts.js';
import type { GeneratedArtifactFilesystemOptions } from './contracts.js';
import { prepareOperation, snapshotPlan } from './safe-target.js';

export async function inspectGeneratedArtifacts(rootDirectory: string, input: GeneratedArtifactPlan, options: GeneratedArtifactFilesystemOptions): Promise<GeneratedArtifactComparison> {
  const { root, plan } = prepareOperation(rootDirectory, input, options);
  return compareGeneratedArtifactSnapshot(plan, await snapshotPlan(root, plan));
}

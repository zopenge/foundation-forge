import { unlink } from 'node:fs/promises';
import { artifactBytes, artifactContentMatches } from '../comparison.js';
import { generatedArtifactErrorCodes as codes, type GeneratedArtifactDiagnostic, type GeneratedArtifactPlan } from '../contracts.js';
import { GeneratedArtifactError } from '../errors.js';
import { atomicWriteArtifact } from './atomic-file.js';
import type { GeneratedArtifactFilesystemOptions, GeneratedArtifactPublicationResult } from './contracts.js';
import { assertSafePath, prepareOperation, snapshotPlan, systemErrorCode, targetPath } from './safe-target.js';

export async function publishGeneratedArtifacts(rootDirectory: string, input: GeneratedArtifactPlan, options: GeneratedArtifactFilesystemOptions): Promise<GeneratedArtifactPublicationResult> {
  const { root, plan } = prepareOperation(rootDirectory, input, options);
  const snapshot = new Map((await snapshotPlan(root, plan)).map(entry => [entry.path, entry.content]));
  const written: string[] = [];
  const unchanged: string[] = [];
  const removed: string[] = [];
  const diagnostics: GeneratedArtifactDiagnostic[] = [];
  for (const artifact of plan.artifacts) {
    const current = snapshot.get(artifact.path);
    if (current !== undefined && artifactContentMatches(artifact, current)) { unchanged.push(artifact.path); continue; }
    try { await atomicWriteArtifact(root, artifact.path, artifactBytes(artifact)); written.push(artifact.path); }
    catch (cause) {
      diagnostics.push(diagnostic(artifact.path, cause, codes.writeFailed));
      return { written, unchanged, removed, diagnostics };
    }
  }
  for (const path of plan.retiredPaths) {
    try {
      const target = targetPath(root, path);
      await assertSafePath(target, path);
      await unlink(target);
      removed.push(path);
    } catch (cause) {
      if (systemErrorCode(cause) !== 'ENOENT') diagnostics.push(diagnostic(path, cause, codes.removeFailed));
    }
  }
  return { written, unchanged, removed, diagnostics };
}

function diagnostic(path: string, cause: unknown, fallback: GeneratedArtifactDiagnostic['code']): GeneratedArtifactDiagnostic {
  return cause instanceof GeneratedArtifactError
    ? { code: cause.code, path, details: cause.details }
    : { code: fallback, path, details: { systemCode: systemErrorCode(cause) } };
}

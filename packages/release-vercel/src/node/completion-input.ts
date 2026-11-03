import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CompletionInputBinding, FileIdentity } from './release-context.js';
import { record, ReleaseError } from './errors.js';
import { assertPathChain, sameIdentity } from './managed-io.js';
import { assertMetadataFile, inspectMetadataFile } from './managed-metadata.js';
import { prebuiltArtifactPaths, prebuiltManifestLimit } from './prebuilt-artifact.js';

const identities = ['checkout', 'git', 'output', 'upload'] as const;
function invalid(): never { throw new ReleaseError('SLOT_STATE', { reason: 'COMPLETION_INPUT_BINDING' }); }
function identity(value: unknown): boolean {
  const input = record(value);
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(input).length === 2
    && [input.dev, input.ino].every(value => typeof value === 'string' && /^\d+$/u.test(value));
}
export function parseCompletionInput(value: unknown, required: boolean): CompletionInputBinding | undefined {
  if (!required) { if (value !== undefined) invalid(); return; }
  const input = record(value), manifest = record(input.manifest);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(input).length !== 6 || input.schemaVersion !== 1
    || identities.some(key => !identity(input[key])) || Object.keys(manifest).length !== 2 || !identity(manifest.identity)
    || typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.sha256)) invalid();
  return value as CompletionInputBinding;
}
function paths(cwd: string) {
  const artifact = prebuiltArtifactPaths(cwd);
  return { checkout: cwd, git: resolve(cwd, '.git'), output: artifact.root, upload: artifact.uploadRoot, manifest: artifact.manifestPath };
}
async function directory(cwd: string, path: string): Promise<FileIdentity> {
  await assertPathChain(cwd, path);
  const value = await lstat(path, { bigint: true });
  if (!value.isDirectory() || value.isSymbolicLink()) throw new ReleaseError('ARTIFACT_CHANGED');
  return { dev: String(value.dev), ino: String(value.ino) };
}
/** promotion意图同写的私有输入指纹；不进入公开context或报告，不允许用同内容的新副本替代。 */
export async function captureCompletionInput(cwd: string): Promise<CompletionInputBinding> {
  const input = paths(cwd);
  const checkout = await directory(cwd, input.checkout), git = await directory(cwd, input.git);
  const output = await directory(cwd, input.output), upload = await directory(cwd, input.upload);
  await assertPathChain(cwd, input.manifest);
  const manifest = await inspectMetadataFile(input.manifest, prebuiltManifestLimit);
  if (!manifest) throw new ReleaseError('ARTIFACT_CHANGED');
  return { schemaVersion: 1, checkout, git, output, upload, manifest };
}
export async function assertCompletionInput(cwd: string, binding: CompletionInputBinding): Promise<void> {
  parseCompletionInput(binding, true);
  const input = paths(cwd);
  try {
    for (const key of identities) if (!sameIdentity(await directory(cwd, input[key]), binding[key])) throw new ReleaseError('ARTIFACT_CHANGED');
    await assertPathChain(cwd, input.manifest); await assertMetadataFile(input.manifest, binding.manifest, prebuiltManifestLimit);
  } catch { throw new ReleaseError('ARTIFACT_CHANGED', { reason: 'COMPLETION_INPUT_CHANGED' }); }
}

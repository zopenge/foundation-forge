import { calculateBytesIntegrity } from '@openge/forge-artifact-integrity';
import { OperationBudget } from '../budget.js';
import { createArtifactContentManifest } from '../content-manifest.js';
import type { ArtifactContentManifest, ArtifactContentManifestFile, PreparedArtifactContentManifest } from '../content-manifest.js';
import { ArtifactPublicationError } from '../errors.js';
import type { ArtifactFileCaptureOptions, ArtifactFileVerificationOptions, CapturedArtifactFiles } from './capture-contracts.js';
import { verifySourceClosure } from './capture-closure.js';
import { capturedSnapshot } from './capture-snapshot.js';
import { snapshotCaptureOptions, validateCaptureLimits } from './capture-validation.js';
import { captureControlledFile } from './read-file.js';
import type { ControlledFileCapture } from './read-file.js';

async function capture(options: ArtifactFileCaptureOptions, budget: OperationBudget): Promise<CapturedArtifactFiles> {
  budget.assertActive();
  const declarations = options.sources.flatMap(source => source.files.map(({ sourcePath, ...file }) => {
    void sourcePath;
    return { ...file, byteLength: 0, sha256: '0'.repeat(64) };
  }));
  const metadata = await createArtifactContentManifest({ schemaVersion: 1, files: declarations });
  budget.assertActive();
  if (metadata.bytes.byteLength > options.maxManifestBytes) throw new ArtifactPublicationError('BUDGET_EXCEEDED');
  const policies = new Map(metadata.manifest.files.map(file => [file.path, file]));
  const visits = { count: 0, max: options.maxEntries };
  for (const source of options.sources) await verifySourceClosure(source, visits, budget, options.pathCaseSensitivity);
  const records: ControlledFileCapture[] = [], files = new Map<string, Uint8Array>(), manifestFiles: ArtifactContentManifestFile[] = [];
  const physicalPaths = new Set<string>();
  let total = 0;
  for (const source of options.sources) for (const file of source.files) {
    const record = await captureControlledFile(source.rootDirectory, file.sourcePath, Math.min(options.maxFileBytes, options.maxTotalBytes - total), budget);
    if (physicalPaths.has(record.canonicalPath)) throw new ArtifactPublicationError('INVALID_SOURCE');
    physicalPaths.add(record.canonicalPath);
    records.push(record); files.set(file.path, record.bytes); total += record.bytes.byteLength;
    const integrity = await calculateBytesIntegrity(record.bytes);
    budget.assertActive();
    const policy = policies.get(file.path);
    if (!policy) throw new ArtifactPublicationError('INVALID_PLAN');
    manifestFiles.push({ ...policy, byteLength: record.bytes.byteLength, sha256: integrity.sha256 });
  }
  for (const source of options.sources) await verifySourceClosure(source, visits, budget, options.pathCaseSensitivity);
  for (const record of records) await record.verify();
  const prepared = await createArtifactContentManifest({ schemaVersion: 1, files: manifestFiles });
  budget.assertActive();
  if (prepared.bytes.byteLength > options.maxManifestBytes || total + prepared.bytes.byteLength > options.maxTotalBytes) throw new ArtifactPublicationError('BUDGET_EXCEEDED');
  return capturedSnapshot(prepared, files, total);
}

async function expectedManifest(input: ArtifactFileVerificationOptions, options: ArtifactFileCaptureOptions, budget: OperationBudget): Promise<PreparedArtifactContentManifest> {
  if (!(input.manifestBytes instanceof Uint8Array) || input.manifestBytes.byteLength > options.maxManifestBytes) throw new ArtifactPublicationError('INVALID_PLAN');
  const bytes = Uint8Array.from(input.manifestBytes), expected = input.expectedContent;
  if (!expected || Object.keys(expected).length !== 1 || typeof expected.manifestSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(expected.manifestSha256)) throw new ArtifactPublicationError('INVALID_PLAN');
  const sha256 = expected.manifestSha256;
  let manifest: ArtifactContentManifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as ArtifactContentManifest; }
  catch { throw new ArtifactPublicationError('INVALID_PLAN'); }
  const prepared = await createArtifactContentManifest(manifest);
  budget.assertActive();
  if (prepared.content.manifestSha256 !== sha256 || bytes.length !== prepared.bytes.length
    || bytes.some((value, index) => value !== prepared.bytes[index])) throw new ArtifactPublicationError('INTEGRITY_MISMATCH');
  return prepared;
}

async function run(input: ArtifactFileCaptureOptions, verification?: ArtifactFileVerificationOptions): Promise<CapturedArtifactFiles> {
  validateCaptureLimits(input);
  const budget = new OperationBudget(input);
  try {
    budget.assertActive();
    const options = snapshotCaptureOptions(input, budget);
    const expected = verification ? await expectedManifest(verification, options, budget) : undefined;
    const result = await capture(options, budget);
    if (expected && expected.content.manifestSha256 !== result.content.manifestSha256) throw new ArtifactPublicationError('INTEGRITY_MISMATCH');
    return result;
  } catch (error) {
    if (error instanceof ArtifactPublicationError) throw error;
    throw new ArtifactPublicationError('INVALID_SOURCE');
  } finally { budget.dispose(); }
}

/** 捕获调用方控制的原始文件；不声明跨文件原子瞬间或持久磁盘封存。 */
export function captureArtifactFiles(options: ArtifactFileCaptureOptions): Promise<CapturedArtifactFiles> { return run(options); }

export function verifyArtifactFiles(options: ArtifactFileVerificationOptions): Promise<CapturedArtifactFiles> { return run(options, options); }

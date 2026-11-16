import { lstat, opendir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { OperationBudget } from '../budget.js';
import { ArtifactPublicationError } from '../errors.js';
import type { ArtifactCaptureSource } from './capture-contracts.js';
import { capturePath } from './capture-validation.js';
import { assertRegularPath, fileStamp } from './read-file.js';

export async function verifySourceClosure(source: ArtifactCaptureSource, visits: { count: number; readonly max: number }, budget: OperationBudget): Promise<void> {
  await assertRegularPath(source.rootDirectory, budget, 'directory');
  if (source.closure === 'declared') return;
  const expected = new Set(source.files.map(file => file.sourcePath)), directories = new Set<string>(), seen = new Set<string>();
  for (const path of expected) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) directories.add(parts.slice(0, index).join('/'));
  }
  const walk = async (directory: string, prefix: string): Promise<void> => {
    budget.assertActive();
    const before = fileStamp(await lstat(directory, { bigint: true }));
    const handle = await opendir(directory, { bufferSize: 1 });
    let failed = false, failure: unknown;
    try {
      for (;;) {
        budget.assertActive();
        const entry = await handle.read();
        budget.assertActive();
        if (!entry) break;
        if (++visits.count > visits.max) throw new ArtifactPublicationError('BUDGET_EXCEEDED');
        const path = capturePath(prefix ? `${prefix}/${entry.name}` : entry.name), target = resolve(directory, entry.name);
        const info = await lstat(target);
        budget.assertActive();
        if (info.isSymbolicLink()) throw new ArtifactPublicationError('INVALID_SOURCE');
        if (info.isDirectory() && directories.has(path)) {
          await assertRegularPath(target, budget, 'directory');
          await walk(target, path);
        } else if (info.isFile() && expected.has(path)) seen.add(path);
        else throw new ArtifactPublicationError('INVALID_SOURCE');
      }
    } catch (error) { failed = true; failure = error; }
    finally {
      try { await handle.close(); }
      catch { budget.markUnconfirmedResource(); failed = true; failure = new ArtifactPublicationError('CLOSURE_UNCONFIRMED'); }
    }
    if (failed) throw failure;
    await assertRegularPath(directory, budget, 'directory');
    if (before !== fileStamp(await lstat(directory, { bigint: true }))) throw new ArtifactPublicationError('INTEGRITY_MISMATCH');
  };
  await walk(source.rootDirectory, '');
  if (seen.size !== expected.size) throw new ArtifactPublicationError('INVALID_SOURCE');
  budget.assertActive();
}

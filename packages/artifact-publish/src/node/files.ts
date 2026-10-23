import { isAbsolute, resolve } from 'node:path';
import { validatePortableRelativePath } from '@openge/forge-path-safety';
import type { ArtifactBytes, ArtifactPublicationReceipt, ArtifactPublicationTransport } from '../contracts.js';
import { ArtifactPublicationError } from '../errors.js';
import { publishPreparedArtifactRelease } from '../publication.js';
import { snapshotPlan } from '../validation.js';
import type { ArtifactFilePublicationOptions, ArtifactFileReleasePlan } from './contracts.js';
import { readControlledFile } from './read-file.js';

export function publishArtifactFiles(transport: ArtifactPublicationTransport, rootDirectory: string,
  input: ArtifactFileReleasePlan, options: ArtifactFilePublicationOptions): Promise<ArtifactPublicationReceipt> {
  return publishPreparedArtifactRelease(transport, options, validatedOptions => {
    if (typeof rootDirectory !== 'string' || !isAbsolute(rootDirectory)) throw new ArtifactPublicationError('INVALID_SOURCE');
    const caseSensitivity = options.pathCaseSensitivity;
    if (caseSensitivity !== 'case-sensitive' && caseSensitivity !== 'case-insensitive') throw new ArtifactPublicationError('INVALID_OPTIONS');
    const root = resolve(rootDirectory);
    const { plan } = snapshotPlan(input, validatedOptions, 'activate');
    const paths = new Set<string>();
    const files = input.objects.map((value, index) => {
      let path: string;
      try { path = validatePortableRelativePath(value.path); }
      catch { throw new ArtifactPublicationError('INVALID_SOURCE'); }
      const folded = caseSensitivity === 'case-sensitive' ? path : path.toLowerCase();
      if (paths.has(folded)) throw new ArtifactPublicationError('INVALID_SOURCE');
      paths.add(folded);
      const descriptor = plan.objects[index];
      if (!descriptor) throw new ArtifactPublicationError('INVALID_SOURCE');
      return { path, descriptor };
    });
    return async budget => {
      const objects: ArtifactBytes[] = [];
      for (const { path, descriptor } of files) {
        budget.assertActive();
        objects.push({ ...descriptor, bytes: await readControlledFile(root, path, descriptor, budget) });
      }
      return { ...plan, objects };
    };
  });
}

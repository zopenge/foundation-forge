import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { generatedArtifactErrorCodes as codes } from '../contracts.js';
import { GeneratedArtifactError } from '../errors.js';
import type { DurableArtifactFilesystem } from './durable-contracts.js';
import { createDurableArtifactFilesystem } from './durable-filesystem.js';
import { systemErrorCode } from './safe-target.js';

export async function createLinuxDurableArtifactFilesystem(): Promise<DurableArtifactFilesystem> {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new GeneratedArtifactError(codes.durabilityUnsupported, { platform: process.platform, architecture: process.arch });
  return createDurableArtifactFilesystem({
    syncDirectory: async path => {
      const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      let cause: unknown;
      try { await handle.sync(); } catch (error) { cause = error; }
      try { await handle.close(); }
      catch (error) { throw new GeneratedArtifactError(codes.durabilityUnknown, { stage: 'directory-close', systemCode: systemErrorCode(error), syncFailed: cause !== undefined }, cause ?? error); }
      if (cause !== undefined) throw cause;
    },
  });
}

import {
  archiveSafetyDefaultLimits,
  archiveSafetyErrorCodes,
  type ArchiveEntry,
  type ArchiveInspectionSummary,
  type ArchiveSafetyLimits,
} from './contracts.js';
import { validateArchiveEntryPath } from './entry-path.js';
import { ArchiveSafetyError } from './errors.js';

export const inspectArchiveEntries = (
  entries: readonly ArchiveEntry[],
  configuredLimits: Readonly<Partial<ArchiveSafetyLimits>> = {},
): ArchiveInspectionSummary => {
  const limits = readLimits(configuredLimits);
  let directoryCount = 0;
  let expandedBytes = 0;
  let fileCount = 0;

  for (const [index, entry] of entries.entries()) {
    validateArchiveEntryPath(entry.path);
    if (index + 1 > limits.maxEntries) {
      throw new ArchiveSafetyError(archiveSafetyErrorCodes.entryLimitExceeded, {
        maxEntries: limits.maxEntries,
      });
    }
    if (entry.kind === 'directory') {
      if (entry.uncompressedBytes !== undefined && entry.uncompressedBytes !== 0) {
        throw new ArchiveSafetyError(archiveSafetyErrorCodes.invalidEntrySize, {
          path: entry.path,
          uncompressedBytes: entry.uncompressedBytes,
        });
      }
      directoryCount += 1;
      continue;
    }
    if (entry.kind !== 'file') {
      throw new ArchiveSafetyError(archiveSafetyErrorCodes.unsupportedEntryKind, {
        kind: entry.kind,
        path: entry.path,
      });
    }
    const size = entry.uncompressedBytes;
    if (size === undefined || !Number.isSafeInteger(size) || size < 0) {
      throw new ArchiveSafetyError(archiveSafetyErrorCodes.invalidEntrySize, {
        path: entry.path,
        uncompressedBytes: size,
      });
    }
    if (size > limits.maxExpandedBytes - expandedBytes) {
      throw new ArchiveSafetyError(archiveSafetyErrorCodes.expandedSizeLimitExceeded, {
        maxExpandedBytes: limits.maxExpandedBytes,
        path: entry.path,
      });
    }
    expandedBytes += size;
    fileCount += 1;
  }

  return {
    directoryCount,
    entryCount: entries.length,
    expandedBytes,
    fileCount,
  };
};

const readLimits = (
  configured: Readonly<Partial<ArchiveSafetyLimits>>,
): ArchiveSafetyLimits => {
  const limits = {
    maxEntries: configured.maxEntries ?? archiveSafetyDefaultLimits.maxEntries,
    maxExpandedBytes: configured.maxExpandedBytes ?? archiveSafetyDefaultLimits.maxExpandedBytes,
  };
  if (
    !Number.isSafeInteger(limits.maxEntries)
    || limits.maxEntries <= 0
    || !Number.isSafeInteger(limits.maxExpandedBytes)
    || limits.maxExpandedBytes <= 0
  ) {
    throw new ArchiveSafetyError(archiveSafetyErrorCodes.invalidLimits, limits);
  }
  return limits;
};

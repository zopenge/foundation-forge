import {
  ArchiveSafetyError,
  inspectArchiveEntries,
  type ArchiveInspectionSummary,
} from '@openge/forge-archive-safety';
import { unzipSync, zipSync, type Zippable } from 'fflate';

import { parseZipCentralDirectory, type ParsedZipArchiveEntry } from './central-directory.js';
import {
  zipArchiveDefaultLimits,
  zipArchiveErrorCodes,
  type DecodedZipArchive,
  type EncodeZipArchiveOptions,
  type ZipArchiveEntryMetadata,
  type ZipArchiveInspection,
  type ZipArchiveLimits,
  type ZipArchiveReadOptions,
  type ZipArchiveSourceEntry,
} from './contracts.js';
import { ZipArchiveError } from './errors.js';

export function encodeZipArchive(
  entries: readonly ZipArchiveSourceEntry[],
  options: EncodeZipArchiveOptions,
): Uint8Array {
  const limits = resolveLimits(options.limits);
  inspectSafety(entries.map((entry) => ({
    kind: entry.kind,
    path: entry.path,
    uncompressedBytes: entry.kind === 'file' ? entry.bytes.length : 0,
  })), limits);
  const seen = new Set<string>();
  const zippable: Zippable = Object.create(null);
  for (const entry of [...entries].toSorted((left, right) => comparePaths(left.path, right.path))) {
    if (seen.has(entry.path)) {
      throw new ZipArchiveError(zipArchiveErrorCodes.duplicateEntry, { path: entry.path });
    }
    seen.add(entry.path);
    if ((entry.kind === 'directory') !== entry.path.endsWith('/')) {
      throw new ZipArchiveError(zipArchiveErrorCodes.invalidEntry, { path: entry.path });
    }
    zippable[entry.path] = entry.kind === 'file' ? entry.bytes : new Uint8Array();
  }
  let archive: Uint8Array;
  try {
    archive = zipSync(zippable, {
      level: options.compression === 'store' ? 0 : 6,
      mtime: new Date(1980, 0, 1),
    });
  } catch (error) {
    throw new ZipArchiveError(zipArchiveErrorCodes.invalidEntry, {}, error);
  }
  assertArchiveSize(archive, limits);
  return archive;
}

export function inspectZipArchive(
  archive: Uint8Array,
  options: ZipArchiveReadOptions = {},
): ZipArchiveInspection {
  const inspection = inspectInternal(archive, options);
  return { entries: inspection.entries, summary: inspection.summary };
}

export function decodeZipArchive(
  archive: Uint8Array,
  options: ZipArchiveReadOptions = {},
): DecodedZipArchive {
  const inspection = inspectInternal(archive, options);
  let decoded: Record<string, Uint8Array>;
  try {
    decoded = unzipSync(archive);
  } catch (error) {
    throw new ZipArchiveError(zipArchiveErrorCodes.decompressionFailed, {}, error);
  }
  const entries = inspection.parsedEntries.map((entry): ZipArchiveSourceEntry => {
    const bytes = Object.prototype.hasOwnProperty.call(decoded, entry.path)
      ? decoded[entry.path]
      : undefined;
    if (bytes === undefined || bytes.length !== entry.uncompressedBytes) {
      throw new ZipArchiveError(zipArchiveErrorCodes.decompressionFailed, { path: entry.path });
    }
    if (calculateCrc32(bytes) !== entry.crc32) {
      throw new ZipArchiveError(zipArchiveErrorCodes.crcMismatch, { path: entry.path });
    }
    return entry.kind === 'directory'
      ? { kind: 'directory', path: entry.path }
      : { bytes, kind: 'file', path: entry.path };
  });
  return { entries };
}

interface InternalInspection extends ZipArchiveInspection {
  readonly parsedEntries: readonly ParsedZipArchiveEntry[];
}

function inspectInternal(
  archive: Uint8Array,
  options: ZipArchiveReadOptions,
): InternalInspection {
  const limits = resolveLimits(options.limits);
  assertArchiveSize(archive, limits);
  const parsedEntries = parseZipCentralDirectory(archive);
  const summary = inspectSafety(parsedEntries.map((entry) => ({
    kind: entry.kind,
    path: entry.path,
    uncompressedBytes: entry.uncompressedBytes,
  })), limits);
  const entries: ZipArchiveEntryMetadata[] = parsedEntries.map((entry) => {
    if (entry.kind !== 'directory' && entry.kind !== 'file') {
      throw new ZipArchiveError(zipArchiveErrorCodes.unsafeArchive, { path: entry.path });
    }
    return {
      compressedBytes: entry.compressedBytes,
      compression: entry.compression,
      crc32: entry.crc32,
      kind: entry.kind,
      path: entry.path,
      uncompressedBytes: entry.uncompressedBytes,
    };
  });
  return { entries, parsedEntries, summary };
}

function inspectSafety(
  entries: Parameters<typeof inspectArchiveEntries>[0],
  limits: ZipArchiveLimits,
): ArchiveInspectionSummary {
  try {
    return inspectArchiveEntries(entries, {
      maxEntries: limits.maxEntries,
      maxExpandedBytes: limits.maxExpandedBytes,
    });
  } catch (error) {
    if (error instanceof ArchiveSafetyError) {
      throw new ZipArchiveError(zipArchiveErrorCodes.unsafeArchive, { safetyCode: error.code }, error);
    }
    throw error;
  }
}

function resolveLimits(overrides: Partial<ZipArchiveLimits> | undefined): ZipArchiveLimits {
  const limits = { ...zipArchiveDefaultLimits, ...overrides };
  if (
    !Number.isSafeInteger(limits.maxArchiveBytes)
    || limits.maxArchiveBytes <= 0
    || !Number.isSafeInteger(limits.maxEntries)
    || limits.maxEntries <= 0
    || !Number.isSafeInteger(limits.maxExpandedBytes)
    || limits.maxExpandedBytes <= 0
  ) {
    throw new ZipArchiveError(zipArchiveErrorCodes.invalidLimits);
  }
  return limits;
}

function assertArchiveSize(archive: Uint8Array, limits: ZipArchiveLimits): void {
  if (archive.length > limits.maxArchiveBytes) {
    throw new ZipArchiveError(zipArchiveErrorCodes.archiveTooLarge, {
      actualBytes: archive.length,
      maxArchiveBytes: limits.maxArchiveBytes,
    });
  }
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function calculateCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

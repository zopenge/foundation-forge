import type { ArchiveInspectionSummary, ArchiveSafetyLimits } from '@openge/forge-archive-safety';

export type ZipArchiveCompression = 'deflate' | 'store';

export type ZipArchiveSourceEntry =
  | { readonly bytes: Uint8Array; readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'directory'; readonly path: string };

export interface EncodeZipArchiveOptions {
  readonly compression: ZipArchiveCompression;
  readonly limits?: Partial<ZipArchiveLimits>;
}

export interface DecodedZipArchive {
  readonly entries: readonly ZipArchiveSourceEntry[];
}

export interface ZipArchiveLimits extends ArchiveSafetyLimits {
  readonly maxArchiveBytes: number;
}

export interface ZipArchiveReadOptions {
  readonly limits?: Partial<ZipArchiveLimits>;
}

export interface ZipArchiveEntryMetadata {
  readonly compressedBytes: number;
  readonly compression: ZipArchiveCompression;
  readonly crc32: number;
  readonly kind: 'directory' | 'file';
  readonly path: string;
  readonly uncompressedBytes: number;
}

export interface ZipArchiveInspection {
  readonly entries: readonly ZipArchiveEntryMetadata[];
  readonly summary: ArchiveInspectionSummary;
}

export const zipArchiveDefaultLimits: ZipArchiveLimits = Object.freeze({
  maxArchiveBytes: 268_435_456,
  maxEntries: 10_000,
  maxExpandedBytes: 1_073_741_824,
});

export const zipArchiveErrorCodes = {
  archiveTooLarge: 'ARCHIVE_TOO_LARGE',
  crcMismatch: 'CRC_MISMATCH',
  decompressionFailed: 'DECOMPRESSION_FAILED',
  duplicateEntry: 'DUPLICATE_ENTRY',
  invalidEntry: 'INVALID_ENTRY',
  invalidLimits: 'INVALID_LIMITS',
  invalidZip: 'INVALID_ZIP',
  unsafeArchive: 'UNSAFE_ARCHIVE',
  unsupportedZipFeature: 'UNSUPPORTED_ZIP_FEATURE',
} as const;

export type ZipArchiveErrorCode = typeof zipArchiveErrorCodes[keyof typeof zipArchiveErrorCodes];

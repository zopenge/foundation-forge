export type ArchiveEntryKind = 'directory' | 'file' | 'hard-link' | 'other' | 'symbolic-link';

export interface ArchiveEntry {
  readonly kind: ArchiveEntryKind;
  readonly path: string;
  readonly uncompressedBytes?: number;
}

export interface ArchiveSafetyLimits {
  readonly maxEntries: number;
  readonly maxExpandedBytes: number;
}

export interface ArchiveInspectionSummary {
  readonly directoryCount: number;
  readonly entryCount: number;
  readonly expandedBytes: number;
  readonly fileCount: number;
}

export const archiveSafetyDefaultLimits: ArchiveSafetyLimits = Object.freeze({
  maxEntries: 10_000,
  maxExpandedBytes: 1_073_741_824,
});

export const archiveSafetyErrorCodes = {
  entryLimitExceeded: 'ENTRY_LIMIT_EXCEEDED',
  expandedSizeLimitExceeded: 'EXPANDED_SIZE_LIMIT_EXCEEDED',
  invalidEntryPath: 'INVALID_ENTRY_PATH',
  invalidEntrySize: 'INVALID_ENTRY_SIZE',
  invalidLimits: 'INVALID_LIMITS',
  unsupportedEntryKind: 'UNSUPPORTED_ENTRY_KIND',
} as const;

export type ArchiveSafetyErrorCode = typeof archiveSafetyErrorCodes[
  keyof typeof archiveSafetyErrorCodes
];

import { zipArchiveErrorCodes, type ZipArchiveEntryMetadata } from './contracts.js';
import { ZipArchiveError } from './errors.js';

const centralDirectoryHeaderSignature = 0x02014b50;
const endOfCentralDirectorySignature = 0x06054b50;
const localFileHeaderSignature = 0x04034b50;
const maximumCommentBytes = 0xffff;
const minimumEndRecordBytes = 22;
const utf8Flag = 0x0800;

export interface ParsedZipArchiveEntry extends Omit<ZipArchiveEntryMetadata, 'kind'> {
  readonly dataOffset: number;
  readonly kind: ZipArchiveEntryMetadata['kind'] | 'other' | 'symbolic-link';
}

export function parseZipCentralDirectory(archive: Uint8Array): readonly ParsedZipArchiveEntry[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const endOffset = findEndRecord(view);
  const diskNumber = readUint16(view, endOffset + 4);
  const centralDisk = readUint16(view, endOffset + 6);
  const diskEntries = readUint16(view, endOffset + 8);
  const entryCount = readUint16(view, endOffset + 10);
  const centralSize = readUint32(view, endOffset + 12);
  const centralOffset = readUint32(view, endOffset + 16);
  const commentLength = readUint16(view, endOffset + 20);
  if (endOffset + minimumEndRecordBytes + commentLength !== archive.length) {
    throw invalidZip();
  }
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== entryCount) {
    throw unsupportedFeature();
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw unsupportedFeature();
  }
  if (centralOffset + centralSize !== endOffset) {
    throw invalidZip();
  }

  const entries: ParsedZipArchiveEntry[] = [];
  const paths = new Set<string>();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (readUint32(view, offset) !== centralDirectoryHeaderSignature) {
      throw invalidZip();
    }
    const versionMadeBy = readUint16(view, offset + 4);
    const flags = readUint16(view, offset + 8);
    const method = readUint16(view, offset + 10);
    const crc32 = readUint32(view, offset + 16);
    const compressedBytes = readUint32(view, offset + 20);
    const uncompressedBytes = readUint32(view, offset + 24);
    const nameLength = readUint16(view, offset + 28);
    const extraLength = readUint16(view, offset + 30);
    const entryCommentLength = readUint16(view, offset + 32);
    const startDisk = readUint16(view, offset + 34);
    const externalAttributes = readUint32(view, offset + 38);
    const localOffset = readUint32(view, offset + 42);
    if (
      compressedBytes === 0xffffffff
      || uncompressedBytes === 0xffffffff
      || localOffset === 0xffffffff
      || startDisk !== 0
    ) {
      throw unsupportedFeature();
    }
    if ((flags & 0x0001) !== 0 || (method !== 0 && method !== 8)) {
      throw unsupportedFeature();
    }
    const entryEnd = offset + 46 + nameLength + extraLength + entryCommentLength;
    if (entryEnd > endOffset) {
      throw invalidZip();
    }
    const nameBytes = archive.subarray(offset + 46, offset + 46 + nameLength);
    if ((flags & utf8Flag) === 0 && nameBytes.some((byte) => byte > 0x7f)) {
      throw unsupportedFeature();
    }
    const path = decodeName(nameBytes);
    if (path.length === 0) {
      throw invalidZip();
    }
    if (paths.has(path)) {
      throw new ZipArchiveError(zipArchiveErrorCodes.duplicateEntry, { path });
    }
    paths.add(path);
    const kind = readEntryKind(versionMadeBy, externalAttributes, path);
    const dataOffset = readLocalDataOffset(
      archive,
      view,
      localOffset,
      flags,
      method,
      nameBytes,
      compressedBytes,
      centralOffset,
    );
    entries.push({
      compressedBytes,
      compression: method === 0 ? 'store' : 'deflate',
      crc32,
      dataOffset,
      kind,
      path,
      uncompressedBytes,
    });
    offset = entryEnd;
  }
  if (offset !== endOffset) {
    throw invalidZip();
  }
  return entries.toSorted((left, right) => comparePaths(left.path, right.path));
}

function findEndRecord(view: DataView): number {
  if (view.byteLength < minimumEndRecordBytes) {
    throw invalidZip();
  }
  const minimumOffset = Math.max(0, view.byteLength - minimumEndRecordBytes - maximumCommentBytes);
  for (let offset = view.byteLength - minimumEndRecordBytes; offset >= minimumOffset; offset -= 1) {
    if (readUint32(view, offset) === endOfCentralDirectorySignature) {
      return offset;
    }
  }
  throw invalidZip();
}

function readLocalDataOffset(
  archive: Uint8Array,
  view: DataView,
  localOffset: number,
  flags: number,
  method: number,
  centralNameBytes: Uint8Array,
  compressedBytes: number,
  centralOffset: number,
): number {
  if (readUint32(view, localOffset) !== localFileHeaderSignature) {
    throw invalidZip();
  }
  if (readUint16(view, localOffset + 6) !== flags || readUint16(view, localOffset + 8) !== method) {
    throw invalidZip();
  }
  const nameLength = readUint16(view, localOffset + 26);
  const extraLength = readUint16(view, localOffset + 28);
  const localNameBytes = archive.subarray(localOffset + 30, localOffset + 30 + nameLength);
  if (
    localNameBytes.length !== centralNameBytes.length
    || localNameBytes.some((byte, index) => byte !== centralNameBytes[index])
  ) {
    throw invalidZip();
  }
  const dataOffset = localOffset + 30 + nameLength + extraLength;
  if (dataOffset + compressedBytes > centralOffset || dataOffset > archive.length) {
    throw invalidZip();
  }
  return dataOffset;
}

function readEntryKind(
  versionMadeBy: number,
  externalAttributes: number,
  path: string,
): ParsedZipArchiveEntry['kind'] {
  const platform = versionMadeBy >>> 8;
  if (platform === 3) {
    const fileType = (externalAttributes >>> 16) & 0o170000;
    if (fileType === 0o120000) {
      return 'symbolic-link';
    }
    if (fileType !== 0 && fileType !== 0o040000 && fileType !== 0o100000) {
      return 'other';
    }
    if (fileType === 0o040000) {
      return 'directory';
    }
  }
  return path.endsWith('/') || (externalAttributes & 0x10) !== 0 ? 'directory' : 'file';
}

function decodeName(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ZipArchiveError(zipArchiveErrorCodes.invalidZip, {}, error);
  }
}

function readUint16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) {
    throw invalidZip();
  }
  return view.getUint16(offset, true);
}

function readUint32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) {
    throw invalidZip();
  }
  return view.getUint32(offset, true);
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidZip(): ZipArchiveError {
  return new ZipArchiveError(zipArchiveErrorCodes.invalidZip);
}

function unsupportedFeature(): ZipArchiveError {
  return new ZipArchiveError(zipArchiveErrorCodes.unsupportedZipFeature);
}

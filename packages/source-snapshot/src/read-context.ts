import type { SnapshotFile, SnapshotManifest, SnapshotObject } from './contracts.js';
import { SourceSnapshotError } from './errors.js';
import { compareStrings } from './validation.js';
import type { SourceTextDetails } from './content-contracts.js';
import { parseSourceTextDetails } from './text-format.js';

/** 单次操作复用查找表；不跨调用缓存可变的 manifest。 */
export interface SnapshotReadContext {
  readonly fileByPath: ReadonlyMap<string, SnapshotFile>;
  readonly objectByPath: ReadonlyMap<string, SnapshotObject>;
}
export const createSnapshotReadContext = (manifest: SnapshotManifest): SnapshotReadContext => {
  const fileByPath = new Map<string, SnapshotFile>();
  const objectByPath = new Map<string, SnapshotObject>();
  for (const object of manifest.objects) {
    if (objectByPath.has(object.path)) throw new SourceSnapshotError('OBJECT_CONFLICT', { path: object.path });
    objectByPath.set(object.path, object);
  }
  for (const file of manifest.files) {
    if (fileByPath.has(file.path)) throw new SourceSnapshotError('DUPLICATE_PATH', { path: file.path });
    fileByPath.set(file.path, file);
  }
  return { fileByPath, objectByPath };
};
export const requireSnapshotReadFile = (context: SnapshotReadContext, path: string): SnapshotFile => {
  const file = context.fileByPath.get(path);
  if (file === undefined) throw new SourceSnapshotError('FILE_NOT_PACKED', { path });
  return file;
};
export const collectReadContextRequirements = (
  context: SnapshotReadContext,
  paths: readonly string[],
): readonly SnapshotObject[] => {
  const required = new Map<string, SnapshotObject>();
  for (const path of paths) {
    for (const objectPath of requireSnapshotReadFile(context, path).objectPaths) {
      const object = context.objectByPath.get(objectPath);
      if (object === undefined) throw new SourceSnapshotError('DANGLING_OBJECT', { path: objectPath });
      required.set(object.path, object);
    }
  }
  return Object.freeze([...required.values()].sort((a, b) => compareStrings(a.path, b.path)));
};

/** 保留全量结构校验，但不为未选择文件创建展示记录。 */
export const readContextSourceDetails = (context: SnapshotReadContext, file: SnapshotFile): SourceTextDetails => {
  const details = parseSourceTextDetails(file.details);
  const paths = new Set(file.objectPaths);
  for (const path of paths) {
    if (!context.objectByPath.has(path)) throw new SourceSnapshotError('DANGLING_OBJECT', { path });
  }
  if (details.formatVersion === 2) {
    for (const locator of details.segments) {
      const object = paths.has(locator.objectPath) ? context.objectByPath.get(locator.objectPath) : undefined;
      if (object === undefined || object.sha256 !== locator.objectSha256) {
        throw new SourceSnapshotError('TEXT_DETAILS_INVALID', { path: file.path, field: 'locator.object' });
      }
    }
  }
  return details;
};

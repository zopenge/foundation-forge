import { createHash } from 'node:crypto';
import { calculateBytesIntegrity } from '@openge/forge-artifact-integrity';
import type { SnapshotFile, SnapshotManifest, SnapshotObject } from '../contracts.js';
import type { SourceTextDetailsV2, SourceTextLocatorV2 } from '../content-contracts.js';
import { SourceSnapshotError } from '../errors.js';
import { parseSourceTextDetails } from '../text-format.js';
import { compareStrings } from '../validation.js';
import { readManagedBytes } from './managed-read.js';

const decoder = new TextDecoder('utf-8', { fatal: true });

interface FileVerificationPlan {
  readonly path: string;
  readonly details: SourceTextDetailsV2;
  readonly locators: readonly SourceTextLocatorV2[];
  readonly objectPaths: readonly string[];
}

const objectMap = (manifest: SnapshotManifest): ReadonlyMap<string, SnapshotObject> => {
  const result = new Map<string, SnapshotObject>();
  for (const object of manifest.objects) {
    if (result.has(object.path)) throw new SourceSnapshotError('OBJECT_CONFLICT', { path: object.path });
    result.set(object.path, object);
  }
  return result;
};
const samePaths = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const planFile = (
  file: SnapshotFile,
  objects: ReadonlyMap<string, SnapshotObject>,
): FileVerificationPlan => {
  const details = parseSourceTextDetails(file.details);
  if (details.formatVersion !== 2) {
    throw new SourceSnapshotError('TEXT_FORMAT_UNSUPPORTED', {
      path: file.path,
      availableAssurance: 'object-integrity',
    });
  }
  const locators = [...details.segments].sort((a, b) => a.segmentIndex - b.segmentIndex);
  if (locators.length === 0 || locators.length !== (locators[0]?.segmentCount ?? 0)) {
    throw new SourceSnapshotError('TEXT_DETAILS_INVALID', { path: file.path, field: 'segments' });
  }
  let sourceOffset = 0;
  const required = new Set<string>();
  for (let index = 0; index < locators.length; index += 1) {
    const locator = locators[index];
    if (locator === undefined || locator.segmentIndex !== index + 1 || locator.segmentCount !== locators.length) {
      throw new SourceSnapshotError('TEXT_DETAILS_INVALID', { path: file.path, field: 'segmentIndex' });
    }
    if (locator.sourceByteOffset !== sourceOffset) {
      throw new SourceSnapshotError('TEXT_DETAILS_INVALID', { path: file.path, field: 'sourceByteOffset' });
    }
    const object = objects.get(locator.objectPath);
    if (object === undefined || object.sha256 !== locator.objectSha256) {
      throw new SourceSnapshotError('TEXT_DETAILS_INVALID', { path: file.path, field: 'objectSha256' });
    }
    sourceOffset += locator.bodyByteLength;
    required.add(locator.objectPath);
  }
  if (sourceOffset !== details.normalizedByteLength) {
    throw new SourceSnapshotError('TEXT_DETAILS_INVALID', { path: file.path, field: 'normalizedByteLength' });
  }
  const objectPaths = Object.freeze([...required].sort(compareStrings));
  const declared = [...file.objectPaths].sort(compareStrings);
  if (!samePaths(objectPaths, declared)) {
    throw new SourceSnapshotError('TEXT_DETAILS_INVALID', { path: file.path, field: 'objectPaths' });
  }
  return Object.freeze({ path: file.path, details, locators: Object.freeze(locators), objectPaths });
};

const readVerifiedObject = async (
  targetRoot: string,
  object: SnapshotObject,
): Promise<Uint8Array> => {
  const bytes = await readManagedBytes(targetRoot, object.path, false);
  if (bytes === undefined) throw new SourceSnapshotError('OBJECT_MISSING', { path: object.path });
  const integrity = await calculateBytesIntegrity(bytes);
  if (integrity.sha256 !== object.sha256 || integrity.byteLength !== object.byteLength) {
    throw new SourceSnapshotError('OBJECT_INTEGRITY_MISMATCH', { path: object.path });
  }
  return bytes;
};

type ObjectLoader = (path: string) => Promise<Uint8Array>;

const verifyFileBodies = async (
  plan: FileVerificationPlan,
  loadObject: ObjectLoader,
): Promise<void> => {
  const hash = createHash('sha256');
  let normalizedBytes = 0;
  let newlineCount = 0;
  let lastByte: number | null = null;
  let previousEndLine: number | null = null;
  let previousEndedNewline = false;
  for (let index = 0; index < plan.locators.length; index += 1) {
    const locator = plan.locators[index];
    if (locator === undefined) throw new SourceSnapshotError('TEXT_DETAILS_INVALID', { path: plan.path, field: 'segments' });
    const object = await loadObject(locator.objectPath);
    if (locator.bodyByteOffset + locator.bodyByteLength > object.byteLength) {
      throw new SourceSnapshotError('TEXT_DETAILS_INVALID', { path: plan.path, field: 'bodyByteRange' });
    }
    const body = object.subarray(locator.bodyByteOffset, locator.bodyByteOffset + locator.bodyByteLength);
    try { decoder.decode(body); }
    catch { throw new SourceSnapshotError('TEXT_INTEGRITY_MISMATCH', { path: plan.path, reason: 'invalid-utf8-body' }); }

    if (index === 0) {
      if (plan.details.lineCount === 0) {
        if (locator.startLine !== 0 || locator.endLine !== 0 || body.byteLength !== 0) {
          throw new SourceSnapshotError('TEXT_DETAILS_INVALID', { path: plan.path, field: 'lineRange' });
        }
      } else if (locator.startLine !== 1) {
        throw new SourceSnapshotError('TEXT_DETAILS_INVALID', { path: plan.path, field: 'lineRange' });
      }
    } else if (previousEndLine !== null) {
      const sameLine = locator.startLine === previousEndLine;
      const nextLine = locator.startLine === previousEndLine + 1;
      if ((!sameLine && !nextLine) || (sameLine && previousEndedNewline) || (nextLine && !previousEndedNewline)) {
        throw new SourceSnapshotError('TEXT_DETAILS_INVALID', { path: plan.path, field: 'lineRange' });
      }
    }

    hash.update(body);
    normalizedBytes += body.byteLength;
    for (const byte of body) if (byte === 0x0a) newlineCount += 1;
    if (body.byteLength > 0) lastByte = body[body.byteLength - 1] ?? null;
    previousEndLine = locator.endLine;
    previousEndedNewline = body.byteLength > 0 && body[body.byteLength - 1] === 0x0a;
  }
  if (plan.details.lineCount > 0 && previousEndLine !== plan.details.lineCount) {
    throw new SourceSnapshotError('TEXT_DETAILS_INVALID', { path: plan.path, field: 'lineCount' });
  }
  const finalNewline = normalizedBytes > 0 && lastByte === 0x0a;
  const lineCount = normalizedBytes === 0 ? 0 : newlineCount + (finalNewline ? 0 : 1);
  const digest = hash.digest('hex');
  if (
    normalizedBytes !== plan.details.normalizedByteLength ||
    digest !== plan.details.normalizedSha256 ||
    finalNewline !== plan.details.finalNewline ||
    lineCount !== plan.details.lineCount
  ) {
    throw new SourceSnapshotError('TEXT_INTEGRITY_MISMATCH', { path: plan.path });
  }
};

export const verifyPublishedSnapshotText = async (
  targetRoot: string,
  manifest: SnapshotManifest,
): Promise<readonly string[]> => {
  const objects = objectMap(manifest);
  const plans = manifest.files.map(file => planFile(file, objects));
  const singleObject = new Map<string, FileVerificationPlan[]>();
  const multiObject: FileVerificationPlan[] = [];
  for (const plan of plans) {
    if (plan.objectPaths.length === 1) {
      const path = plan.objectPaths[0];
      if (path === undefined) throw new SourceSnapshotError('TEXT_DETAILS_INVALID', { path: plan.path, field: 'objectPaths' });
      const values = singleObject.get(path) ?? [];
      values.push(plan);
      singleObject.set(path, values);
    } else {
      multiObject.push(plan);
    }
  }
  const verifiedObjects = new Set<string>();
  for (const [objectPath, filePlans] of [...singleObject.entries()].sort(([a], [b]) => compareStrings(a, b))) {
    const object = objects.get(objectPath);
    if (object === undefined) throw new SourceSnapshotError('OBJECT_MISSING', { path: objectPath });
    const bytes = await readVerifiedObject(targetRoot, object);
    verifiedObjects.add(objectPath);
    const load: ObjectLoader = async path => {
      if (path !== objectPath) throw new SourceSnapshotError('OBJECT_CONFLICT', { path });
      return bytes;
    };
    for (const plan of filePlans) await verifyFileBodies(plan, load);
  }

  for (const plan of multiObject) {
    let currentPath: string | null = null;
    let currentBytes: Uint8Array | null = null;
    const load: ObjectLoader = async path => {
      if (path === currentPath && currentBytes !== null) return currentBytes;
      const object = objects.get(path);
      if (object === undefined) throw new SourceSnapshotError('OBJECT_MISSING', { path });
      const bytes = await readVerifiedObject(targetRoot, object);
      verifiedObjects.add(path);
      currentPath = path;
      currentBytes = bytes;
      return bytes;
    };
    await verifyFileBodies(plan, load);
  }

  for (const object of manifest.objects) {
    if (verifiedObjects.has(object.path)) continue;
    await readVerifiedObject(targetRoot, object);
  }
  return Object.freeze(plans.map(plan => plan.path));
};

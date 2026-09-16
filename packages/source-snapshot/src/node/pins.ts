import { calculateBytesIntegrity } from '@openge/forge-artifact-integrity';
import type { SnapshotPin } from '../contracts.js';
import { SourceSnapshotError } from '../errors.js';
import type {
  InspectSourceSnapshotPinsOptions,
  RemoveSourceSnapshotPinOptions,
  SourceSnapshotPinState,
  UpsertSourceSnapshotPinOptions,
} from './contracts.js';
import { resolveStorageLayout, type ResolvedSourceSnapshotLayout } from './layout.js';
import { acquireSourceSnapshotLock } from './lock.js';
import { readManagedText } from './managed-read.js';
import { readSourceSnapshotOwner, verifyPublishedSourceSnapshot, writeMutableSourceArtifacts } from './publish.js';

const encoder = new TextEncoder();
const token = /^[A-Za-z0-9._:-]{1,128}$/u;
const snapshotIdPattern = /^snapshot-[a-f0-9]{64}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
const invalid = (details: Readonly<Record<string, unknown>> = {}): never => {
  throw new SourceSnapshotError('PIN_STATE_INVALID', details);
};
const parsePin = (value: unknown): SnapshotPin => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
  const pin = value as Partial<SnapshotPin>;
  if (typeof pin.pinId !== 'string' || !token.test(pin.pinId)) return invalid({ field: 'pinId' });
  if (typeof pin.snapshotId !== 'string' || !snapshotIdPattern.test(pin.snapshotId)) return invalid({ pinId: pin.pinId, field: 'snapshotId' });
  if (typeof pin.reasonCode !== 'string' || !token.test(pin.reasonCode)) return invalid({ pinId: pin.pinId, field: 'reasonCode' });
  if (!Number.isSafeInteger(pin.createdAt) || (pin.createdAt as number) < 0) return invalid({ pinId: pin.pinId, field: 'createdAt' });
  if (pin.expiresAt !== undefined && (!Number.isSafeInteger(pin.expiresAt) || (pin.expiresAt as number) < (pin.createdAt as number))) {
    return invalid({ pinId: pin.pinId, field: 'expiresAt' });
  }
  return Object.freeze({
    pinId: pin.pinId,
    snapshotId: pin.snapshotId,
    reasonCode: pin.reasonCode,
    createdAt: pin.createdAt as number,
    ...(pin.expiresAt === undefined ? {} : { expiresAt: pin.expiresAt as number }),
  });
};
const normalizePins = (value: unknown): readonly SnapshotPin[] => {
  if (!Array.isArray(value)) return invalid({ field: 'pins' });
  const pins = value.map(parsePin).sort((a, b) => a.pinId.localeCompare(b.pinId));
  const ids = new Set<string>();
  for (const pin of pins) { if (ids.has(pin.pinId)) return invalid({ pinId: pin.pinId }); ids.add(pin.pinId); }
  return Object.freeze(pins);
};
const revisionFor = async (projectId: string, ownerId: string, pins: readonly SnapshotPin[]): Promise<string> => {
  const payload = JSON.stringify({ schemaVersion: 1, projectId, ownerId, pins });
  return (await calculateBytesIntegrity(encoder.encode(payload))).sha256;
};
const emptyState = async (projectId: string, ownerId: string): Promise<SourceSnapshotPinState> => {
  const pins = Object.freeze([]) as readonly SnapshotPin[];
  return Object.freeze({ schemaVersion: 1, projectId, ownerId, revision: await revisionFor(projectId, ownerId, pins), pins });
};
export const readSourceSnapshotPinsState = async (
  options: InspectSourceSnapshotPinsOptions,
  layout: ResolvedSourceSnapshotLayout = resolveStorageLayout(options),
): Promise<SourceSnapshotPinState> => {
  const owner = await readSourceSnapshotOwner(options.targetRoot, options.ownerId, layout);
  const text = await readManagedText(options.targetRoot, layout.pinsFile, false);
  if (text === undefined) return emptyState(owner.projectId, options.ownerId);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return invalid(); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return invalid();
  const value = parsed as { schemaVersion?: unknown; projectId?: unknown; ownerId?: unknown; revision?: unknown; pins?: unknown };
  if (value.schemaVersion !== 1 || value.projectId !== owner.projectId || value.ownerId !== options.ownerId || typeof value.revision !== 'string' || !hashPattern.test(value.revision)) return invalid();
  const pins = normalizePins(value.pins);
  const revision = await revisionFor(owner.projectId, options.ownerId, pins);
  if (revision !== value.revision) return invalid({ reason: 'revision-mismatch' });
  return Object.freeze({ schemaVersion: 1, projectId: owner.projectId, ownerId: options.ownerId, revision, pins });
};
export const inspectSourceSnapshotPins = async (options: InspectSourceSnapshotPinsOptions): Promise<SourceSnapshotPinState> => readSourceSnapshotPinsState(options);

const writeState = async (
  options: InspectSourceSnapshotPinsOptions,
  layout: ResolvedSourceSnapshotLayout,
  pins: readonly SnapshotPin[],
): Promise<SourceSnapshotPinState> => {
  const owner = await readSourceSnapshotOwner(options.targetRoot, options.ownerId, layout);
  const normalized = normalizePins(pins);
  const revision = await revisionFor(owner.projectId, options.ownerId, normalized);
  const state: SourceSnapshotPinState = Object.freeze({ schemaVersion: 1, projectId: owner.projectId, ownerId: options.ownerId, revision, pins: normalized });
  const content = `${JSON.stringify(state, null, 2)}\n`;
  await writeMutableSourceArtifacts(options.targetRoot, [{ path: layout.pinsFile, content }], layout);
  const confirmed = await readSourceSnapshotPinsState(options, layout);
  if (confirmed.revision !== revision) return invalid({ reason: 'write-not-confirmed' });
  return confirmed;
};
const assertRevision = (actual: string, expected: string | undefined): void => {
  if (expected !== undefined && expected !== actual) throw new SourceSnapshotError('PIN_STATE_CONFLICT', { expectedRevision: expected, actualRevision: actual });
};
export const upsertSourceSnapshotPin = async (options: UpsertSourceSnapshotPinOptions): Promise<SourceSnapshotPinState> => {
  const release = await acquireSourceSnapshotLock(options.lockPath);
  try {
    const layout = resolveStorageLayout(options); const current = await readSourceSnapshotPinsState(options, layout); assertRevision(current.revision, options.expectedRevision);
    const pin = parsePin(options.pin);
    try { await verifyPublishedSourceSnapshot({ ...options, snapshotId: pin.snapshotId, level: 'objects' }); }
    catch (error) { if (error instanceof SourceSnapshotError && (error.code === 'SNAPSHOT_MISSING' || error.code === 'INVALID_SNAPSHOT_ID')) throw new SourceSnapshotError('PIN_TARGET_MISSING', { snapshotId: pin.snapshotId }); throw error; }
    const pins = [...current.pins.filter(value => value.pinId !== pin.pinId), pin];
    return writeState(options, layout, pins);
  } finally { await release(); }
};
export const removeSourceSnapshotPin = async (options: RemoveSourceSnapshotPinOptions): Promise<SourceSnapshotPinState> => {
  if (!token.test(options.pinId)) throw new SourceSnapshotError('PIN_STATE_INVALID', { field: 'pinId' });
  const release = await acquireSourceSnapshotLock(options.lockPath);
  try {
    const layout = resolveStorageLayout(options); const current = await readSourceSnapshotPinsState(options, layout); assertRevision(current.revision, options.expectedRevision);
    const pins = current.pins.filter(pin => pin.pinId !== options.pinId);
    if (pins.length === current.pins.length) return current;
    return writeState(options, layout, pins);
  } finally { await release(); }
};

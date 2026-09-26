import { createHash } from 'node:crypto';

const CURSOR_VERSION = 1;
export const SORT_VERSION = 'repository-context-sort-v1';
export const PROJECTION_VERSION = 'repository-context-wire-v1';

export interface CursorBinding {
  readonly generationId: string;
  readonly requestDigest: string;
  readonly scopeDigest: string;
  readonly sortVersion: string;
  readonly projectionVersion: string;
}

interface CursorPayload extends CursorBinding {
  readonly version: number;
  readonly offset: number;
}

interface CursorEnvelope {
  readonly payload: CursorPayload;
  readonly checksum: string;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const stable = (value: unknown): string => JSON.stringify(value);

export const createCursorBinding = (
  generationId: string,
  request: unknown,
  scope: readonly string[],
): CursorBinding => ({
  generationId,
  requestDigest: sha256(stable(request)),
  scopeDigest: sha256(stable([...scope].sort())),
  sortVersion: SORT_VERSION,
  projectionVersion: PROJECTION_VERSION,
});
const mismatch = (): Error => Object.assign(new Error('cursor mismatch'), { code: 'CURSOR_MISMATCH', details: {} });

export const encodeCursor = (binding: CursorBinding, offset: number): string => {
  const payload: CursorPayload = { version: CURSOR_VERSION, ...binding, offset };
  const envelope: CursorEnvelope = { payload, checksum: sha256(stable(payload)) };
  return `v${CURSOR_VERSION}.${Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url')}`;
};

export const decodeCursor = (cursor: string | null, binding: CursorBinding): number => {
  if (cursor === null) return 0;
  if (!cursor.startsWith(`v${CURSOR_VERSION}.`) || cursor.length > 8_192) throw mismatch();
  try {
    const encoded = cursor.slice(cursor.indexOf('.') + 1);
    const envelope = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<CursorEnvelope>;
    const payload = envelope.payload as Partial<CursorPayload> | undefined;
    if (!payload || typeof envelope.checksum !== 'string' || envelope.checksum !== sha256(stable(payload))) throw mismatch();
    if (payload.version !== CURSOR_VERSION || !Number.isInteger(payload.offset) || (payload.offset ?? -1) < 0) throw mismatch();
    if (payload.generationId !== binding.generationId || payload.requestDigest !== binding.requestDigest
      || payload.scopeDigest !== binding.scopeDigest || payload.sortVersion !== binding.sortVersion
      || payload.projectionVersion !== binding.projectionVersion) throw mismatch();
    return payload.offset ?? 0;
  } catch (error) {
    if ((error as { readonly code?: unknown }).code === 'CURSOR_MISMATCH') throw error;
    throw mismatch();
  }
};
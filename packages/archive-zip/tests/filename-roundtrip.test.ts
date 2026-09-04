import { describe, expect, it } from 'vitest';
import { decodeZipArchive, encodeZipArchive, inspectZipArchive } from '../src/index.js';

describe('UTF-8 ZIP filename identity', () => {
  it.each(['store', 'deflate'] as const)('preserves a leading BOM separately from the ordinary name (%s)', compression => {
    const entries = [
      { kind: 'file' as const, path: 'config.json', bytes: new Uint8Array([1, 2, 3]) },
      { kind: 'file' as const, path: '\ufeffconfig.json', bytes: new Uint8Array([4, 5, 6]) },
    ];
    const archive = encodeZipArchive(entries, { compression });
    expect(inspectZipArchive(archive).entries.map(entry => entry.path)).toEqual(entries.map(entry => entry.path));
    expect(decodeZipArchive(archive).entries).toEqual(entries);
  });
});

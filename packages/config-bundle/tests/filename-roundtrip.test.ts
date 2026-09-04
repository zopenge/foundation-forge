import { expect, it } from 'vitest';
import { createConfigBundle, decodeConfigBundle } from '../src/index.js';

it('round-trips BOM-prefixed filenames without aliasing ordinary names', async () => {
  const entries = [
    { path: 'config.json', content: new Uint8Array([1]) },
    { path: '\ufeffconfig.json', content: new Uint8Array([2]) },
  ];
  const bundle = await createConfigBundle(entries, { createdAt: '2026-09-04T00:00:00.000Z' });
  expect((await decodeConfigBundle(bundle)).entries).toEqual(entries);
});

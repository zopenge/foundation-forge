import { expect, test } from 'vitest';
import koffi from 'koffi';
import { loadOwnedNative } from '../src/owned-scope/native-loader.js';

test('loads only the verified native version on supported hosts', async () => {
  if (!['win32', 'linux'].includes(process.platform) || process.arch !== 'x64') {
    await expect(loadOwnedNative('win32')).rejects.toMatchObject({ code: 'PROCESS_SCOPE_UNSUPPORTED' }); return;
  }
  const native = await loadOwnedNative(process.platform === 'win32' ? 'win32' : 'linux');
  expect(native.version).toBe('3.3.3');
});
test('does not fall back when the native dependency is missing or has the wrong version', async () => {
  const platform = process.platform === 'win32' ? 'win32' : 'linux';
  await expect(loadOwnedNative(platform, async () => { throw new Error('missing prebuild'); })).rejects.toMatchObject({ code: 'PROCESS_SCOPE_UNSUPPORTED' });
  await expect(loadOwnedNative(platform, async () => ({ ...koffi, version: '0.0.0' }))).rejects.toMatchObject({ code: 'PROCESS_SCOPE_UNSUPPORTED' });
});
test('rejects a different platform before importing native code', async () => {
  let imported = false;
  await expect(loadOwnedNative(process.platform === 'win32' ? 'linux' : 'win32', async () => { imported = true; return koffi; })).rejects.toMatchObject({ code: 'PROCESS_SCOPE_UNSUPPORTED' });
  expect(imported).toBe(false);
});

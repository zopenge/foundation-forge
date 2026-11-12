import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWindowsNtfsDurableArtifactFilesystem } from '../src/node.js';
import { fixture } from './fixtures.js';

const native = vi.hoisted(() => ({ failure: '', filesystem: 'NTFS', calls: [] as string[] }));
vi.mock('koffi', () => ({ default: {
  version: '3.3.3', struct: () => ({}), sizeof: () => 8, pointer: () => ({}), out: () => ({}),
  load: () => {
    if (native.failure === 'load') throw new Error('native-load-failure');
    return { func: (...signature: unknown[]) => {
      const name = signature.length === 1 ? String(signature[0]).match(/__stdcall (\w+)/u)?.[1] : String(signature[1]);
      return (...args: unknown[]) => {
        native.calls.push(name ?? 'unknown');
        if (name === 'CreateFileW') {
          expect(args.slice(1)).toEqual([0x40000000, 7, null, 3, 0x02200000, null]);
          return native.failure === 'open' ? -1n : 1n;
        }
        if (name === 'GetFileInformationByHandleEx') { Object.assign(args[2] ?? {}, { attributes: 0x10, tag: 0 }); return 1; }
        if (name === 'GetVolumeInformationByHandleW') { const buffer = args[6]; if (Buffer.isBuffer(buffer)) buffer.write(native.filesystem, 'utf16le'); return 1; }
        if (name === 'GetVolumePathNameW') { const buffer = args[1]; if (Buffer.isBuffer(buffer)) buffer.write(String(args[0]).slice(0, 3), 'utf16le'); return 1; }
        if (name === 'GetDriveTypeW') return native.failure === 'remote' ? 4 : 3;
        if (name === 'GetLastError') return 5;
        if (name === 'CloseHandle') return native.failure === 'close' ? 0 : 1;
        if (name === 'FlushFileBuffers') return native.failure === 'flush' ? 0 : 1;
        throw new Error('unexpected-native-call');
      };
    } };
  },
} }));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { native.failure = ''; native.filesystem = 'NTFS'; native.calls = []; for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe.runIf(process.platform === 'win32')('Win32 directory persistence failure boundary', () => {
  it('returns a structured unsupported error if native loading fails', async () => {
    native.failure = 'load';
    await expect(createWindowsNtfsDurableArtifactFilesystem()).rejects.toMatchObject({ code: 'GENERATED_ARTIFACT_DURABILITY_UNSUPPORTED' });
  });
  for (const stage of ['open', 'flush', 'close', 'remote', 'non-ntfs']) {
    it(`never acknowledges a directory on ${stage} failure`, async () => {
      const value = await fixture(); cleanups.push(value.cleanup);
      native.failure = stage;
      if (stage === 'non-ntfs') native.filesystem = 'ReFS';
      const io = await createWindowsNtfsDurableArtifactFilesystem();
      await expect(io.ensureDirectory(value.root, 'nested')).rejects.toMatchObject({ code: ['remote', 'non-ntfs'].includes(stage)
        ? 'GENERATED_ARTIFACT_DURABILITY_UNSUPPORTED' : 'GENERATED_ARTIFACT_DURABILITY_UNKNOWN' });
      if (stage !== 'open') expect(native.calls.filter(call => call === 'CloseHandle')).toHaveLength(1);
      if (stage === 'remote' || stage === 'non-ntfs') expect(native.calls).not.toContain('FlushFileBuffers');
    });
  }
});

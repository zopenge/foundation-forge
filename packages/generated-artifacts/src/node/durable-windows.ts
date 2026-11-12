import { generatedArtifactErrorCodes as codes } from '../contracts.js';
import { GeneratedArtifactError } from '../errors.js';
import type { DurableArtifactFilesystem } from './durable-contracts.js';
import { createDurableArtifactFilesystem } from './durable-filesystem.js';

export async function createWindowsNtfsDurableArtifactFilesystem(): Promise<DurableArtifactFilesystem> {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new GeneratedArtifactError(codes.durabilityUnsupported, { platform: process.platform, architecture: process.arch });
  try { return await bindWindowsFilesystem(); }
  catch (cause) {
    if (cause instanceof GeneratedArtifactError) throw cause;
    throw new GeneratedArtifactError(codes.durabilityUnsupported, { stage: 'native-bind' }, cause);
  }
}

async function bindWindowsFilesystem(): Promise<DurableArtifactFilesystem> {
  let k;
  try {
    k = (await import('koffi')).default;
    if (k.version !== '3.3.3') throw new Error('NATIVE_VERSION');
  } catch (cause) { throw new GeneratedArtifactError(codes.durabilityUnsupported, { stage: 'native-load' }, cause); }
  const lib = k.load('kernel32.dll');
  const create = lib.func('void * __stdcall CreateFileW(str16 path, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)');
  const flush = lib.func('int32_t __stdcall FlushFileBuffers(void *handle)');
  const close = lib.func('int32_t __stdcall CloseHandle(void *handle)');
  const error = lib.func('uint32_t __stdcall GetLastError()');
  const volumePath = lib.func('int32_t __stdcall GetVolumePathNameW(str16 path, void *volume, uint32_t capacity)');
  const driveType = lib.func('uint32_t __stdcall GetDriveTypeW(str16 path)');
  const volumeInfo = lib.func('int32_t __stdcall GetVolumeInformationByHandleW(void *handle, void *name, uint32_t nameCapacity, void *serial, void *maxComponent, void *flags, void *filesystem, uint32_t filesystemCapacity)');
  const attributes = k.struct({ attributes: 'uint32_t', tag: 'uint32_t' });
  const information = lib.func('__stdcall', 'GetFileInformationByHandleEx', 'int32_t', ['void *', 'int', k.out(k.pointer(attributes)), 'uint32_t']);
  const fail = (stage: string) => new GeneratedArtifactError(codes.durabilityUnknown, { stage, nativeCode: Number(error()) });
  const decode = (buffer: Buffer): string => buffer.toString('utf16le').split('\0', 1)[0] ?? '';
  return createDurableArtifactFilesystem({
    syncDirectory: async path => {
      // 使用 Win32 文档的目录句柄与 GENERIC_WRITE；不借 Native API 的宽松实现绕过其访问契约。
      const handle: bigint | null = create(path, 0x40000000, 7, null, 3, 0x02200000, null);
      if (handle === null || handle === -1n || handle === 0xffffffffffffffffn) throw fail('directory-open');
      let cause: unknown;
      try {
        const actual = { attributes: 0, tag: 0 };
        if (!information(handle, 9, actual, k.sizeof(attributes))) throw fail('directory-information');
        if (!(actual.attributes & 0x10) || actual.attributes & 0x400) throw new GeneratedArtifactError(codes.symlinkRejected, { stage: 'directory-reparse' });
        const fs = Buffer.alloc(128), volume = Buffer.alloc(65536);
        if (!volumeInfo(handle, null, 0, null, null, null, fs, 64)) throw fail('volume-information');
        if (!volumePath(path, volume, 32768)) throw fail('volume-path');
        // MS-FSA 的目录结构持久化仅对 NTFS 成立；远程/其他文件系统即使返回成功也不接受。
        if (decode(fs) !== 'NTFS' || Number(driveType(decode(volume))) !== 3 || path.startsWith('\\\\')) {
          throw new GeneratedArtifactError(codes.durabilityUnsupported, { stage: 'filesystem', filesystem: decode(fs) });
        }
        if (!flush(handle)) throw fail('directory-flush');
      } catch (error) { cause = error; }
      if (!close(handle)) throw new GeneratedArtifactError(codes.durabilityUnknown, { stage: 'directory-close', nativeCode: Number(error()), previousFailure: cause !== undefined }, cause);
      if (cause !== undefined) throw cause;
    },
  });
}

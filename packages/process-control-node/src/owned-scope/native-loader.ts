import { ProcessControlError, processControlErrorCodes } from '@openge/forge-process-control';

const importNative = async () => (await import('koffi')).default;
/** 只有显式启用 scope 才加载原生依赖；缺失预编译制品不触发构建或降级。 */
export async function loadOwnedNative(platform: 'win32' | 'linux', importer = importNative) {
  if (process.platform !== platform || process.arch !== 'x64') throw new ProcessControlError(processControlErrorCodes.scopeUnsupported, { reason: 'HOST', platform, architecture: process.arch });
  try {
    const native = await importer();
    if (native.version !== '3.3.3') throw new Error('NATIVE_VERSION');
    return native;
  } catch {
    throw new ProcessControlError(processControlErrorCodes.scopeUnsupported, { reason: 'NATIVE_PREBUILD', platform });
  }
}

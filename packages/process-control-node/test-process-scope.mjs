import {
  createLinuxOwnedProcessScopeProvider, createPosixProcessIdentityReader,
  createWindowsOwnedProcessScopeProvider, createWindowsNativeProcessIdentityReader,
} from './dist/index.js';
import { loadOwnedNative } from './dist/owned-scope/native-loader.js';
import { createWindowsTestJobDiagnostics } from './test-process-diagnostics.mjs';

// 仓库验收约定适配器不进入公开包；监督只使用本包已构建的公开契约。
export const createTestProcessSupervisor = async ({ platform }) => {
  if (platform === 'win32') {
    const diagnostics = createWindowsTestJobDiagnostics(await loadOwnedNative('win32'));
    const provider = createWindowsOwnedProcessScopeProvider();
    return { provider: { ...provider, start: (...args) => {
      const scope = provider.start(...args);
      return { ...scope, diagnostics: async () => diagnostics.take(await scope.rootPid.catch(() => undefined)) };
    } }, reader: createWindowsNativeProcessIdentityReader() };
  }
  if (platform === 'linux') return { provider: createLinuxOwnedProcessScopeProvider(), reader: createPosixProcessIdentityReader() };
  throw new Error(`test process supervision is unsupported on ${platform}`);
};

import {
  createLinuxOwnedProcessScopeProvider, createPosixProcessIdentityReader,
  createWindowsOwnedProcessScopeProvider, createWindowsProcessIdentityReader,
} from './dist/index.js';

// 仓库验收约定适配器不进入公开包；监督只使用本包已构建的公开契约。
export const createTestProcessSupervisor = ({ platform }) => {
  if (platform === 'win32') return { provider: createWindowsOwnedProcessScopeProvider(), reader: createWindowsProcessIdentityReader() };
  if (platform === 'linux') return { provider: createLinuxOwnedProcessScopeProvider(), reader: createPosixProcessIdentityReader() };
  throw new Error(`test process supervision is unsupported on ${platform}`);
};

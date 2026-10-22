import { resolve } from 'node:path';
import { git } from './managed-fixture.js';

/** 由 Git 的 -c 环境协议 include 专用路由，保留宿主认证和配置，不改写它们。 */
export function gitRoutingParameters(root: string, remote: string, declared: string): string {
  const path = resolve(root, 'routing.config');
  git(root, 'config', '--file', path, `url.${remote.replaceAll('\\', '/')}.insteadOf`, declared);
  const parameter = `'${`include.path=${path.replaceAll('\\', '/')}`.replaceAll("'", "'\\''")}'`;
  return [process.env.GIT_CONFIG_PARAMETERS, parameter].filter(Boolean).join(' ');
}

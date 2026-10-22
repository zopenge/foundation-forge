import type { FrozenSource } from './release-context.js';

/** 输出可直接粘贴到宿主默认 shell 的单次恢复命令，不使用 JSON 转义充当 shell 引号。 */
export function recoveryCommand(command: string, source: Pick<FrozenSource, 'root' | 'configPath'>): string {
  const quote = (value: string) => process.platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\"'\"'")}'`;
  return `forge-vercel-release ${command} --cwd ${quote(source.root)} --config ${quote(source.configPath)}`;
}

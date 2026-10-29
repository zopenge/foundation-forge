import { realpath } from 'node:fs/promises';
import type { FrozenSource } from '../../src/node/release-context.js';
import type { Execution } from '../../src/node/execution.js';
import { configDigest, readCommittedConfig } from '../../src/node/source.js';

/** 仅为测试自行提交的干净输入准备组件数据；来源准入仍由专门测试及完整发布入口验证。 */
export async function committedFixtureSource(fixture: { cwd: string; execution: Execution }, sha: string): Promise<FrozenSource> {
  const configPath = 'release.config.json', committed = await readCommittedConfig(fixture.execution, sha, configPath);
  return { root: await realpath(fixture.cwd), sha, configPath, config: committed.config, configBlobOid: committed.oid,
    configSha256: await configDigest(committed.config),
    fetchUrl: await fixture.execution.git(['config', '--get', `remote.${committed.config.git.remote}.url`]) };
}

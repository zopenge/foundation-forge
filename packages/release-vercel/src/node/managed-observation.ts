import type { FrozenSource, ManagedCommand, RecordedIdentity } from './release-context.js';

/** 仅固定 checkout 检查可声明此计划；逐条执行仍验证实际完整 argv。 */
export function checkoutObservationPlan(source: FrozenSource): NonNullable<ManagedCommand['plan']> {
  const remote = source.config.git.remote.replaceAll('.', '\\.');
  return [
    { name: 'git', args: ['rev-parse', '--show-toplevel'] },
    { name: 'git', args: ['config', '--get-regexp', `^remote\\.${remote}\\.(url|pushurl)$`] },
    { name: 'git-stream', args: ['status', '--porcelain=v2', '--branch', '--no-ahead-behind', '-z', '--untracked-files=all'] },
    { name: 'git', args: ['rev-parse', '--verify', '--quiet', `${source.sha}:${source.configPath}`] },
    { name: 'git-stream', args: ['cat-file', 'blob', source.configBlobOid] },
  ];
}

/** 磁盘意图只能由同一有限计划的证明归并，旧批次及子项不能相互替代。 */
export function matchesObservationBinding(intent: ManagedCommand, proof: ManagedCommand): boolean {
  if (intent.kind !== proof.kind) return false;
  if (intent.kind === undefined) return true;
  return JSON.stringify(intent.plan) === JSON.stringify(proof.plan)
    && !!intent.observations && !!proof.observations && intent.observations.length <= proof.observations.length
    && intent.observations.every((item, index) => JSON.stringify(item) === JSON.stringify(proof.observations?.[index]));
}

export function managedCommandIdentities(command: ManagedCommand): RecordedIdentity[] {
  return command.kind === 'checkout-observation'
    ? (command.observations ?? []).flatMap(item => [...item.descendants, ...(item.identity ? [item.identity] : [])])
    : [...command.descendants, ...(command.identity ? [command.identity] : [])];
}

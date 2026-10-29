import type { ManagedCommand } from './release-context.js';

/** 历史轮询见证保留可读；只有同一实例和绑定的 OS 关闭事实可以复用。 */
export function hasVerifiedManagedClosure(command: ManagedCommand): boolean {
  if (command.kind === 'checkout-observation') return command.status === 'closed'
    && /^[a-f0-9]{64}$/u.test(command.terminalSha256 ?? '') && hasObservationStopWitness(command)
    && command.observations?.every(hasVerifiedManagedClosure) === true;
  const closure = command.closure, owned = closure?.ownedScope;
  return command.status === 'closed' && command.observationComplete && !!command.identity && !!command.scope && !!closure
    && closure.termination === 'exit' && closure.exitCode !== null && Number.isSafeInteger(closure.exitCode)
    && Number.isFinite(Date.parse(closure.observedAt)) && owned?.status === 'closed' && owned.reason === 'normal' && owned.empty === true
    && owned.scopeId === command.scope.scopeId && owned.binding === command.scope.binding
    && owned.rootIdentity.pid === command.identity.pid && owned.rootIdentity.startToken === command.identity.startToken;
}

/** 资源停止与正常关闭分别判断；受控终止不能升级历史命令结果。 */
export function hasVerifiedManagedStop(command: ManagedCommand): boolean {
  if (command.kind === 'checkout-observation') return /^[a-f0-9]{64}$/u.test(command.terminalSha256 ?? '') && hasObservationStopWitness(command);
  if (hasVerifiedManagedClosure(command)) return true;
  const closure = command.closure, owned = closure?.ownedScope;
  return command.status === 'stopped' && command.observationComplete && !!command.identity && !!command.scope && !!closure
    && ['abort', 'timeout'].includes(closure.requestedTermination ?? '') && Number.isFinite(Date.parse(closure.observedAt))
    && owned?.status === 'unknown' && owned.reason === 'terminated' && owned.empty === true
    && owned.scopeId === command.scope.scopeId && owned.binding === command.scope.binding
    && owned.rootIdentity?.pid === command.identity.pid && owned.rootIdentity.startToken === command.identity.startToken;
}

/** 只供独立证明写入前核对内存事实；此判断本身不能用于释放或恢复槽。 */
export function hasObservationStopWitness(command: ManagedCommand): boolean {
  return command.kind === 'checkout-observation' && ['closed', 'stopped'].includes(command.status)
    && command.observationComplete && command.identity === undefined && command.scope === undefined
    && command.pid === undefined && command.closure === undefined && command.descendants.length === 0
    && command.plan?.length === 5 && !!command.observations && command.observations.length <= 5
    && command.observations.every(item => item.kind === undefined && hasVerifiedManagedStop(item))
    && (command.status !== 'closed' || command.observations.every(hasVerifiedManagedClosure));
}

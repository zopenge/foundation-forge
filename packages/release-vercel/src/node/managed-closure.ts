import type { ManagedCommand } from './release-context.js';

/** 历史轮询见证保留可读；只有同一实例和绑定的 OS 关闭事实可以复用。 */
export function hasVerifiedManagedClosure(command: ManagedCommand): boolean {
  const closure = command.closure, owned = closure?.ownedScope;
  return command.status === 'closed' && command.observationComplete && !!command.identity && !!command.scope && !!closure
    && closure.termination === 'exit' && closure.exitCode !== null && Number.isSafeInteger(closure.exitCode)
    && Number.isFinite(Date.parse(closure.observedAt)) && owned?.status === 'closed' && owned.reason === 'normal' && owned.empty === true
    && owned.scopeId === command.scope.scopeId && owned.binding === command.scope.binding
    && owned.rootIdentity.pid === command.identity.pid && owned.rootIdentity.startToken === command.identity.startToken;
}

/** 资源停止与正常关闭分别判断；受控终止不能升级历史命令结果。 */
export function hasVerifiedManagedStop(command: ManagedCommand): boolean {
  if (hasVerifiedManagedClosure(command)) return true;
  const closure = command.closure, owned = closure?.ownedScope;
  return command.status === 'stopped' && command.observationComplete && !!command.identity && !!command.scope && !!closure
    && ['abort', 'timeout'].includes(closure.requestedTermination ?? '') && Number.isFinite(Date.parse(closure.observedAt))
    && owned?.status === 'unknown' && owned.reason === 'terminated' && owned.empty === true
    && owned.scopeId === command.scope.scopeId && owned.binding === command.scope.binding
    && owned.rootIdentity?.pid === command.identity.pid && owned.rootIdentity.startToken === command.identity.startToken;
}

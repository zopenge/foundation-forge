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

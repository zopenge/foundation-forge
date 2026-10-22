import { expect, expectTypeOf, test } from 'vitest';
import { processControlErrorCodes } from '../src/index.js';
import type { OwnedProcessScopeProvider, ProcessScopeClosure } from '../src/index.js';

test('exports explicit owned-scope errors without depending on a Node Provider', () => {
  expect(processControlErrorCodes.scopeUnsupported).toBe('PROCESS_SCOPE_UNSUPPORTED');
  expect(processControlErrorCodes.scopeBinding).toBe('PROCESS_SCOPE_BINDING');
  expect(processControlErrorCodes.scopeUnknown).toBe('PROCESS_SCOPE_UNKNOWN');
  expect(processControlErrorCodes.scopeInvalidInput).toBe('PROCESS_SCOPE_INVALID_INPUT');
});
test('represents unknown startup without inventing a process identity', () => {
  const closure = { scopeId: 'scope', binding: 'operation:command', status: 'unknown', reason: 'provider-failed', observedAt: new Date().toISOString() } satisfies ProcessScopeClosure;
  expect(closure.status).toBe('unknown');
  expectTypeOf<OwnedProcessScopeProvider['start']>().toBeFunction();
});

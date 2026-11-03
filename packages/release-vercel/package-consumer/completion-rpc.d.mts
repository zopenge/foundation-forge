import type { ReleaseErrorCode, ReleaseTransport } from '../src/contracts.js';

export function serveCompletionTransport(transport: ReleaseTransport): Promise<{ endpoint: string; close(): Promise<void> }>;
export function completionRpc(endpoint: string, operation: string, args: readonly unknown[], signal?: AbortSignal): Promise<{
  ok: boolean; value?: unknown; error?: { code: ReleaseErrorCode; details: Readonly<Record<string, unknown>> };
}>;
export function completionRpcTransport(endpoint: string,
  createError: (code: ReleaseErrorCode, details: Readonly<Record<string, unknown>>) => Error): ReleaseTransport;

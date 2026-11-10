import { bindArtifactOperation, observeArtifactOperation, performArtifactOperation } from '@openge/forge-artifact-publish';
import type { ArtifactOperationBinding, ArtifactOperationJournal, ArtifactOperationObserver,
  ArtifactOperationReceipt, ArtifactOperationTransport } from '@openge/forge-artifact-publish';
import { createCommandArtifactOperation } from '@openge/forge-artifact-publish/node';
import type { CommandArtifactOperationOptions } from '@openge/forge-artifact-publish/node';

declare const transport: ArtifactOperationTransport;
declare const journal: ArtifactOperationJournal;
declare const command: CommandArtifactOperationOptions;
const binding = await bindArtifactOperation({ requestId: 'typed-1', sourceCommit: 'a'.repeat(40),
  target: transport.target, capability: transport.capability, configurationSha256: transport.configurationSha256,
  inputs: [{ name: 'payload', byteLength: 1, sha256: 'b'.repeat(64) }] });
const options = { timeoutMilliseconds: 1000, closeTimeoutMilliseconds: 100 };
export const publication: ArtifactOperationReceipt = await performArtifactOperation(transport, binding, journal, options);
const observer = { target: transport.target, capability: transport.capability, configurationSha256: transport.configurationSha256,
  async observe(value: ArtifactOperationBinding) { return { state: 'unknown' as const, fingerprint: value.fingerprint }; },
  async close() { return { status: 'closed' as const, activeRequests: 0 }; },
} satisfies ArtifactOperationObserver;
export const recovery: ArtifactOperationReceipt = await observeArtifactOperation(observer, binding, journal, options);
export const cli: ArtifactOperationTransport = await createCommandArtifactOperation(command);

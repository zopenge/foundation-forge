import type { ReleaseRecoveryObservation } from '../contracts.js';
import type { FileIdentity, MetadataFile } from './managed-state-contracts.js';
import type { RetirementHost } from './retirement-host.js';

export interface RetirementSnapshot {
  readonly state: string; readonly lock: string; readonly anchor: string; readonly owner: string;
  readonly check: string | null; readonly publish: string | null;
  readonly terminal?: { readonly text: string; readonly file: MetadataFile };
  readonly identities: Readonly<Record<'state' | 'lock' | 'anchor' | 'owner', FileIdentity>>;
}
export interface RetirementRecord {
  readonly schemaVersion: 1; readonly kind: 'interrupted-run-retirement';
  readonly runId: string; readonly slotId: string;
  readonly snapshot: RetirementSnapshot; readonly snapshotSha256: string;
  readonly origin: 'recorded-run-host';
  readonly host: RetirementHost; readonly preparedAt: string;
  readonly checksum: string;
  readonly final?: { readonly host: RetirementHost; readonly retiredAt: string; readonly observation: ReleaseRecoveryObservation;
    readonly cessation: 'recorded-empty-unstarted-scope' | 'recorded-stopped-scopes' | 'recorded-empty-drained-scope' };
}

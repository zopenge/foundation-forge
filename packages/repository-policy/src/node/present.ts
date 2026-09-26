import { policyDiagnostic } from '../diagnostics.js';
import type {
  PolicyBundle,
  PolicyDocument,
} from './contracts.js';

export type DeliveryMode = 'inline' | 'references';

export interface PresentedPolicyResult {
  readonly json: string;
  readonly exitCode: number;
}

const wireBytes = (json: string): number => (
  new TextEncoder().encode(`${json}\n`).byteLength
);

const baseExitCode = (
  bundle: PolicyBundle,
  delivery: DeliveryMode,
): number => {
  if (
    bundle.resolution.state === 'invalid'
    || bundle.resolution.state === 'conflict'
    || !bundle.deliveryComplete
  ) {
    return 1;
  }
  if (
    bundle.resolution.state === 'needs-context'
    || delivery === 'references'
  ) {
    return 2;
  }
  return 0;
};
const referenceDocument = (
  document: PolicyDocument,
): PolicyDocument => ({
  ...document,
  text: null,
});

const applyDelivery = (
  bundle: PolicyBundle,
  delivery: DeliveryMode,
): PolicyBundle => {
  if (delivery === 'inline') return bundle;
  return {
    ...bundle,
    documents: bundle.documents.map(referenceDocument),
    deliveryComplete: false,
  };
};

const budgetError = (
  bundle: PolicyBundle,
): Record<string, unknown> => ({
  schemaVersion: 1,
  resolutionState: bundle.resolution.state,
  deliveryComplete: false,
  bundleDigest: null,
  documents: [],
  diagnostics: [
    policyDiagnostic(
      'OUTPUT_BUDGET_EXCEEDED',
      'error',
      'output',
    ),
  ],
  nextAction: 'increase-approved-budget-or-read-sources',
});
export const presentPolicyBundle = (
  bundle: PolicyBundle,
  delivery: DeliveryMode,
  maxOutputBytes: number,
): PresentedPolicyResult => {
  const exitCode = baseExitCode(bundle, delivery);
  const delivered = applyDelivery(bundle, delivery);
  const json = JSON.stringify(delivered);

  if (wireBytes(json) <= maxOutputBytes) {
    return {
      json,
      exitCode,
    };
  }

  const fallback = JSON.stringify(budgetError(bundle));
  if (wireBytes(fallback) > maxOutputBytes) {
    throw new RangeError('output budget cannot fit minimum error response');
  }
  return {
    json: fallback,
    exitCode: exitCode === 1 ? 1 : 2,
  };
};

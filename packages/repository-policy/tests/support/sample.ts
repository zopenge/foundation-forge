import type { PolicyManifest, ResolveRequest } from '../../src/contracts.js';

export const sampleManifest = {
  schemaVersion: 1,
  factIds: ['api-impact'],
  policies: [
    {
      id: 'base',
      source: { path: 'rules/base.md' },
      when: { always: true },
      requires: [],
      conflictsWith: [],
      checkIds: [],
    },
    {
      id: 'api',
      source: { path: 'rules/api.md' },
      when: { anyOf: [{ facts: [{ id: 'api-impact', equals: true }] }] },
      requires: ['base'],
      conflictsWith: [],
      checkIds: [],
    },
  ],
  checks: [],
} satisfies PolicyManifest;

export const sampleRequest = {
  schemaVersion: 1,
  contextId: 'fixture-1',
  scope: { paths: [], complete: false },
  facts: [],
  evidence: [],
} satisfies ResolveRequest;

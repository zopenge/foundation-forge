import { calculateBytesIntegritySync } from '@openge/forge-artifact-integrity/node';
import { cloneJsonValue, stringifyDeterministicJson, type JsonValue } from '@openge/forge-deterministic-json';
import { Buffer } from 'node:buffer';

import type {
  PolicyCondition,
  PolicyManifest,
  ResolveRequest,
} from '../contracts.js';
import type { PolicyDocument } from './contracts.js';

export const compareIds = (
  left: string,
  right: string,
): number => (
  left < right ? -1 : left > right ? 1 : 0
);

const canonicalCondition = (
  condition: PolicyCondition,
): unknown => {
  if ('always' in condition) return { always: true };
  const anyOf = condition.anyOf.map((clause) => {
    const result: Record<string, unknown> = {};
    if (clause.path !== undefined) {
      result.path = {
        ...(clause.path.prefixes === undefined
          ? {}
          : { prefixes: [...clause.path.prefixes].sort(compareIds) }),
        ...(clause.path.extensions === undefined
          ? {}
          : { extensions: [...clause.path.extensions].sort(compareIds) }),
        ...(clause.path.roles === undefined
          ? {}
          : { roles: [...clause.path.roles].sort(compareIds) }),
      };
    }
    if (clause.facts !== undefined) {
      result.facts = [...clause.facts]
        .sort((left, right) => (
          compareIds(left.id, right.id)
          || Number(left.equals) - Number(right.equals)
        ))
        .map((fact) => ({
          id: fact.id,
          equals: fact.equals,
        }));
    }
    return result;
  });
  anyOf.sort((left, right) => compareIds(
    stringifyDeterministicJson(left),
    stringifyDeterministicJson(right),
  ));
  return { anyOf };
};

const canonicalManifest = (
  manifest: PolicyManifest,
): unknown => ({
  schemaVersion: 1,
  factIds: [...manifest.factIds].sort(compareIds),
  policies: [...manifest.policies]
    .sort((left, right) => compareIds(left.id, right.id))
    .map((policy) => ({
      id: policy.id,
      source: { path: policy.source.path },
      when: canonicalCondition(policy.when),
      requires: [...policy.requires].sort(compareIds),
      conflictsWith: [...policy.conflictsWith].sort(compareIds),
      checkIds: [...policy.checkIds].sort(compareIds),
    })),
  checks: [...manifest.checks]
    .sort((left, right) => compareIds(left.id, right.id))
    .map((check) => (
      check.kind === 'document'
        ? {
            id: check.id,
            kind: check.kind,
            source: { path: check.source.path },
          }
        : {
            id: check.id,
            kind: check.kind,
            packageJson: check.packageJson,
            script: check.script,
          }
    )),
});

const canonicalRequest = (
  request: ResolveRequest,
): unknown => ({
  contextId: request.contextId,
  evidence: [...request.evidence]
    .sort((left, right) => compareIds(left.id, right.id))
    .map((evidence) => ({
      contextId: evidence.contextId,
      digest: evidence.digest,
      id: evidence.id,
      sourceId: evidence.sourceId,
    })),
  facts: [...request.facts]
    .sort((left, right) => compareIds(left.id, right.id))
    .map((fact) => ({
      basis: fact.basis,
      contextId: fact.contextId,
      evidenceIds: [...fact.evidenceIds].sort(compareIds),
      id: fact.id,
      state: fact.state,
    })),
  schemaVersion: 1,
  scope: {
    complete: request.scope.complete,
    paths: [...request.scope.paths]
      .sort((left, right) => (
        compareIds(left.path, right.path)
        || compareIds(left.role, right.role)
      ))
      .map((item) => ({
        path: item.path,
        role: item.role,
      })),
  },
});

export const snapshotRequest = (
  request: unknown,
): { readonly value: JsonValue; readonly byteLength: number } | null => {
  try {
    const value = cloneJsonValue(request);
    // 只序列化已严格校验的私有副本；键顺序不影响 UTF-8 字节总数。
    return { value, byteLength: Buffer.byteLength(JSON.stringify(value), 'utf8') };
  } catch {
    return null;
  }
};

export const requestContextId = (request: unknown): string => {
  if (typeof request !== 'object' || request === null) return '';
  try {
    const descriptor = Object.getOwnPropertyDescriptor(request, 'contextId');
    return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value
      : '';
  } catch {
    return '';
  }
};

export const createBundleDigestCalculator = (
  manifest: PolicyManifest,
): ((request: ResolveRequest, documents: readonly PolicyDocument[]) => Promise<string>) => {
  const manifestJson = stringifyDeterministicJson(
    canonicalManifest(manifest),
  );
  return async (request, documents) => {
    // Node 入口已严格校验并复制 request；此处私有对象的每层键均按码元排序。
    // 保留边界校验，只省去对已知 JSON 标量和数组的再次校验与复制。
    const requestJson = JSON.stringify(canonicalRequest(request));
    const sourcesJson = JSON.stringify(
      [...documents]
        .sort((left, right) => (
          compareIds(left.source.path, right.source.path)
        ))
        .map((document) => ({
          path: document.source.path,
          sha256: document.sha256,
          utf8Bytes: document.utf8Bytes,
        })),
    );
    // 外层键按确定性 JSON 的顺序组合，保留原 v1 摘要的逐字节输入。
    const identityJson = '{"manifest":' + manifestJson
      + ',"request":' + requestJson
      + ',"schemaVersion":1,"sources":' + sourcesJson + '}';
    const bytes = new TextEncoder().encode(identityJson);
    return calculateBytesIntegritySync(bytes).sha256;
  };
};

export const calculateBundleDigest = (
  manifest: PolicyManifest,
  request: ResolveRequest,
  documents: readonly PolicyDocument[],
): Promise<string> => createBundleDigestCalculator(manifest)(request, documents);

import type { PrebuiltMarkerCandidate, ResolveCandidateMarkerAuth } from '../contracts.js';
import { assertActive, record, ReleaseError } from './errors.js';

export type CandidateMarkerHeaders = (candidate: PrebuiltMarkerCandidate, signal: AbortSignal) => Promise<Headers | undefined>;

const allowed = new Set(['x-vercel-trusted-oidc-idp-token', 'x-vercel-protection-bypass', 'cookie']);

async function resolveHeaders(resolve: ResolveCandidateMarkerAuth, candidate: PrebuiltMarkerCandidate, signal: AbortSignal) {
  let auth: unknown;
  try { auth = await resolve(Object.freeze({ ...candidate }), signal); }
  catch { assertActive(signal); throw new ReleaseError('AUTH_REQUIRED', { reason: 'CANDIDATE_MARKER_AUTH_FAILED' }); }
  assertActive(signal);
  if (auth === undefined) return;
  const value = record(auth);
  try { if (value.origin !== candidate.origin) throw new Error(); }
  catch { throw new ReleaseError('AUTH_REQUIRED', { reason: 'CANDIDATE_MARKER_ORIGIN' }); }
  try {
    const headers = new Headers(), entries = Object.entries(record(value.headers));
    if (!entries.length) throw new Error();
    for (const [name, credential] of entries) {
      if (!allowed.has(name) || typeof credential !== 'string' || !credential.trim()) throw new Error();
      headers.set(name, credential);
    }
    return headers;
  } catch { throw new ReleaseError('AUTH_REQUIRED', { reason: 'CANDIDATE_MARKER_HEADERS' }); }
}

/** 同一次调用对同一绑定复用解析结果；凭据只存在于当前调用的内存。 */
export function createCandidateMarkerHeaders(resolve: ResolveCandidateMarkerAuth): CandidateMarkerHeaders {
  const pending = new Map<string, Promise<Headers | undefined>>();
  return async (candidate, signal) => {
    assertActive(signal);
    const key = JSON.stringify([candidate.teamId, candidate.projectId, candidate.deploymentId, candidate.origin]);
    let result = pending.get(key);
    if (!result) {
      result = resolveHeaders(resolve, candidate, signal).catch((error: unknown) => { pending.delete(key); throw error; });
      pending.set(key, result);
    }
    const headers = await result;
    assertActive(signal);
    return headers;
  };
}

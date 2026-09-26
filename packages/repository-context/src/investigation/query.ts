import { tokenize } from '../core/tokenize.js';

export interface StructuralIntent {
  readonly decodeOrParse: boolean;
  readonly validation: boolean;
  readonly numeric: boolean;
  readonly wrapper: boolean;
}

const stopWords = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'must', 'across',
  'package', 'packages', 'implementation', 'contract',
]);

export const rawTokens = (value: string): readonly string[] => tokenize(value)
  .filter((token) => !stopWords.has(token));

export const queryTokens = (query: string): readonly string[] => {
  const instructionVerbs = new Set((query.match(/\b(?:find|locate|identify)\b/giu) ?? [])
    .map((token) => token.toLowerCase()));
  return [...new Set(rawTokens(query).filter((token) => !instructionVerbs.has(token)))];
};

export const queryAcronyms = (query: string): readonly string[] => [...new Set(
  (query.match(/\b[A-Z]{2,6}\b/gu) ?? []).map((value) => value.toLowerCase()),
)];

const normalizeQueryPath = (value: string): string => value
  .replace(/^[`'"({<\x5B]+/u, '')
  .replace(/[`'")\]}>,.;:!?]+$/u, '')
  .replaceAll('\\', '/')
  .replace(/\/{2,}/gu, '/')
  .replace(/^\.\//u, '')
  .replace(/\/+$/u, '');

export const queryPathScopes = (query: string, knownRoots: ReadonlySet<string>): readonly string[] => [...new Set(
  query.split(/\s+/u).flatMap((raw) => {
    const value = normalizeQueryPath(raw);
    if (!value.includes('/')
      || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
      || value.startsWith('/')
      || /^[A-Za-z]:\//u.test(value)
      || value.split('/').includes('..')) return [];
    const explicitRelative = /^[`'"({\x5B]*\.\//u.test(raw.replaceAll('\\', '/'));
    const filePath = /\.[\p{L}\p{N}]+$/u.test(value);
    return knownRoots.has(value.split('/')[0] ?? '') || explicitRelative || filePath ? [value] : [];
  }),
)];

export const queryFileNames = (query: string): readonly string[] => [...new Set(
  query.split(/\s+/u)
    .map(normalizeQueryPath)
    .filter((value) => !value.includes('/') && /\.[\p{L}\p{N}]+$/u.test(value)),
)];

export const affinityToken = (token: string): string => {
  if (['invalid', 'validate', 'validation', 'validator', 'valid'].includes(token)) return 'valid';
  if (['safe', 'safety'].includes(token)) return 'safe';
  if (['decode', 'decoder', 'decoded', 'decoding', 'decodes'].includes(token)) return 'decode';
  if (['encode', 'encoder', 'encoded', 'encoding', 'encodes'].includes(token)) return 'encode';
  if (['inspect', 'inspection', 'inspected', 'inspecting'].includes(token)) return 'inspect';
  if (['compare', 'comparison', 'comparisons', 'compared', 'comparing'].includes(token)) return 'compare';
  if (['normalize', 'normalizes', 'normalized', 'normalizing', 'normalization'].includes(token)) return 'normalize';
  if (['dedupe', 'deduplicate', 'deduplicates', 'deduplicated', 'deduplicating', 'deduplication'].includes(token)) return 'dedupe';
  if (['fail', 'failed', 'failure', 'failing', 'fails'].includes(token)) return 'fail';
  return token.endsWith('s') && token.length > 4 ? token.slice(0, -1) : token;
};

export const rawAffinityTokens = (value: string): readonly string[] => rawTokens(value).map(affinityToken);
export const normalizedAffinityTokens = (value: string): readonly string[] => [...new Set(rawAffinityTokens(value))];
export const containsSequence = (values: readonly string[], sequence: readonly string[]): boolean => sequence.length > 0
  && values.some((_, index) => sequence.every((token, offset) => values[index + offset] === token));

export const queryAnchorSequences = (query: string): readonly (readonly string[])[] => (
  query.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/gu) ?? []
).map((value) => rawAffinityTokens(value.replaceAll('_', ' '))).filter((sequence) => sequence.length >= 2);

export const structuralIntent = (tokens: readonly string[]): StructuralIntent => {
  const decodeOrParse = tokens.some((token) => [
    'decode', 'decoder', 'decoded', 'decoding', 'decodes', 'parse', 'parser', 'parsed', 'parsing',
  ].includes(token));
  const invalidOrMalformed = tokens.some((token) => ['invalid', 'malformed'].includes(token));
  return {
    decodeOrParse,
    validation: tokens.some((token) => ['validate', 'validation', 'reject'].includes(token))
      || (tokens.includes('invalid') && !decodeOrParse),
    numeric: tokens.some((token) => ['positive', 'zero', 'integer', 'bytes', 'byte', 'numeric', 'number'].includes(token)),
    wrapper: tokens.some((token) => [
      'wrapper', 'diagnostic', 'error', 'cause', 'exception', 'failure', 'failed',
    ].includes(token)) || (invalidOrMalformed && decodeOrParse),
  };
};

export const scopeNamespaceTokens = (scope: string): ReadonlySet<string> => {
  const name = scope.match(/^packages\/([^/]+)\/src\//u)?.[1] ?? '';
  return new Set(queryTokens(name).map(affinityToken));
};

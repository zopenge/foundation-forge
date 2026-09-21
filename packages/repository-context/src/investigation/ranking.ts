import type { Entity } from '../core/contracts.js';
import { affinityToken, containsSequence, normalizedAffinityTokens } from './query.js';

export interface SymbolMatch {
  readonly entity: Entity;
  readonly score: number;
}

export const bestSymbolMatch = (
  entities: readonly Entity[],
  path: string,
  tokens: readonly string[],
  allTokens: readonly string[] = tokens,
  namespace: ReadonlySet<string> = new Set(),
): SymbolMatch | null => {
  const query = [...new Set(tokens.map(affinityToken))];
  const full = allTokens.map(affinityToken);
  let best: SymbolMatch | null = null;
  for (const entity of entities) {
    if (entity.kind !== 'symbol' || entity.source.path !== path) continue;
    const nameTokens = normalizedAffinityTokens(entity.name);
    const signatureTokens = normalizedAffinityTokens(entity.signature ?? '');
    const nameOverlap = query.filter((token) => nameTokens.includes(token)).length;
    const signatureOnly = query.filter((token) => !nameTokens.includes(token) && signatureTokens.includes(token)).length;
    const discriminative = nameTokens.filter((token) => !namespace.has(token));
    const discriminativePhrase = discriminative.length >= 3 && containsSequence(full, discriminative)
      ? discriminative.length * 8 : 0;
    const exactPhrase = nameTokens.length >= 2 && containsSequence(full, nameTokens) ? nameTokens.length * 4 : 0;
    const phrase = Math.max(discriminativePhrase, exactPhrase);
    const signature = entity.signature ?? '';
    const executableBonus = /\bfunction\b|=>|=\s*(?:async\s*)?\(/u.test(signature) ? 12 : 0;
    const typePenalty = /^\s*export\s+(?:interface|type)\b/u.test(signature) ? 8 : 0;
    const score = nameOverlap * 20 + signatureOnly * 4 + phrase + executableBonus - typePenalty;
    if (score > (best?.score ?? 0)) best = { entity, score };
  }
  return best;
};

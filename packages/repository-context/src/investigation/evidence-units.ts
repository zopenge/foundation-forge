import type { Corpus, Entity, SourceRef } from '../core/contracts.js';
import type { ReadRangesResult } from './contracts.js';
import type { EvidenceUnit } from './evidence-contracts.js';

export interface BuildEvidenceUnitsOptions {
  readonly corpus: Corpus;
  readonly candidates: readonly Entity[];
  readonly readRanges: (ranges: readonly SourceRef[]) => Promise<ReadRangesResult>;
}

const sameSource = (left: SourceRef, right: SourceRef): boolean => left.corpusId === right.corpusId
  && left.generationId === right.generationId && left.path === right.path
  && left.sourceSha256 === right.sourceSha256 && left.snapshotId === right.snapshotId;

const contains = (outer: SourceRef, inner: SourceRef): boolean => outer.lineStart <= inner.lineStart
  && outer.lineEnd >= inner.lineEnd;

export const buildEvidenceUnits = async ({ corpus, candidates, readRanges }: BuildEvidenceUnitsOptions): Promise<readonly EvidenceUnit[]> => {
  const units: EvidenceUnit[] = [];
  for (const [rank, candidate] of candidates.entries()) {
    const enclosing = corpus.entities.filter((entity) => entity.kind === 'symbol'
      && entity.id !== candidate.id && sameSource(entity.source, candidate.source)
      && contains(entity.source, candidate.source)
      && (entity.source.lineStart < candidate.source.lineStart || entity.source.lineEnd > candidate.source.lineEnd))
      .sort((left, right) => (left.source.lineEnd - left.source.lineStart) - (right.source.lineEnd - right.source.lineStart))[0];
    const file = corpus.entities.find((entity) => entity.kind === 'file'
      && sameSource(entity.source, candidate.source) && contains(entity.source, candidate.source));
    const variants = [
      { kind: 'excerpt' as const, source: candidate.source },
      ...(enclosing ? [{ kind: 'enclosing-symbol' as const, source: enclosing.source }] : []),
      ...(file && file.source.lineEnd - file.source.lineStart + 1 <= 256
        ? [{ kind: 'file' as const, source: file.source }] : []),
    ];
    const unique = variants.filter((variant, index, all) => all.findIndex((item) => item.source.lineStart === variant.source.lineStart
      && item.source.lineEnd === variant.source.lineEnd) === index);
    const read = await readRanges(unique.map((item) => item.source));
    for (const [index, variant] of unique.entries()) {
      const item = read.texts[index];
      if (!item || !sameSource(item.source, variant.source)
        || item.lineStart !== variant.source.lineStart || item.lineEnd !== variant.source.lineEnd) continue;
      if (variant.kind === 'file' && new TextEncoder().encode(item.text).byteLength > 16_384) continue;
      units.push({
        id: `${candidate.id}:${variant.kind}:${variant.source.sourceSha256}:${variant.source.lineStart}-${variant.source.lineEnd}`,
        candidateId: candidate.id, rank, kind: variant.kind, priority: 'primary', source: variant.source, text: item.text,
      });
    }
  }
  return units;
};

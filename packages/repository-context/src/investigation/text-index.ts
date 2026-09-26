import { rankBm25Documents } from '../core/bm25.js';
import { tokenize } from '../core/tokenize.js';
import type { LoadedSource } from './windows.js';

export interface TextPosting {
  readonly path: string;
  readonly line: number;
}

export interface TextIndex {
  readonly documents: readonly Readonly<{ id: string; tokens: readonly string[] }>[];
  readonly postings: ReadonlyMap<string, readonly TextPosting[]>;
}

export const createTextIndex = (sources: readonly LoadedSource[]): TextIndex => {
  const postings = new Map<string, TextPosting[]>();
  const documents = sources.map((source) => {
    const tokens: string[] = [];
    for (const [index, line] of source.text.split('\n').entries()) {
      const lineTokens = tokenize(line);
      tokens.push(...lineTokens);
      for (const token of new Set(lineTokens)) {
        const values = postings.get(token) ?? [];
        values.push({ path: source.path, line: index + 1 });
        postings.set(token, values);
      }
    }
    return { id: source.path, tokens };
  });
  return { documents, postings };
};

export const rankTextIndex = (
  index: TextIndex,
  queryTokens: readonly string[],
  allowedPaths?: ReadonlySet<string>,
): readonly Readonly<{ path: string; score: number }>[] => rankBm25Documents(
  allowedPaths === undefined ? index.documents : index.documents.filter((document) => allowedPaths.has(document.id)),
  queryTokens,
).map((item) => ({ path: item.id, score: item.score }));

export const textPostings = (index: TextIndex, token: string): readonly TextPosting[] => index.postings.get(token) ?? [];
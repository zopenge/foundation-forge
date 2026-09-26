export interface Bm25Document {
  readonly id: string;
  readonly tokens: readonly string[];
}

export interface Bm25Options {
  readonly k1?: number;
  readonly b?: number;
}

export interface Bm25RankedDocument {
  readonly id: string;
  readonly score: number;
}

export const rankBm25Documents = (
  documents: readonly Bm25Document[],
  queryTokens: readonly string[],
  options: Bm25Options = {},
): readonly Bm25RankedDocument[] => {
  if (documents.length === 0 || queryTokens.length === 0) return [];
  const k1 = options.k1 ?? 1.2;
  const b = options.b ?? 0.75;
  const averageLength = documents.reduce((sum, document) => sum + document.tokens.length, 0) / documents.length;
  const query = [...new Set(queryTokens)];
  const documentFrequency = new Map(query.map((token) => [
    token, documents.filter((document) => document.tokens.includes(token)).length,
  ]));
  return documents.map((document) => {
    let score = 0;
    for (const token of query) {
      const tf = document.tokens.filter((value) => value === token).length;
      if (tf === 0) continue;
      const df = documentFrequency.get(token) ?? 0;
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      const lengthFactor = averageLength === 0 ? 1 : document.tokens.length / averageLength;
      const denominator = tf + k1 * (1 - b + b * lengthFactor);
      score += idf * (tf * (k1 + 1) / denominator);
    }
    return { id: document.id, score };
  }).filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
};
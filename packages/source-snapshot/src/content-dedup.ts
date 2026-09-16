import type { SourceTextFormatVersion, StagedSourceTextFile } from './content-contracts.js';
import { SOURCE_TEXT_NORMALIZATION } from './text-integrity.js';
import { compareStrings } from './validation.js';

export interface SourceTextContentBlock {
  readonly key: string;
  readonly file: StagedSourceTextFile;
  readonly aliasPaths: readonly string[];
}
export interface SourceTextContentDedupPlan {
  readonly blocks: readonly SourceTextContentBlock[];
  readonly blockKeyByPath: ReadonlyMap<string, string>;
  readonly logicalSourceBytes: number;
  readonly uniqueNormalizedBodyBytes: number;
}

const v2Key = (file: StagedSourceTextFile): string => [
  'source-text-v2', SOURCE_TEXT_NORMALIZATION, file.group,
  file.sha256, String(file.byteLength), file.normalizedSha256,
  String(file.normalizedByteLength),
].join(':');
export const planSourceTextContentDedup = (
  files: readonly StagedSourceTextFile[],
  formatVersion: SourceTextFormatVersion,
): SourceTextContentDedupPlan => {
  const ordered = [...files].sort((a, b) => compareStrings(a.path, b.path));
  const blockKeyByPath = new Map<string, string>();
  const grouped = new Map<string, StagedSourceTextFile[]>();
  for (const file of ordered) {
    const key = formatVersion === 2 ? v2Key(file) : `source-text-v1:${file.path}`;
    blockKeyByPath.set(file.path, key);
    const values = grouped.get(key) ?? [];
    values.push(file);
    grouped.set(key, values);
  }
  const blocks = [...grouped.entries()].map(([key, aliases]) => {
    const file = aliases[0];
    if (file === undefined) throw new Error('empty content block');
    return Object.freeze({
      key,
      file,
      aliasPaths: Object.freeze(aliases.map(value => value.path)),
    });
  }).sort((a, b) => compareStrings(a.file.group, b.file.group) || compareStrings(a.key, b.key));
  const logicalSourceBytes = ordered.reduce((sum, file) => sum + file.byteLength, 0);
  const uniqueNormalizedBodyBytes = blocks.reduce((sum, block) => sum + block.file.normalizedByteLength, 0);
  return Object.freeze({
    blocks: Object.freeze(blocks),
    blockKeyByPath,
    logicalSourceBytes,
    uniqueNormalizedBodyBytes,
  });
};

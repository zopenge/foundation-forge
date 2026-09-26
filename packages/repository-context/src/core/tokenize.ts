const hanOnly = /^\p{Script=Han}+$/u;

export const normalizeSearchText = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('en-US');

const splitIdentifierBoundaries = (value: string): string => value.normalize('NFKC')
  .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
  .replace(/([\p{Ll}\p{Nd}])(\p{Lu})/gu, '$1 $2');

const appendHanTokens = (target: string[], value: string): void => {
  target.push(value);
  const chars = [...value];
  target.push(...chars);
  for (let index = 0; index + 1 < chars.length; index += 1) {
    target.push(`${chars[index] ?? ''}${chars[index + 1] ?? ''}`);
  }
};

export const tokenize = (value: string): readonly string[] => {
  const tokens: string[] = [];
  const segments = splitIdentifierBoundaries(value).match(/\p{Script=Han}+|[\p{L}\p{N}]+/gu) ?? [];
  for (const segment of segments) {
    if (hanOnly.test(segment)) appendHanTokens(tokens, segment);
    else tokens.push(normalizeSearchText(segment));
  }
  return [...new Set(tokens.filter((token) => token.length > 0))];
};
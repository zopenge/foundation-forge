import { calculateBytesIntegrity } from '@openge/forge-artifact-integrity';

export const SOURCE_TEXT_NORMALIZATION = 'decoded-lf-utf8-v1' as const;

const encoder = new TextEncoder();

export const normalizeDecodedSourceText = (text: string): string => text.replace(/\r\n?/gu, '\n');

export const calculateNormalizedTextIntegrity = async (text: string): Promise<{
  readonly normalizedSha256: string;
  readonly normalizedByteLength: number;
  readonly finalNewline: boolean;
}> => {
  const integrity = await calculateBytesIntegrity(encoder.encode(text));
  return Object.freeze({
    normalizedSha256: integrity.sha256,
    normalizedByteLength: integrity.byteLength,
    finalNewline: text.endsWith('\n'),
  });
};

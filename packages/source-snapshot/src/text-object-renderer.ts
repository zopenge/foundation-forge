import type { DecodedSourceText } from './content-contracts.js';

interface SourceTextObjectSectionBase {
  readonly group: string;
  readonly sourceSha256: string;
  readonly sourceByteLength: number;
  readonly encoding: DecodedSourceText['encoding'];
  readonly bom: DecodedSourceText['bom'];
  readonly startLine: number;
  readonly endLine: number;
  readonly segmentIndex: number;
  readonly segmentCount: number;
  readonly text: string;
}
export interface SourceTextObjectPathSectionInput extends SourceTextObjectSectionBase {
  readonly formatVersion: 1;
  readonly path: string;
}
export interface SourceTextContentBlockSectionInput extends SourceTextObjectSectionBase {
  readonly formatVersion: 2;
  readonly normalization: 'decoded-lf-utf8-v1';
  readonly normalizedSha256: string;
  readonly normalizedByteLength: number;
}
export type SourceTextObjectSectionInput = SourceTextObjectPathSectionInput | SourceTextContentBlockSectionInput;
export interface SourceTextObjectSectionLocation {
  readonly bodyByteOffset: number;
  readonly bodyByteLength: number;
}
export interface RenderedSourceTextObject {
  readonly content: string;
  readonly locations: readonly SourceTextObjectSectionLocation[];
}

const encoder = new TextEncoder();
const byteLength = (value: string): number => encoder.encode(value).byteLength;
const fenceFor = (text: string): string => {
  let max = 0;
  for (const match of text.matchAll(/`+/gu)) max = Math.max(max, match[0].length);
  return '`'.repeat(Math.max(3, max + 1));
};
const sectionMetadata = (segment: SourceTextObjectSectionInput): readonly string[] => {
  if (segment.formatVersion === 1) {
    return [
      `## ${segment.path}`,
      '',
      `- Group: ${segment.group}`,
      `- Source SHA-256: ${segment.sourceSha256}`,
      `- Source bytes: ${segment.sourceByteLength}`,
    ];
  }
  return [
    `## Content ${segment.sourceSha256}`,
    '',
    '- Format: source-text-v2',
    `- Group: ${segment.group}`,
    `- Source SHA-256: ${segment.sourceSha256}`,
    `- Source bytes: ${segment.sourceByteLength}`,
    `- Normalization: ${segment.normalization}`,
    `- Normalized SHA-256: ${segment.normalizedSha256}`,
    `- Normalized bytes: ${segment.normalizedByteLength}`,
  ];
};
const renderSection = (segment: SourceTextObjectSectionInput): { content: string; bodyOffset: number; bodyLength: number } => {
  const fence = fenceFor(segment.text);
  const prefix = [
    ...sectionMetadata(segment),
    `- Encoding: ${segment.encoding}${segment.bom === null ? '' : `; BOM=${segment.bom}`}`,
    `- Line range: ${segment.startLine}-${segment.endLine}`,
    `- Segment: ${segment.segmentIndex}/${segment.segmentCount}`,
    '',
    `${fence}text`,
    '',
  ].join('\n');
  const body = segment.text;
  const closingSeparator = body.endsWith('\n') || body.length === 0 ? '' : '\n';
  return {
    content: `${prefix}${body}${closingSeparator}${fence}\n`,
    bodyOffset: byteLength(prefix),
    bodyLength: byteLength(body),
  };
};

export const renderSourceTextObject = (
  group: string,
  segments: readonly SourceTextObjectSectionInput[],
): RenderedSourceTextObject => {
  const header = ['# Source Snapshot Object', '', `Group: ${group}`, ''].join('\n');
  let content = `${header}\n`;
  let currentBytes = byteLength(content);
  const locations: SourceTextObjectSectionLocation[] = [];
  segments.forEach((segment, index) => {
    const rendered = renderSection(segment);
    locations.push(Object.freeze({
      bodyByteOffset: currentBytes + rendered.bodyOffset,
      bodyByteLength: rendered.bodyLength,
    }));
    content += rendered.content;
    if (index < segments.length - 1) content += '\n';
    currentBytes = byteLength(content);
  });

  return Object.freeze({ content, locations: Object.freeze(locations) });
};
